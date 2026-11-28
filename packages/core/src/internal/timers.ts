import { abortReason } from './abort-race';

/** The longest delay a timer can wait (2^31 - 1 ms, about 24.8 days); a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Clamp a delay in milliseconds into the safe timer range (`0..MAX_TIMER_MS`). */
export function clampTimerMs(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_TIMER_MS);
}

/** A clock that can also arm a one-shot timer — the seam `scheduleAt` steps on. */
export interface SteppedTimerClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): { cancel(): void };
}

/** `performance.now()` and a plain timer: the clock of a deadline taken from `performance.now()`. */
export const monotonicTimerClock: SteppedTimerClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

/**
 * Call `onDue` at `dueAt` on `clock.now()`'s scale: the one way a wait is taken that may outlast
 * the timer ceiling — a long period, or a deadline that is the sum of two budgets. It is taken in
 * steps of at most `MAX_TIMER_MS`, and every step that ends re-reads the clock: a step that ended
 * before `dueAt` arms the rest, so the call never fires early. `onDue` always runs from a timer,
 * never inside `scheduleAt` itself. `cancel` stops whichever step is armed, also from code the
 * clock runs while a step is read.
 */
export function scheduleAt(
  clock: SteppedTimerClock,
  dueAt: number,
  onDue: () => void,
): { cancel(): void } {
  let step: { cancel(): void };
  let cancelled = false;
  const arm = (): void => {
    const delayMs = Math.max(0, dueAt - clock.now());
    // This read may have cancelled the wait too: then nothing is armed.
    if (cancelled) return;
    step = clock.schedule(() => {
      const early = clock.now() < dueAt;
      // Reading the clock may have run code that cancelled this wait.
      if (cancelled) return;
      if (early) arm();
      else onDue();
    }, clampTimerMs(delayMs));
  };
  arm();
  return {
    cancel() {
      cancelled = true;
      step.cancel();
    },
  };
}

/**
 * Wait `ms`, or reject with the signal's reason as soon as `signal` aborts.
 *
 * One abortable pause for every retry, backoff and poll loop. The timer is cleared
 * on abort and the listener is removed on completion, so a cancelled wait leaves
 * nothing behind.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      if (signal) reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
