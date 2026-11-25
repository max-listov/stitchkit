import { linkAbortSignals } from './abort-race';
import { MAX_TIMER_MS } from './timers';

/**
 * Refuse a timer duration `setTimeout` would not honour as written. `undefined` means "not
 * set" and passes, unless `absent: 'refused'`. A value that is not a number is a
 * `TypeError`; a number that is not a safe integer, is below `min` (1 by default, 0 for a
 * pause that may be none) or is past `MAX_TIMER_MS` — where a timer fires at once — is a
 * `RangeError`.
 *
 * The one rule for every timer option: a component calls it in its factory, before it
 * spawns, allocates or schedules anything.
 */
export function assertTimerMs(
  name: string,
  value: number | undefined,
  options: { min?: 0 | 1; absent?: 'passes' | 'refused' } = {},
): void {
  if (value === undefined && options.absent !== 'refused') return;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number of milliseconds, received ${String(value)}`);
  }
  const min = options.min ?? 1;
  if (!Number.isSafeInteger(value) || value < min || value > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${MAX_TIMER_MS} milliseconds, received ${value}`,
    );
  }
}

/**
 * The timer rule for a duration given in seconds, where a fraction is a real value (a 0.5 s wait)
 * and 0 is a deadline already due: not a number is a `TypeError`; not finite, below 0, or longer
 * than `MAX_TIMER_MS` once in milliseconds is a `RangeError`. `undefined` means "not set" and passes.
 */
export function assertTimerSeconds(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number of seconds, received ${String(value)}`);
  }
  if (!Number.isFinite(value) || value < 0 || value * 1000 > MAX_TIMER_MS) {
    throw new RangeError(
      `${name} must be a number of seconds from 0 to ${MAX_TIMER_MS / 1000}, received ${value}`,
    );
  }
}

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
export async function withDeadline<VALUE = unknown>(
  value: VALUE | Promise<VALUE>,
  timeoutMs: number,
): Promise<{ settled: true; value: VALUE } | { settled: false }> {
  if (!(value instanceof Promise)) return { settled: true, value };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      value.then((settledValue: VALUE): { settled: true; value: VALUE } => ({
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
  assertTimerMs('Deadline timeoutMs', timeoutMs);
  caller?.throwIfAborted();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(makeReason()), timeoutMs);
  const link = linkAbortSignals(caller, deadline.signal);
  try {
    return await body(link.signal);
  } finally {
    clearTimeout(timer);
    link.release();
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
  const { signal, release } = linkAbortSignals(parent, quiet.signal);
  const touch = () => {
    if (!signal.aborted) timer.touch();
  };
  try {
    return await body({ signal, touch });
  } finally {
    timer.stop();
    release();
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
  assertTimerMs('Idle timer idleMs', idleMs);
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
