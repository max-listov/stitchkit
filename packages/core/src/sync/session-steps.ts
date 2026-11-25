/**
 * What the steps of a sync session run on: a result that is here or will be, a
 * refusal kept inside the session, ids and timers when the app names none.
 */
import { randomHex } from '../internal/random-hex';
import { monotonicTimerClock } from '../internal/timers';
import type { Eventually } from './session';

/** Continue with a result: at once when it is here, after the wait otherwise. */
export function chain<T>(
  value: Eventually<T>,
  next: (value: T) => Eventually<void>,
): Eventually<void> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/** Run a step; a refusal — thrown or rejected — goes to `onError`, never out. */
export function guarded(
  run: () => Eventually<void>,
  onError: (error: unknown) => void,
): Eventually<void> {
  try {
    const result = run();
    return result instanceof Promise ? result.catch(onError) : result;
  } catch (error) {
    onError(error);
  }
}

/**
 * Ids from `crypto.randomUUID`, falling back to 128-bit `randomHex(16)` when only
 * `crypto.getRandomValues` is available (React Native / Hermes with a random-values
 * polyfill). A runtime with neither gets a refusal that names the port at creation —
 * not a session that fails every attempt with a reason that points elsewhere.
 */
export function defaultNewId(): () => string {
  const cryptoGlobal = globalThis.crypto;
  if (typeof cryptoGlobal?.randomUUID === 'function') {
    return () => globalThis.crypto.randomUUID();
  }
  if (typeof cryptoGlobal?.getRandomValues === 'function') {
    return () => randomHex(16);
  }
  throw new TypeError(
    '[stitchkit] createSyncSession: this runtime has no crypto.randomUUID or crypto.getRandomValues — pass `newId`',
  );
}

/** The timer of a session whose app names no `schedule`: the monotonic clock's, as a cancel function. */
export const setTimeoutSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = monotonicTimerClock.schedule(run, delayMs);
  return () => timer.cancel();
};
