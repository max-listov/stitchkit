import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { z } from 'zod';
import type { StateStore, StateStoreUpdate } from '../application/state-store';
import { isRecord } from '../internal/typed';

export interface FileStateStoreCorruption {
  readonly path: string;
  readonly error: unknown;
}

export interface FileStateStoreOptions<TState> {
  readonly schema: z.ZodType<TState>;
  /** `throw` is the safe default. `empty` is appropriate for reconstructable ledgers. */
  readonly corrupt?: 'throw' | 'empty';
  readonly onCorrupt?: (failure: FileStateStoreCorruption) => void | Promise<void>;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  readonly retryMs?: number;
}

/** A lock whose heartbeat is this many stale bounds old is abandoned whatever its pid says. */
const ABANDONED_LOCK_MULTIPLIER = 10;
/**
 * …and never fewer than this many missed heartbeats. The heartbeat interval
 * is floored at 10 ms, so with a tiny stale bound the stale multiple alone
 * would sit below a couple of missed beats — one scheduler stall on a loaded
 * host, and a live holder's lock was reclaimed under it.
 */
const ABANDONED_HEARTBEATS = 30;
const MIN_HEARTBEAT_MS = 10;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function missing(error: unknown): Promise<boolean> {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function existing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/**
 * `'gone'` when the recorded pid no longer exists, `'alive'` when it does,
 * `'unknown'` when the lock names no usable pid or the probe is refused
 * (`EPERM`: another user's process, which may or may not be the holder).
 */
async function ownerState(lockPath: string): Promise<'gone' | 'alive' | 'unknown'> {
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return 'unknown';
  }
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('pid' in owner) ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    return 'unknown';
  }
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? 'gone'
      : 'unknown';
  }
}

/**
 * Temporary files a crashed writer left beside the state (`<name>.tmp.<pid>.<uuid>`)
 * are removed once per store, when older than the stale bound — a live write
 * never holds one that long.
 */
async function sweepTemporaries(path: string, staleLockMs: number): Promise<void> {
  const prefix = `${basename(path)}.tmp.`;
  const directory = dirname(path);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = join(directory, entry);
    const info = await stat(candidate).catch(() => null);
    if (info && Date.now() - info.mtimeMs > staleLockMs) {
      await unlink(candidate).catch(() => undefined);
    }
  }
}

/**
 * Elect one stale-lock reclaimer, then prove that the observed generation is
 * unchanged and its recorded process is gone. The fixed guard prevents two
 * contenders from deleting one another's newly-created lock.
 */
async function reclaim(
  lockPath: string,
  observed: NonNullable<Awaited<ReturnType<typeof stat>>>,
  staleLockMs: number,
  abandonedAfterMs: number,
): Promise<boolean> {
  const guardPath = `${lockPath}.reclaim`;
  let guard: Awaited<ReturnType<typeof open>>;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (!existing(error)) throw error;
    // A reclaimer killed between creating and removing its guard would
    // otherwise disable reclaim for good; a guard older than the stale bound
    // belongs to no live reclaim (one lasts milliseconds) and is cleared for
    // the next contender.
    const orphan = await stat(guardPath).catch(() => null);
    if (orphan && Date.now() - orphan.mtimeMs > staleLockMs) {
      await unlink(guardPath).catch(() => undefined);
    }
    return false;
  }
  try {
    const current = await stat(lockPath).catch(() => null);
    if (
      !current ||
      current.dev !== observed.dev ||
      current.ino !== observed.ino ||
      current.mtimeMs !== observed.mtimeMs
    ) {
      return false;
    }
    // A dead owner is reclaimed as soon as its heartbeat is stale. A live or
    // unverifiable owner keeps the lock a while longer — a process may block
    // its event loop past one heartbeat and still be about to write — but not
    // for ever: a pid can be reused and a foreign pid cannot be probed, and
    // the heartbeat is the liveness signal the lock actually carries.
    const owner = await ownerState(lockPath);
    const age = Date.now() - current.mtimeMs;
    if (owner !== 'gone' && age < abandonedAfterMs) return false;
    await unlink(lockPath);
    return true;
  } finally {
    await guard.close().catch(() => undefined);
    await unlink(guardPath).catch(() => undefined);
  }
}

/**
 * A versioned JSON state store with one cross-process atomic update boundary.
 *
 * The lock is an exclusive file, not an in-memory mutex. Writes use a unique
 * temporary file in the destination directory followed by an atomic rename.
 */
export function createFileStateStore<TState>(
  path: string,
  options: FileStateStoreOptions<TState>,
): StateStore<TState> {
  const lockPath = `${path}.lock`;
  // The stale bound sits inside the acquire timeout on purpose: a contender
  // must outlive a crashed holder's heartbeat, or every update fails until the
  // lock ages out. The heartbeat refreshes every third of the bound.
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleLockMs = options.staleLockMs ?? 3_000;
  const retryMs = options.retryMs ?? 10;
  const heartbeatMs = Math.max(MIN_HEARTBEAT_MS, Math.floor(staleLockMs / 3));
  const abandonedAfterMs = Math.max(
    staleLockMs * ABANDONED_LOCK_MULTIPLIER,
    heartbeatMs * ABANDONED_HEARTBEATS,
  );
  if (staleLockMs >= lockTimeoutMs) {
    throw new Error(
      `[stitchkit] createFileStateStore: staleLockMs (${staleLockMs}) must be below lockTimeoutMs (${lockTimeoutMs}), or a crashed holder blocks every update until the timeout`,
    );
  }
  let sweptTemporaries = false;

  const parseFile = async (): Promise<TState | null> => {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if (await missing(error)) return null;
      throw error;
    }
    try {
      return options.schema.parse(JSON.parse(source));
    } catch (error) {
      await options.onCorrupt?.({ path, error });
      if ((options.corrupt ?? 'throw') === 'empty') return null;
      throw error;
    }
  };

  const acquire = async (): Promise<{
    readonly release: () => Promise<void>;
    readonly refresh: () => Promise<void>;
  }> => {
    await mkdir(dirname(path), { recursive: true });
    if (!sweptTemporaries) {
      sweptTemporaries = true;
      await sweepTemporaries(path, staleLockMs);
    }
    const deadline = Date.now() + lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(lockPath, 'wx');
        const token = crypto.randomUUID();
        try {
          await handle.writeFile(
            JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }),
          );
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
        return {
          refresh: async () => {
            const now = new Date();
            await handle.utimes(now, now);
          },
          release: async () => {
            await handle.close();
            try {
              const owner: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
              if (isRecord(owner) && owner.token === token) await unlink(lockPath);
            } catch (error) {
              if (!(await missing(error))) throw error;
            }
          },
        };
      } catch (error) {
        if (!existing(error)) throw error;
        try {
          const lock = await stat(lockPath);
          if (Date.now() - lock.mtimeMs > staleLockMs) {
            if (await reclaim(lockPath, lock, staleLockMs, abandonedAfterMs)) continue;
          }
        } catch (statError) {
          if (await missing(statError)) continue;
          throw statError;
        }
        if (Date.now() >= deadline) {
          throw new Error(`[stitchkit] timed out acquiring state lock for ${path}`);
        }
        await delay(retryMs);
      }
    }
  };

  const write = async (state: TState): Promise<void> => {
    const validated = options.schema.parse(state);
    const temporary = `${path}.tmp.${process.pid}.${crypto.randomUUID()}`;
    const handle = await open(temporary, 'wx');
    try {
      try {
        await handle.writeFile(`${JSON.stringify(validated)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };

  return {
    read: parseFile,
    async update<TResult>(
      transition: (
        current: TState | null,
      ) => StateStoreUpdate<TState, TResult> | Promise<StateStoreUpdate<TState, TResult>>,
    ): Promise<TResult> {
      const lock = await acquire();
      const heartbeat = setInterval(
        () => void lock.refresh().catch(() => undefined),
        heartbeatMs,
      );
      try {
        const next = await transition(await parseFile());
        await write(next.state);
        return next.result;
      } finally {
        clearInterval(heartbeat);
        await lock.release();
      }
    },
  };
}
