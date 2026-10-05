import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';
import { createInboxAccept } from './directory-inbox-accept';
import {
  claimEntry,
  type DirectoryInbox,
  type DirectoryInboxConfig,
  type DirectoryInboxResource,
  DirectoryInboxStateSchema,
  forgetMissing,
} from './directory-inbox-contract';
import { createInboxDelivery } from './directory-inbox-delivery';
import { createInboxFiles, InboxEntryError, type InboxFiles } from './directory-inbox-files';
import { cleanupInboxEntry, inboxStateAccess } from './directory-inbox-state';
import { createFileStateStore } from './file-state-store';
import { defineManagedResource } from './resource';

function resolveLimits<TEntry, TInput>(config: DirectoryInboxConfig<TEntry, TInput>) {
  const integer = z.int();
  return {
    pollIntervalMs: integer
      .min(10)
      .max(MAX_TIMER_MS)
      .parse(config.pollIntervalMs ?? 1_000),
    leaseMs: integer
      .min(100)
      .max(MAX_TIMER_MS)
      .parse(config.leaseMs ?? 300_000),
    maxAttempts: integer
      .min(1)
      .max(10_000)
      .parse(config.maxAttempts ?? 20),
    maxEntryBytes: integer.min(1).parse(config.maxEntryBytes ?? 1024 * 1024),
    maxPendingEntries: integer
      .min(1)
      .max(100_000)
      .parse(config.maxPendingEntries ?? 1_000),
    retain: integer
      .min(1)
      .max(100_000)
      .parse(config.retain ?? 1_000),
  };
}

/** Worst-case encoded size of one state record: a long identity and detail, escaped. */
const STATE_RECORD_BYTES = 16 * 1024;
const MIN_STATE_BYTES = 64 * 1024 * 1024;

/** The largest state file the default store reads: every retained record plus the entries awaiting acceptance. */
function stateByteCap(limits: { retain: number; maxPendingEntries: number }): number {
  return Math.max(
    MIN_STATE_BYTES,
    (2 * limits.retain + limits.maxPendingEntries) * STATE_RECORD_BYTES,
  );
}

/** One file-backed intake engine for atomically dropped and programmatically accepted entries. */
export function createDirectoryInbox<TEntry, TInput = TEntry>(
  config: DirectoryInboxConfig<TEntry, TInput>,
): DirectoryInboxResource<TInput> {
  const limits = resolveLimits(config);
  const clock = config.clock ?? (() => new Date());
  const access = inboxStateAccess(
    config.store ??
      createFileStateStore(join(config.directory, '.inbox-state.json'), {
        schema: DirectoryInboxStateSchema,
        maxBytes: stateByteCap(limits),
      }),
  );
  let files: InboxFiles | undefined;
  const filesFor = (): InboxFiles => {
    if (!files) throw new Error('Directory inbox has not started');
    return files;
  };
  let running = false;
  let admitting = false;
  let accepting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forced = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();
  const pendingAccepts = new Set<Promise<unknown>>();
  const report = async (error: unknown): Promise<void> => {
    try {
      await config.onError?.(error);
    } catch {
      /* Observers cannot stop intake. */
    }
  };
  const deliver = createInboxDelivery({
    config,
    access,
    files: filesFor,
    clock,
    forced: () => forced.signal,
    leaseMs: limits.leaseMs,
    retain: limits.retain,
    report,
  });

  /** Take one directory entry through its next step; true when the application handled it. */
  const step = async (currentFiles: InboxFiles, key: string): Promise<boolean> => {
    const next = await access.update((state) => {
      const claimed = claimEntry(state, { key, now: clock(), ...limits });
      return { state: claimed.state, result: claimed.step };
    });
    if (next.kind === 'deliver') return deliver(next.claim);
    if (next.kind === 'reject') {
      await cleanupInboxEntry(access, currentFiles, key, next.rejection);
      await config.onRejected?.(next.rejection);
    } else if (next.kind === 'remove' || next.kind === 'set-aside') {
      await access.update(async (state, context) => {
        if (state.claims.some((claim) => claim.key === key))
          return { state, result: undefined };
        const terminal =
          next.kind === 'remove'
            ? state.receipts.some((receipt) => receipt.key === key)
            : state.rejected.some((rejection) => rejection.key === key);
        if (terminal) {
          await context.assertHeld();
          if (next.kind === 'remove') await currentFiles.remove(key, context);
          else await currentFiles.setAside(key, context);
        }
        return { state, result: undefined };
      });
    }
    return false;
  };

  const pass = async (): Promise<number> => {
    if (!accepting || forced.signal.aborted) return 0;
    const currentFiles = filesFor();
    const names = await currentFiles.names();
    await access.update((state) => ({
      state: forgetMissing(state, new Set(names), clock()),
      result: undefined,
    }));
    let handled = 0;
    for (const key of names) {
      if (!accepting || forced.signal.aborted || (running && !admitting)) break;
      try {
        if (await step(currentFiles, key)) handled += 1;
      } catch (error) {
        // The file of one entry cannot stop the others. A failure of the state
        // store or the directory fails every entry alike and ends the pass.
        if (!(error instanceof InboxEntryError) || forced.signal.aborted) throw error;
        await report(error.cause);
      }
    }
    return handled;
  };

  const flush = (): Promise<number> => {
    const result = tail.then(pass, pass);
    tail = result.catch(() => undefined);
    return result;
  };
  const poll = async (): Promise<void> => {
    try {
      await flush();
    } catch (error) {
      await report(error);
    }
    if (admitting) timer = setTimeout(() => void poll(), limits.pollIntervalMs);
  };
  const stopAdmitting = (): void => {
    admitting = false;
    accepting = false;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const accept = createInboxAccept({
    access,
    files: filesFor,
    accepting: () => accepting,
    schema: config.schema,
    maxEntryBytes: limits.maxEntryBytes,
    maxPendingEntries: limits.maxPendingEntries,
  });
  const drained = async (): Promise<void> => {
    await Promise.allSettled([...pendingAccepts]);
    await tail;
  };
  const inbox: DirectoryInbox<TInput> = {
    accept(input) {
      const result = accept(input);
      pendingAccepts.add(result);
      void result.then(
        () => pendingAccepts.delete(result),
        () => pendingAccepts.delete(result),
      );
      return result;
    },
    flush,
    state: access.read,
  };
  return defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    async start() {
      await mkdir(config.directory, { recursive: true });
      files = await createInboxFiles(config.directory, limits.maxEntryBytes);
      forced = new AbortController();
      running = false;
      accepting = true;
      return { value: inbox };
    },
    activate() {
      running = true;
      admitting = true;
      void poll();
    },
    stopAdmission: stopAdmitting,
    drain: drained,
    async close() {
      stopAdmitting();
      await drained();
    },
    async force() {
      stopAdmitting();
      forced.abort(new Error('Directory inbox was forced down'));
      await drained();
    },
  });
}
