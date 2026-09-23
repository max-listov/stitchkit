/**
 * Run work under an exclusive lock between processes, waiting for it within a
 * deadline and a cancellation signal.
 *
 * The waiting is what the journal never needed and every other caller does: a
 * registry, a cursor or a mailbox is held for milliseconds, so a second process
 * should wait its turn rather than fail. It waits within a bound, stops the
 * moment its signal aborts — during the wait, not after it — and a refusal names
 * the resource and whoever holds it, so "timed out" is never the whole message.
 */
import { attemptExclusiveLock, type ExclusiveLockOwner } from './exclusive-lock';

export type { ExclusiveLockOwner } from './exclusive-lock';

/** Options of {@link withExclusiveLock}. */
export interface ExclusiveLockOptions {
  /** What the lock guards, named in a refusal. Defaults to the lock path. */
  label?: string;
  /** How long to wait for a held lock, in milliseconds; `0` makes one attempt. Default 10 000. */
  timeoutMs?: number;
  /** Stops the wait; an abort while waiting rejects at once with its reason as the cause. */
  signal?: AbortSignal;
  /** Permission bits of the lock file. Default `0o600`. */
  mode?: number;
  /**
   * This machine's identity, for a platform that offers none (`/etc/machine-id`
   * on Linux and `IOPlatformUUID` on macOS are read otherwise). A dead owner is
   * reclaimed only when it is provably on this machine.
   */
  machineIdentity?: string;
  /**
   * How old a lock with no readable owner must be before it is taken — the one
   * case where time decides, left by a process that died between creating the
   * file and recording itself. Default 5 000.
   */
  ownerlessGraceMs?: number;
}

/** The lock `run` executes under. */
export interface ExclusiveLock {
  readonly path: string;
  readonly owner: ExclusiveLockOwner;
  /** Taken from an owner that was provably gone, or that never recorded itself. */
  readonly reclaimed: boolean;
}

/** A lock that was not taken: the wait ran out, or was cancelled. */
export class ExclusiveLockError extends Error {
  override name = 'ExclusiveLockError';
  constructor(
    readonly code: 'LOCK_TIMEOUT' | 'LOCK_ABORTED',
    readonly label: string,
    /** Who held it at the last attempt; `null` when the lock recorded no readable owner. */
    readonly holder: ExclusiveLockOwner | null,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OWNERLESS_GRACE_MS = 5_000;
const FIRST_RETRY_MS = 10;
const MAX_RETRY_MS = 100;

function nonNegative(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`[stitchkit] withExclusiveLock: ${name} must be a finite number ≥ 0`);
  }
  return value;
}

function describeHolder(holder: ExclusiveLockOwner | null): string {
  if (!holder) return 'a holder that recorded no owner';
  const machine = holder.machine === undefined ? '' : `, machine ${holder.machine}`;
  return `pid ${holder.pid} on ${holder.host}${machine} since ${holder.acquiredAt}`;
}

/** Sleep until `ms` passes or `signal` aborts, whichever is first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Run `run` while holding the exclusive lock at `path`, and release it on every
 * outcome.
 *
 * The lock is a file created exclusively and recording its owner (pid, host,
 * machine identity, time). A held lock is waited for up to `timeoutMs`; one
 * whose owner is provably dead on this machine is taken over, and one held by a
 * live or unprovable owner — another machine, a slow process — never is, by age
 * or otherwise.
 */
export async function withExclusiveLock<T>(
  path: string,
  run: (lock: ExclusiveLock) => T | Promise<T>,
  options: ExclusiveLockOptions = {},
): Promise<T> {
  const label = options.label ?? path;
  const timeoutMs = nonNegative('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const ownerlessGraceMs = nonNegative(
    'ownerlessGraceMs',
    options.ownerlessGraceMs,
    DEFAULT_OWNERLESS_GRACE_MS,
  );
  const { signal } = options;
  const deadline = performance.now() + timeoutMs;
  let delay = FIRST_RETRY_MS;
  for (;;) {
    if (signal?.aborted) {
      throw new ExclusiveLockError(
        'LOCK_ABORTED',
        label,
        null,
        `[stitchkit] waiting for the lock on "${label}" was cancelled`,
        { cause: signal.reason },
      );
    }
    const attempt = await attemptExclusiveLock(path, {
      mode: options.mode ?? 0o600,
      reclaim: true,
      ownerlessGraceMs,
      ...(options.machineIdentity !== undefined && {
        machineIdentity: options.machineIdentity,
      }),
    });
    if ('held' in attempt) {
      const { held } = attempt;
      let result: T;
      try {
        result = await run({ path: held.path, owner: held.owner, reclaimed: held.reclaimed });
      } catch (error) {
        await held.release().catch(() => undefined);
        throw error;
      }
      await held.release();
      return result;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      const holder = attempt.diagnosis?.owner ?? null;
      throw new ExclusiveLockError(
        'LOCK_TIMEOUT',
        label,
        holder,
        `[stitchkit] the lock on "${label}" is held by ${describeHolder(holder)}; gave up after ${timeoutMs} ms`,
        { cause: attempt.error },
      );
    }
    // Jittered, so waiters released by one holder do not all retry together.
    await pause(Math.min(delay * (0.5 + Math.random() / 2), remaining), signal);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}
