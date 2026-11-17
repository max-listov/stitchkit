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

/** The signal and progress hook a body runs under in {@link withIdleDeadline}. */
export interface IdleDeadline {
  /** Aborts with the parent's reason, or with `makeReason()` when no progress arrives in time. */
  readonly signal: AbortSignal;
  /** Report progress: the quiet period starts again. Does nothing once the body settled. */
  touch(): void;
}

/**
 * Run `body` under a deadline that restarts on every `touch()` — "nothing arrived for
 * `idleMs`" rather than "the whole exchange took too long", so a slow transfer that keeps
 * delivering is never cut off while a silent one still ends.
 *
 * With `idleMs` undefined there is no idle timer and `signal` is the parent's own. The timer is
 * cleared on every outcome, and a `touch()` that arrives after the body settled — a read still
 * finishing behind a released await — re-arms nothing, so no timer outlives the call.
 */
export async function withIdleDeadline<T>(
  idleMs: number | undefined,
  parent: AbortSignal,
  makeReason: () => unknown,
  body: (idle: IdleDeadline) => Promise<T>,
): Promise<T> {
  if (idleMs === undefined) return body({ signal: parent, touch: () => undefined });
  parent.throwIfAborted();
  const quiet = new AbortController();
  const timer = startIdleTimer(idleMs, () => quiet.abort(makeReason()));
  const signal = AbortSignal.any([parent, quiet.signal]);
  const touch = () => {
    if (!signal.aborted) timer.touch();
  };
  try {
    return await body({ signal, touch });
  } finally {
    timer.stop();
  }
}

/** A quiet-period timer: `touch()` restarts it, `stop()` ends it for good. */
export interface IdleTimer {
  touch(): void;
  stop(): void;
}

/**
 * Call `onIdle` once `idleMs` pass without a `touch()`. After `stop()` — or after it fired —
 * nothing re-arms it, so a late `touch()` from a read still draining cannot leave a timer
 * behind. The one timer behind {@link withIdleDeadline} and the guarded fetch's idle bound.
 */
export function startIdleTimer(
  idleMs: number,
  onIdle: () => void,
  options: { unref?: boolean } = {},
): IdleTimer {
  assertPositiveSafeInteger('Idle timer idleMs', idleMs, RangeError);
  if (idleMs > MAX_TIMER_MS) throw new RangeError('Idle timer idleMs exceeds the timer range');
  let done = false;
  const arm = () => {
    const handle = setTimeout(() => {
      done = true;
      onIdle();
    }, idleMs);
    if (options.unref) handle.unref?.();
    return handle;
  };
  let handle = arm();
  return {
    touch() {
      if (done) return;
      clearTimeout(handle);
      handle = arm();
    },
    stop() {
      done = true;
      clearTimeout(handle);
    },
  };
}
