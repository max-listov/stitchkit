/**
 * The shared poll-until-done loop — one backoff/timeout engine behind both the
 * CLI `--wait` (`pollUntilDone`) and the native MCP `mountWait` tool, so the
 * polling mechanics live in exactly one place. Domain-free (ADR 0002): the
 * caller supplies how to fetch a state (`poll`) and when it is terminal (`done`).
 */

const DEFAULT_BACKOFF = [2, 3, 5, 5, 8, 10];
const DEFAULT_TIMEOUT = 600;

export class WaitTimeoutError extends Error {
  constructor() {
    super('wait deadline elapsed before the first snapshot');
    this.name = 'WaitTimeoutError';
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    const timer = setTimeout(() => {
      settle(resolve);
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      settle(() => reject(signal?.reason ?? new Error('aborted')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the check/listen race if the caller aborts between throwIfAborted
    // above and listener registration.
    if (signal?.aborted) onAbort();
  });
};

export interface PollUntilParams<T> {
  /** Fetch the current state — called once per tick. */
  poll: (signal?: AbortSignal) => Promise<T>;
  /** Stop when this returns `true` for a fetched state. */
  done: (state: T) => boolean;
  /** Backoff schedule in seconds; the last entry repeats. Default `[2,3,5,5,8,10]`. */
  backoff?: number[];
  /** Max seconds before giving up. Default `600`. */
  timeoutSec?: number;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Progress callback — `(attempt, elapsedSec)` after each non-terminal poll. */
  onTick?: (attempt: number, elapsedSec: number) => void;
  /** Optional caller cancellation, checked before/after every poll and during sleep. */
  signal?: AbortSignal;
  /** Injectable monotonic millisecond clock for deterministic deadline tests. */
  nowFn?: () => number;
}

export interface PollUntilResult<T> {
  /** The last fetched state. */
  state: T;
  /** `true` when the timeout was hit before `done`. */
  timedOut: boolean;
}

/**
 * Poll until `done` or the timeout. Polls first, then sleeps with backoff —
 * returns the terminal state (`timedOut: false`) or the last state seen when
 * the deadline passed (`timedOut: true`).
 */
export async function pollUntil<T>(params: PollUntilParams<T>): Promise<PollUntilResult<T>> {
  const backoff = params.backoff?.length ? params.backoff : DEFAULT_BACKOFF;
  const lastBackoff = backoff[backoff.length - 1] ?? 5;
  const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT;
  const sleep = params.sleepFn ?? defaultSleep;
  const now = params.nowFn ?? (() => performance.now());
  const startedAt = now();
  const deadline = startedAt + timeoutSec * 1000;
  let last: { state: T } | undefined;

  for (let attempt = 0; ; attempt++) {
    params.signal?.throwIfAborted();
    const remainingBeforePoll = Math.max(0, deadline - now());
    if (remainingBeforePoll === 0 && last) {
      return { state: last.state, timedOut: true };
    }
    const deadlineController = new AbortController();
    const onCallerAbort = (): void => deadlineController.abort(params.signal?.reason);
    params.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new WaitTimeoutError()),
      remainingBeforePoll,
    );
    deadlineTimer.unref?.();
    let state: T;
    try {
      state = await params.poll(deadlineController.signal);
    } catch (error) {
      if (params.signal?.aborted) throw params.signal.reason ?? error;
      if (deadlineController.signal.aborted && now() >= deadline) {
        if (last) return { state: last.state, timedOut: true };
        throw new WaitTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      params.signal?.removeEventListener('abort', onCallerAbort);
    }
    params.signal?.throwIfAborted();
    last = { state };
    if (params.done(state)) return { state, timedOut: false };

    const elapsedMs = now() - startedAt;
    const elapsedSec = elapsedMs / 1000;
    params.onTick?.(attempt + 1, elapsedSec);
    if (elapsedSec >= timeoutSec) return { state, timedOut: true };

    const waitSec = backoff[Math.min(attempt, backoff.length - 1)] ?? lastBackoff;
    await sleep(Math.min(waitSec * 1000, Math.max(0, deadline - now())), params.signal);
  }
}

/** Typed operation adapter shared by raw MCP and managed runtime wait tools. */
export interface WaitOperationParams<TInput, TState>
  extends Omit<PollUntilParams<TState>, 'poll'> {
  input: TInput;
  poll: (input: TInput, signal?: AbortSignal) => Promise<TState>;
}

/** Run one wait operation without owning any MCP/Agent presentation. */
export function runWaitOperation<TInput, TState>(
  params: WaitOperationParams<TInput, TState>,
): Promise<PollUntilResult<TState>> {
  return pollUntil({
    poll: (signal) => params.poll(params.input, signal),
    done: params.done,
    backoff: params.backoff,
    timeoutSec: params.timeoutSec,
    sleepFn: params.sleepFn,
    onTick: params.onTick,
    signal: params.signal,
    nowFn: params.nowFn,
  });
}
