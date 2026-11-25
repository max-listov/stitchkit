import { abortError } from '../internal/abort-error';
import { raceAbort, withLinkedAbortSignals } from '../internal/abort-race';
import { type SteppedTimerClock, scheduleAt } from '../internal/timers';
import type { SessionOperation, SessionScope } from './session';
import { refreshDelayMs, type SessionClock } from './session-refresh-policy';

/** The shortest pause a short-lived token can shrink the refresh cooldown to. */
const MIN_REFRESH_PAUSE_MS = 1_000;

export interface SessionRefreshTimerConfig<TSession> {
  readonly scope: SessionScope<TSession>;
  readonly clock: SessionClock;
  readonly leadMs: number;
  readonly cooldownMs: number;
  readonly storageRetryMs: number;
  readonly onRefreshDue: (operation: SessionOperation<TSession>) => void;
  readonly onStorageRetry: (operation: SessionOperation<TSession>) => void;
}

export interface SessionRefreshTimer<TSession> {
  bind(operation: SessionOperation<TSession>): void;
  markFired(operation: SessionOperation<TSession>): void;
  cooldownPassed(
    operation: SessionOperation<TSession>,
    expiresAt?: number | null,
    receivedAt?: number,
  ): boolean;
  armRefresh(
    operation: SessionOperation<TSession>,
    expiresAt: number | null,
    receivedAt?: number,
  ): void;
  armRetry(operation: SessionOperation<TSession>, delayMs: number): void;
  cancelRefresh(): void;
  armStorageRetry(operation: SessionOperation<TSession>): void;
  cancelStorageRetry(): void;
  clear(): void;
}

/**
 * Generation-fenced timer controller for proactive refresh, backoff retries and
 * deferred post-rotation credential writes.
 */
export function createSessionRefreshTimer<TSession>(
  config: SessionRefreshTimerConfig<TSession>,
): SessionRefreshTimer<TSession> {
  const { scope, clock, leadMs, cooldownMs, storageRetryMs } = config;
  let bound: SessionOperation<TSession> | undefined;
  let detachAbort: (() => void) | undefined;
  let lastFiredAt: number | null = null;
  let refreshHandle: { cancel(): void } | undefined;
  let storageHandle: { cancel(): void } | undefined;
  // Every wait goes through `scheduleAt`, so one past the timer ceiling steps: a refresh due at a
  // token's expiry on the wall clock, which each step reads again; a retry or a storage write on
  // the monotonic clock.
  const wall: SteppedTimerClock = {
    now: () => clock.now(),
    schedule: (run, delayMs) => clock.schedule(run, delayMs),
  };
  const monotonic: SteppedTimerClock = {
    now: () => clock.monotonic(),
    schedule: (run, delayMs) => clock.schedule(run, delayMs),
  };

  const cancelRefresh = (): void => {
    refreshHandle?.cancel();
    refreshHandle = undefined;
  };

  const cancelStorageRetry = (): void => {
    storageHandle?.cancel();
    storageHandle = undefined;
  };

  const cancelAll = (): void => {
    cancelRefresh();
    cancelStorageRetry();
  };

  const clear = (): void => {
    cancelAll();
    detachAbort?.();
    detachAbort = undefined;
    bound = undefined;
    lastFiredAt = null;
  };

  // The pause between proactive refreshes never outlasts half a token's life: held to the
  // full cooldown, a token shorter than twice the cooldown would expire before its refresh.
  // A token that arrives already expired, or with almost no life, gets no such discount: the
  // cooldown is all that stands between that server and one refresh after another.
  const remainingCooldown = (expiresAt: number, receivedAt: number | undefined): number => {
    if (lastFiredAt === null) return 0;
    const halfLife = receivedAt === undefined ? 0 : (expiresAt - receivedAt) / 2;
    const pause =
      halfLife >= MIN_REFRESH_PAUSE_MS ? Math.min(cooldownMs, halfLife) : cooldownMs;
    return Math.max(0, lastFiredAt + pause - clock.monotonic());
  };

  const isOwned = (operation: SessionOperation<TSession>): boolean =>
    bound === operation && scope.owns(operation);

  const scheduleProactiveStep = (
    operation: SessionOperation<TSession>,
    expiresAt: number,
    receivedAt: number | undefined,
  ): void => {
    cancelRefresh();
    const delay = Math.max(
      refreshDelayMs(expiresAt, receivedAt, clock.now(), leadMs),
      remainingCooldown(expiresAt, receivedAt),
    );
    if (!isOwned(operation)) return;
    refreshHandle = scheduleAt(wall, clock.now() + delay, () => {
      refreshHandle = undefined;
      if (!isOwned(operation)) return;
      // The expiry is on the wall clock, which may have moved while this waited: read it again.
      const remaining = Math.max(
        refreshDelayMs(expiresAt, receivedAt, clock.now(), leadMs),
        remainingCooldown(expiresAt, receivedAt),
      );
      if (!isOwned(operation)) return;
      if (remaining > 0) {
        scheduleProactiveStep(operation, expiresAt, receivedAt);
        return;
      }
      lastFiredAt = clock.monotonic();
      config.onRefreshDue(operation);
    });
  };

  const scheduleRetryStep = (
    operation: SessionOperation<TSession>,
    targetMono: number,
  ): void => {
    cancelRefresh();
    if (!isOwned(operation)) return;
    refreshHandle = scheduleAt(monotonic, targetMono, () => {
      refreshHandle = undefined;
      if (!isOwned(operation)) return;
      lastFiredAt = clock.monotonic();
      config.onRefreshDue(operation);
    });
  };

  return {
    bind(operation) {
      clear();
      if (!scope.owns(operation)) return;
      bound = operation;
      const onAbort = (): void => {
        if (bound === operation) clear();
      };
      operation.signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => operation.signal.removeEventListener('abort', onAbort);
    },
    markFired(operation) {
      if (bound === operation) lastFiredAt = clock.monotonic();
    },
    cooldownPassed(operation, expiresAt, receivedAt) {
      if (bound !== operation) return false;
      if (expiresAt !== undefined && expiresAt !== null && Number.isFinite(expiresAt)) {
        return remainingCooldown(expiresAt, receivedAt) === 0;
      }
      return lastFiredAt === null || clock.monotonic() - lastFiredAt >= cooldownMs;
    },
    armRefresh(operation, expiresAt, receivedAt) {
      cancelRefresh();
      if (expiresAt === null || !Number.isFinite(expiresAt)) return;
      if (!isOwned(operation)) return;
      scheduleProactiveStep(operation, expiresAt, receivedAt);
    },
    armRetry(operation, delayMs) {
      cancelRefresh();
      if (!isOwned(operation)) return;
      scheduleRetryStep(operation, clock.monotonic() + Math.max(0, delayMs));
    },
    cancelRefresh,
    armStorageRetry(operation) {
      cancelStorageRetry();
      if (!isOwned(operation)) return;
      storageHandle = scheduleAt(monotonic, clock.monotonic() + storageRetryMs, () => {
        storageHandle = undefined;
        if (!isOwned(operation)) return;
        config.onStorageRetry(operation);
      });
    },
    cancelStorageRetry,
    clear,
  };
}

/** Run refresh exchange bounded by both the session operation's abort signal and `timeoutMs` on `clock`. */
export function runWithRefreshDeadline<T>(
  operation: SessionOperation<unknown>,
  clock: SessionClock,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  operation.assertCurrent();
  const controller = new AbortController();
  return withLinkedAbortSignals(operation.signal, controller.signal, (signal) => {
    const timeoutHandle = clock.schedule(
      () => controller.abort(abortError('Refresh timed out', 'TimeoutError')),
      timeoutMs,
    );
    let workPromise: Promise<T>;
    try {
      workPromise = Promise.resolve(work(signal));
    } catch (error) {
      timeoutHandle.cancel();
      return Promise.reject(error);
    }
    return raceAbort(workPromise, signal).finally(() => {
      timeoutHandle.cancel();
    });
  });
}
