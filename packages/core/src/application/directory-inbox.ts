import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { backoffDelay } from '../internal/backoff';
import {
  claimEntry,
  completeEntry,
  type DirectoryInbox,
  type DirectoryInboxClaim,
  type DirectoryInboxConfig,
  type DirectoryInboxRejection,
  type DirectoryInboxResource,
  type DirectoryInboxState,
  DirectoryInboxStateSchema,
  emptyDirectoryInboxState,
  forgetMissing,
  releaseEntry,
  withRejection,
} from './directory-inbox-contract';
import { createFileStateStore } from './file-state-store';
import { defineManagedResource } from './resource';

const REJECTED = 'rejected';
const ENTRY_NAME = /^[^.].*\.json$/;
/** One second doubling to five minutes: a handler waiting on its own upstream. */
const RETRY_BACKOFF = { minDelayMs: 1_000, maxDelayMs: 300_000, jitter: 0 } as const;

const absent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function quietly(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

function resolveLimits<TEntry>(config: DirectoryInboxConfig<TEntry>) {
  const integer = z.number().int();
  return {
    pollIntervalMs: integer.min(10).parse(config.pollIntervalMs ?? 1_000),
    leaseMs: integer.min(100).parse(config.leaseMs ?? 300_000),
    maxAttempts: integer
      .min(1)
      .max(10_000)
      .parse(config.maxAttempts ?? 20),
    maxEntryBytes: integer.min(1).parse(config.maxEntryBytes ?? 1024 * 1024),
    retain: integer
      .min(1)
      .max(100_000)
      .parse(config.retain ?? 1_000),
  };
}

async function entryNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && ENTRY_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Read and validate one entry; a reason when it must be set aside instead. */
async function readEntry<TEntry>(
  path: string,
  schema: z.ZodType<TEntry>,
  maxEntryBytes: number,
): Promise<{ entry: TEntry } | { reason: 'invalid' | 'too-large'; detail: string } | null> {
  try {
    const { size } = await stat(path);
    if (size > maxEntryBytes) {
      return { reason: 'too-large', detail: `${size} bytes over the ${maxEntryBytes} limit` };
    }
    const text = await readFile(path, 'utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return { reason: 'invalid', detail: String(error).slice(0, 1_000) };
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { entry: parsed.data }
      : { reason: 'invalid', detail: z.prettifyError(parsed.error).slice(0, 1_000) };
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

export function createDirectoryInbox<TEntry>(
  config: DirectoryInboxConfig<TEntry>,
): DirectoryInboxResource {
  const limits = resolveLimits(config);
  const clock = config.clock ?? (() => new Date());
  const store =
    config.store ??
    createFileStateStore(join(config.directory, '.inbox-state.json'), {
      schema: DirectoryInboxStateSchema,
    });
  const parse = (state: DirectoryInboxState | null) =>
    DirectoryInboxStateSchema.parse(state ?? emptyDirectoryInboxState());
  const update = <TResult>(
    transition: (state: DirectoryInboxState) => {
      state: DirectoryInboxState;
      result: TResult;
    },
  ) => store.update((current) => transition(parse(current)));

  let running = false;
  let admitting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forced = new AbortController();
  let tail: Promise<unknown> = Promise.resolve();

  const report = async (error: unknown): Promise<void> => {
    try {
      await config.onError?.(error);
    } catch {
      // The loop outlives its observer.
    }
  };

  const setAside = async (key: string, rejection?: DirectoryInboxRejection) => {
    await mkdir(join(config.directory, REJECTED), { recursive: true });
    await quietly(() =>
      rename(join(config.directory, key), join(config.directory, REJECTED, key)),
    );
    if (rejection) await config.onRejected?.(rejection);
  };

  const reject = async (key: string, reason: 'invalid' | 'too-large', detail: string) => {
    const rejection = { key, reason, detail, rejectedAt: clock().toISOString() };
    await update((state) => ({
      state: withRejection(state, rejection, limits.retain),
      result: undefined,
    }));
    await setAside(key, rejection);
  };

  const deliver = async (claim: DirectoryInboxClaim): Promise<boolean> => {
    const path = join(config.directory, claim.key);
    const read = await readEntry(path, config.schema, limits.maxEntryBytes);
    if (read === null) return false;
    if ('reason' in read) {
      await reject(claim.key, read.reason, read.detail);
      return false;
    }
    try {
      await config.handle({
        key: claim.key,
        entry: read.entry,
        attempt: claim.attempts,
        signal: forced.signal,
      });
    } catch (error) {
      await report(error);
      const retryAt = new Date(
        clock().getTime() + backoffDelay(RETRY_BACKOFF, claim.attempts),
      );
      await update((state) => ({
        state: releaseEntry(state, claim, retryAt),
        result: undefined,
      }));
      return false;
    }
    await update((state) => ({
      state: completeEntry(state, claim.key, clock(), limits.retain),
      result: undefined,
    }));
    await quietly(() => unlink(path));
    return true;
  };

  const pass = async (): Promise<number> => {
    const names = await entryNames(config.directory);
    await update((state) => ({
      state: forgetMissing(state, new Set(names), clock()),
      result: undefined,
    }));
    let handled = 0;
    for (const key of names) {
      if (!admitting && running) break;
      const { step } = await update((state) => {
        const next = claimEntry(state, { key, now: clock(), ...limits });
        return { state: next.state, result: next };
      });
      if (step.kind === 'remove') await quietly(() => unlink(join(config.directory, key)));
      else if (step.kind === 'set-aside') await setAside(key);
      else if (step.kind === 'reject') await setAside(key, step.rejection);
      else if (step.kind === 'deliver' && (await deliver(step.claim))) handled += 1;
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
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const inbox: DirectoryInbox = {
    flush,
    async state() {
      return parse(await store.read());
    },
  };

  return defineManagedResource({
    id: config.id,
    ...(config.dependsOn && { dependsOn: config.dependsOn }),
    async start() {
      await mkdir(config.directory, { recursive: true });
      forced = new AbortController();
      return { value: inbox };
    },
    // Entries are the application's work: none is handed over before it is ready.
    activate() {
      running = true;
      admitting = true;
      void poll();
    },
    stopAdmission() {
      stopAdmitting();
    },
    async drain() {
      await tail;
    },
    async close() {
      stopAdmitting();
      await tail;
    },
    async force() {
      stopAdmitting();
      forced.abort();
      await tail;
    },
  });
}
