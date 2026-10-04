import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
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
import { createInboxFiles, type InboxFiles } from './directory-inbox-files';
import { cleanupInboxEntry, inboxStateAccess } from './directory-inbox-state';
import { createFileStateStore } from './file-state-store';
import { defineManagedResource } from './resource';

function resolveLimits<TEntry>(config: DirectoryInboxConfig<TEntry>) {
  const integer = z.int();
  return {
    pollIntervalMs: integer
      .min(10)
      .max(2_147_483_647)
      .parse(config.pollIntervalMs ?? 1_000),
    leaseMs: integer
      .min(100)
      .max(2_147_483_647)
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

/** One file-backed intake engine for atomically dropped and programmatically accepted entries. */
export function createDirectoryInbox<TEntry>(
  config: DirectoryInboxConfig<TEntry>,
): DirectoryInboxResource<TEntry> {
  const limits = resolveLimits(config);
  const clock = config.clock ?? (() => new Date());
  const access = inboxStateAccess(
    config.store ??
      createFileStateStore(join(config.directory, '.inbox-state.json'), {
        schema: DirectoryInboxStateSchema,
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
      const step = await access.update((state) => {
        const next = claimEntry(state, { key, now: clock(), ...limits });
        return { state: next.state, result: next.step };
      });
      if (step.kind === 'deliver') {
        if (await deliver(step.claim)) handled += 1;
      } else if (step.kind === 'reject') {
        await cleanupInboxEntry(access, currentFiles, key, step.rejection);
        await config.onRejected?.(step.rejection);
      } else if (step.kind === 'remove' || step.kind === 'set-aside') {
        await access.update(async (state, context) => {
          if (state.claims.some((claim) => claim.key === key))
            return { state, result: undefined };
          const terminal =
            step.kind === 'remove'
              ? state.receipts.some((receipt) => receipt.key === key)
              : state.rejected.some((rejection) => rejection.key === key);
          if (terminal) {
            await context.assertHeld();
            if (step.kind === 'remove') await currentFiles.remove(key, context);
            else await currentFiles.setAside(key, context);
          }
          return { state, result: undefined };
        });
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
  const inbox: DirectoryInbox<TEntry> = {
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
