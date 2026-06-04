/**
 * The shared poll-until-done loop — one backoff/timeout engine behind both the
 * CLI `--wait` (`pollUntilDone`) and the native MCP `mountWait` tool, so the
 * polling mechanics live in exactly one place. Domain-free (ADR 0002): the
 * caller supplies how to fetch a state (`poll`) and when it is terminal (`done`).
 */

const DEFAULT_BACKOFF = [2, 3, 5, 5, 8, 10];
const DEFAULT_TIMEOUT = 600;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface PollUntilParams<T> {
  /** Fetch the current state — called once per tick. */
  poll: () => Promise<T>;
  /** Stop when this returns `true` for a fetched state. */
  done: (state: T) => boolean;
  /** Backoff schedule in seconds; the last entry repeats. Default `[2,3,5,5,8,10]`. */
  backoff?: number[];
  /** Max seconds before giving up. Default `600`. */
  timeoutSec?: number;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Progress callback — `(attempt, elapsedSec)` after each non-terminal poll. */
  onTick?: (attempt: number, elapsedSec: number) => void;
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
  const startedAt = Date.now();

  for (let attempt = 0; ; attempt++) {
    const state = await params.poll();
    if (params.done(state)) return { state, timedOut: false };

    const elapsedSec = (Date.now() - startedAt) / 1000;
    params.onTick?.(attempt + 1, elapsedSec);
    if (elapsedSec >= timeoutSec) return { state, timedOut: true };

    const waitSec = backoff[Math.min(attempt, backoff.length - 1)] ?? lastBackoff;
    await sleep(waitSec * 1000);
  }
}
