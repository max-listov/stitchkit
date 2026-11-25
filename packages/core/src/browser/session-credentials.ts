import type { BackoffPolicy } from '../internal/backoff';
import { messageOf } from '../internal/error-message';
import { SessionExpiredError, type SessionOperation, type SessionScope } from './session';
import {
  type ActiveSessionState,
  createCredentialPersistence,
} from './session-credentials-storage';
import {
  type ParsedSessionOptions,
  parseSessionCredentialsOptions,
  refreshDue,
  type SessionClock,
  type SessionCredentialsEvent,
  type SessionRefreshAhead,
  type SessionRefreshFailure,
  type SessionRefreshOptions,
  SessionRefreshRejectedError,
  type SessionRestoreResult,
} from './session-refresh-policy';
import {
  createSessionRefreshTimer,
  runWithRefreshDeadline,
  type SessionRefreshTimer,
} from './session-refresh-timer';

export interface SessionCredentialsConfig<TSession, TCredentials> {
  readonly scope: SessionScope<TSession>;
  readonly refresh: (
    credentials: NoInfer<TCredentials>,
    signal: AbortSignal,
  ) => Promise<TCredentials>;
  readonly storage: {
    read(): Promise<{ readonly session: TSession; readonly credentials: TCredentials } | null>;
    write(session: TSession, credentials: NoInfer<TCredentials>): Promise<void>;
    clear(): Promise<void>;
  };
  readonly maxPendingWrites?: number;
  readonly refreshTimeoutMs?: number;
  /**
   * How long one `storage.read`, `storage.write` or `storage.clear` may hold the queue
   * (default 30 s). A hung write would otherwise keep `logout()` from ever clearing
   * what is persisted.
   */
  readonly storageTimeoutMs?: number;
  /** Proactive refresh schedule derived from token expiry. */
  readonly refreshAhead?: SessionRefreshAhead<NoInfer<TCredentials>>;
  /** Override refresh-endpoint failure classification (default: HTTP 401/403 → `'rejected'`, everything else → `'unavailable'`). */
  readonly classifyRefreshFailure?: (error: unknown) => SessionRefreshFailure;
  /** Backoff policy for retrying `'unavailable'` proactive refreshes (default 30 s–300 s, jitter 0.5). */
  readonly retry?: BackoffPolicy;
  /** Pause before retrying a failed post-rotation `storage.write` (default 5 s). */
  readonly storageRetryMs?: number;
  /** Observer for refresh and storage recovery outcomes; never receives `SessionExpiredError`. */
  readonly onEvent?: (event: SessionCredentialsEvent<TSession>) => void;
  /** Clock and timer port (default: `Date.now`, `performance.now` and unref'd `setTimeout`). */
  readonly clock?: SessionClock;
}

export interface SessionCredentials<TSession, TCredentials> {
  /** Start a generation and store it; a failed store signs nobody in and clears the stored session it replaced. */
  login(session: TSession, credentials: TCredentials): Promise<SessionOperation<TSession>>;
  logout(): Promise<void>;
  restore(): Promise<SessionRestoreResult<TSession>>;
  read(operation: SessionOperation<TSession>): TCredentials;
  refresh(
    operation: SessionOperation<TSession>,
    options?: SessionRefreshOptions<TCredentials>,
  ): Promise<TCredentials>;
  refreshIfDue(operation: SessionOperation<TSession>): Promise<TCredentials | undefined>;
}

interface ActiveFlight<TSession, TCredentials> {
  readonly operation: SessionOperation<TSession>;
  rotated: boolean;
  result: Promise<TCredentials>;
}

interface RefreshExecutionContext<TSession, TCredentials> {
  readonly config: SessionCredentialsConfig<TSession, TCredentials>;
  readonly options: ParsedSessionOptions;
  readonly timers: SessionRefreshTimer<TSession>;
  readonly persistence: ReturnType<typeof createCredentialPersistence<TSession, TCredentials>>;
  readonly getState: () => ActiveSessionState<TSession, TCredentials> | undefined;
  readonly read: (operation: SessionOperation<TSession>) => TCredentials;
  readonly readExpiresAt: (credentials: TCredentials) => number | null;
  readonly emit: (event: SessionCredentialsEvent<TSession>) => void;
  readonly recordStorageFailure: (
    operation: SessionOperation<TSession>,
    error: unknown,
  ) => void;
}

async function syncUnstoredCredentials<TSession, TCredentials>(
  ctx: RefreshExecutionContext<TSession, TCredentials>,
  operation: SessionOperation<TSession>,
  mode: 'retry' | 'flush',
): Promise<void> {
  const current = ctx.getState();
  if (
    !ctx.config.scope.owns(operation) ||
    current?.operation !== operation ||
    !current.unstored
  )
    return;
  if (mode === 'flush') ctx.timers.cancelStorageRetry();
  const target = current.credentials;
  try {
    await ctx.persistence.rewriteStored(operation);
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      if (mode === 'flush') throw error;
      return;
    }
    const latest = ctx.getState();
    if (!ctx.config.scope.owns(operation) || latest?.operation !== operation) {
      if (mode === 'flush') throw new SessionExpiredError({ cause: error });
      return;
    }
    if (latest.credentials === target) ctx.recordStorageFailure(operation, error);
    if (mode === 'flush') throw error;
  }
}

async function runRefreshPass<TSession, TCredentials>(
  ctx: RefreshExecutionContext<TSession, TCredentials>,
  operation: SessionOperation<TSession>,
  markRotated: () => void,
): Promise<TCredentials> {
  const { config, options, timers, persistence } = ctx;
  const recordUnavailable = (credentials: TCredentials, error: unknown): void => {
    const expiresAt = ctx.readExpiresAt(credentials);
    const current = ctx.getState();
    const canRetry =
      config.refreshAhead !== undefined &&
      expiresAt !== null &&
      current?.operation === operation &&
      !current.rejected;
    const retryInMs = canRetry ? options.backoff.next() : null;
    if (retryInMs !== null) timers.armRetry(operation, retryInMs);
    ctx.emit({ type: 'refresh-unavailable', operation, error, retryInMs, expiresAt });
  };

  const initial = ctx.getState();
  if (!config.scope.owns(operation) || initial?.operation !== operation) {
    throw new SessionExpiredError();
  }
  if (initial.unstored) {
    try {
      await syncUnstoredCredentials(ctx, operation, 'flush');
    } catch (error) {
      if (error instanceof SessionExpiredError) throw error;
      const latest = ctx.getState();
      if (!config.scope.owns(operation) || latest?.operation !== operation) {
        throw new SessionExpiredError({ cause: error });
      }
      recordUnavailable(latest.credentials, error);
      throw error;
    }
  }
  const credentials = ctx.read(operation);
  operation.assertCurrent();
  timers.markFired(operation);
  let next: TCredentials;
  try {
    next = await runWithRefreshDeadline(operation, options.clock, options.timeout, (signal) =>
      config.refresh(credentials, signal),
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    const latest = ctx.getState();
    if (!config.scope.owns(operation) || latest?.operation !== operation) {
      throw new SessionExpiredError({ cause: error });
    }
    if (options.classify(error) === 'rejected') {
      latest.rejected = true;
      timers.cancelRefresh();
      ctx.emit({ type: 'refresh-rejected', operation, error });
      throw new SessionRefreshRejectedError({ cause: error });
    }
    recordUnavailable(credentials, error);
    throw error;
  }
  ctx.read(operation);
  options.backoff.reset();
  const receivedAt = options.clock.now();
  const active = ctx.getState();
  if (!active || active.operation !== operation) throw new SessionExpiredError();
  active.credentials = next;
  active.receivedAt = receivedAt;
  active.unstored = true;
  active.rejected = false;
  markRotated();
  let storageFailure: { readonly failed: true; readonly error: unknown } | undefined;
  try {
    await persistence.write(operation, next);
    if (ctx.getState() === active && active.credentials === next) {
      active.unstored = false;
      timers.cancelStorageRetry();
    }
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    if (!config.scope.owns(operation) || ctx.getState()?.operation !== operation) {
      throw new SessionExpiredError({ cause: error });
    }
    active.unstored = true;
    timers.armStorageRetry(operation);
    storageFailure = { failed: true, error };
  }
  ctx.read(operation);
  const expiresAt = ctx.readExpiresAt(next);
  if (config.refreshAhead) timers.armRefresh(operation, expiresAt, receivedAt);
  if (storageFailure) {
    ctx.emit({
      type: 'storage-failed',
      operation,
      error: storageFailure.error,
      retryInMs: options.storageRetryMs,
    });
  }
  if (config.scope.owns(operation) && ctx.getState()?.operation === operation) {
    ctx.emit({ type: 'refreshed', operation, expiresAt });
  }
  return next;
}

async function writeLoginCredentials<TSession, TCredentials>(
  ctx: RefreshExecutionContext<TSession, TCredentials>,
  operation: SessionOperation<TSession>,
  credentials: TCredentials,
  clearState: () => void,
): Promise<void> {
  try {
    await ctx.persistence.write(operation, credentials);
    operation.assertCurrent();
  } catch (error) {
    const isSameOperation = ctx.getState()?.operation === operation;
    if (isSameOperation && ctx.config.scope.owns(operation)) {
      ctx.timers.clear();
      clearState();
      ctx.config.scope.clear();
      // Nobody is signed in now, so storage must not keep the session this login replaced:
      // a restart would otherwise restore it.
      await ctx.persistence.rewriteStored().catch((clearError: unknown) => {
        throw new AggregateError(
          [error, clearError],
          `Login failed (${messageOf(error)}) and the stored session could not be cleared`,
          { cause: error },
        );
      });
      throw error;
    }
    if (isSameOperation) clearState();
    if (error instanceof SessionExpiredError) throw error;
    throw new SessionExpiredError({ cause: error });
  }
}

/** Coordinates one client's memory, persistence and proactive refresh. Cross-process CAS belongs to storage. */
export function createSessionCredentials<TSession, TCredentials>(
  config: SessionCredentialsConfig<TSession, TCredentials>,
): SessionCredentials<TSession, TCredentials> {
  const options = parseSessionCredentialsOptions(config);
  const { storageTimeout, storageRetryMs, leadMs, cooldownMs, backoff, clock } = options;
  let state: ActiveSessionState<TSession, TCredentials> | undefined;
  let flight: ActiveFlight<TSession, TCredentials> | undefined;

  const emit = (event: SessionCredentialsEvent<TSession>): void => {
    try {
      config.onEvent?.(event);
    } catch {
      // Observer failures must never interrupt credential state transitions.
    }
  };

  const readExpiresAt = (credentials: TCredentials): number | null => {
    if (!config.refreshAhead) return null;
    const value = config.refreshAhead.expiresAt(credentials);
    return value !== null && Number.isFinite(value) ? value : null;
  };

  const read = (operation: SessionOperation<TSession>): TCredentials => {
    if (!config.scope.owns(operation) || state?.operation !== operation)
      throw new SessionExpiredError();
    return state.credentials;
  };

  const recordStorageFailure = (
    operation: SessionOperation<TSession>,
    error: unknown,
  ): void => {
    if (!config.scope.owns(operation) || state?.operation !== operation) return;
    state.unstored = true;
    timers.armStorageRetry(operation);
    emit({ type: 'storage-failed', operation, error, retryInMs: storageRetryMs });
  };

  const timers = createSessionRefreshTimer<TSession>({
    scope: config.scope,
    clock,
    leadMs,
    cooldownMs,
    storageRetryMs,
    onRefreshDue(operation) {
      if (!config.scope.owns(operation) || state?.operation !== operation || state.rejected)
        return;
      void refresh(operation).catch(() => undefined);
    },
    onStorageRetry(operation) {
      void syncUnstoredCredentials(executionContext, operation, 'retry').catch(
        () => undefined,
      );
    },
  });

  const persistence = createCredentialPersistence({
    scope: config.scope,
    storage: config.storage,
    clock,
    capacity: options.capacity,
    storageTimeout,
    getState: () => state,
    onConverged: () => timers.cancelStorageRetry(),
    onRewriteFailed: recordStorageFailure,
  });

  const executionContext: RefreshExecutionContext<TSession, TCredentials> = {
    config,
    options,
    timers,
    persistence,
    getState: () => state,
    read,
    readExpiresAt,
    emit,
    recordStorageFailure,
  };

  const refresh = (
    operation: SessionOperation<TSession>,
    refreshOptions?: SessionRefreshOptions<TCredentials>,
  ): Promise<TCredentials> => {
    const credentials = read(operation);
    if (refreshOptions?.rejected !== undefined && refreshOptions.rejected !== credentials) {
      return Promise.resolve(credentials);
    }
    if (flight?.operation === operation) {
      if (
        refreshOptions?.rejected !== undefined &&
        flight.rotated &&
        refreshOptions.rejected === credentials
      ) {
        const pending = flight.result;
        return pending.then(
          () => refresh(operation, refreshOptions),
          () => refresh(operation, refreshOptions),
        );
      }
      return flight.result;
    }
    const activeFlight: ActiveFlight<TSession, TCredentials> = {
      operation,
      rotated: false,
      result: Promise.resolve(credentials),
    };
    const result = operation
      .run(() =>
        runRefreshPass(executionContext, operation, () => {
          activeFlight.rotated = true;
        }),
      )
      .finally(() => {
        if (flight?.result === result) flight = undefined;
      });
    activeFlight.result = result;
    flight = activeFlight;
    return result;
  };

  const activateGeneration = (
    operation: SessionOperation<TSession>,
    credentials: TCredentials,
    receivedAt: number | undefined,
  ): void => {
    backoff.reset();
    timers.bind(operation);
    if (config.refreshAhead)
      timers.armRefresh(operation, readExpiresAt(credentials), receivedAt);
  };

  return {
    async login(session, credentials) {
      const operation = config.scope.replace(session);
      operation.assertCurrent();
      const receivedAt = clock.now();
      state = { operation, credentials, receivedAt, unstored: false, rejected: false };
      await writeLoginCredentials(executionContext, operation, credentials, () => {
        state = undefined;
      });
      activateGeneration(operation, credentials, receivedAt);
      return operation;
    },
    logout() {
      timers.clear();
      config.scope.clear();
      state = undefined;
      return persistence.clearForGeneration(config.scope.generation);
    },
    async restore() {
      const generationBefore = config.scope.generation;
      const outcome = await persistence.readStored(generationBefore);
      if (outcome.status === 'stale') throw new SessionExpiredError();
      if (outcome.status === 'unreadable')
        return { status: 'unreadable', error: outcome.error };
      if (outcome.value === null) return { status: 'absent' };
      if (config.scope.generation !== generationBefore) throw new SessionExpiredError();
      const { session, credentials } = outcome.value;
      const operation = config.scope.replace(session);
      operation.assertCurrent();
      state = {
        operation,
        credentials,
        receivedAt: undefined,
        unstored: false,
        rejected: false,
      };
      activateGeneration(operation, credentials, undefined);
      return { status: 'present', operation };
    },
    read,
    refresh,
    async refreshIfDue(operation) {
      const credentials = read(operation);
      const current = state;
      if (
        !config.refreshAhead ||
        !current ||
        current.operation !== operation ||
        current.rejected
      ) {
        return undefined;
      }
      const expiresAt = readExpiresAt(credentials);
      if (!refreshDue(expiresAt, clock.now(), leadMs, current.receivedAt)) return undefined;
      if (flight?.operation === operation) return flight.result;
      if (!timers.cooldownPassed(operation, expiresAt, current.receivedAt)) return undefined;
      return refresh(operation);
    },
  };
}
