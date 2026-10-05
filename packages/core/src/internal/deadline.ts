import { assertPositiveSafeInteger } from './positive-integer';
import { MAX_TIMER_MS } from './timers';

/**
 * Resolve to `{ settled: false }` if the value has not settled in time.
 *
 * One implementation, because two places need exactly this and they need it to
 * behave identically: an event bus asking listeners to vote, and a decision
 * pipeline asking policies to. A second copy would be a second set of bugs.
 *
 * The timer is always cleared: a dispatch must not be the reason a process stays
 * alive, and an uncleared timer on every announcement is exactly that.
 */
export async function withDeadline(
  value: unknown,
  timeoutMs: number,
): Promise<{ settled: true; value: unknown } | { settled: false }> {
  if (!(value instanceof Promise)) return { settled: true, value };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      value.then((settledValue): { settled: true; value: unknown } => ({
        settled: true,
        value: settledValue,
      })),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run `body` under the caller's signal and a deadline.
 *
 * One implementation of "caller signal plus timer": the signal handed to `body` aborts
 * with the caller's own reason, or with `makeReason()` when `timeoutMs` passes. `body` owns its own cleanup, so the returned promise settles only when `body` does; a
 * body that may ignore its signal wraps the wait it cannot trust in `raceAbort`. The caller's
 * signal is only read, never changed. The timer is cleared on every outcome and is a normal
 * (referenced) timer, so a pending wait keeps the process alive until its deadline.
 */
export async function withSignalDeadline<T>(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  makeReason: () => unknown,
  body: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertPositiveSafeInteger('Deadline timeoutMs', timeoutMs, RangeError);
  if (timeoutMs > MAX_TIMER_MS)
    throw new RangeError('Deadline timeoutMs exceeds the timer range');
  caller?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(makeReason()), timeoutMs);
  const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
  try {
    return await body(signal);
  } finally {
    clearTimeout(timer);
  }
}
