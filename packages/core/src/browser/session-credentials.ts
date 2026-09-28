import { withDeadline } from '../internal/deadline';
import { createMutationQueue } from '../internal/mutation-queue';
import { SessionExpiredError, type SessionOperation, type SessionScope } from './session';

export interface SessionCredentialsConfig<TSession, TCredentials> {
  readonly scope: SessionScope<TSession>;
  readonly refresh: (
    credentials: NoInfer<TCredentials>,
    signal: AbortSignal,
  ) => Promise<TCredentials>;
  readonly storage: {
    write(session: TSession, credentials: NoInfer<TCredentials>): Promise<void>;
    clear(): Promise<void>;
  };
  readonly maxPendingWrites?: number;
  readonly refreshTimeoutMs?: number;
  /**
   * How long one `storage.write` or `storage.clear` may hold the queue
   * (default 30 s). A hung write would otherwise keep `logout()` from ever
   * clearing what is persisted.
   */
  readonly storageTimeoutMs?: number;
}

export interface SessionCredentials<TSession, TCredentials> {
  login(session: TSession, credentials: TCredentials): Promise<SessionOperation<TSession>>;
  logout(): Promise<void>;
  read(operation: SessionOperation<TSession>): TCredentials;
  refresh(operation: SessionOperation<TSession>): Promise<TCredentials>;
}

/** Coordinates one client's memory and persistence. Cross-process CAS belongs to storage. */
export function createSessionCredentials<TSession, TCredentials>(
  config: SessionCredentialsConfig<TSession, TCredentials>,
): SessionCredentials<TSession, TCredentials> {
  const capacity = config.maxPendingWrites ?? 128;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536)
    throw new RangeError('maxPendingWrites must be between 1 and 65536');
  const serialize = createMutationQueue(capacity);
  const timeout = config.refreshTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000) {
    throw new RangeError('refreshTimeoutMs must be between 1 and 3600000');
  }
  const storageTimeout = config.storageTimeoutMs ?? 30_000;
  if (!Number.isInteger(storageTimeout) || storageTimeout < 1 || storageTimeout > 3_600_000) {
    throw new RangeError('storageTimeoutMs must be between 1 and 3600000');
  }
  let state: { operation: SessionOperation<TSession>; credentials: TCredentials } | undefined;
  /**
   * A storage call that outlived its deadline may still land — an old
   * session's credentials written after the logout that cleared them. When it
   * does, and memory has moved on from what it wrote, memory is written again
   * (or storage cleared). Each late call compares once, so a store that is
   * always slow converges instead of rewriting forever.
   */
  const bounded = async (
    work: Promise<void>,
    wrote: TCredentials | undefined,
  ): Promise<void> => {
    const outcome = await withDeadline(work, storageTimeout);
    if (outcome.settled) return;
    void work
      .then(() => {
        if (state?.credentials !== wrote) return restore();
      })
      .catch(() => undefined);
    throw new Error('Session storage did not answer within storageTimeoutMs');
  };
  const restore = (): Promise<void> =>
    serialize(async () => {
      const current = state;
      if (current)
        await bounded(
          config.storage.write(current.operation.context, current.credentials),
          current.credentials,
        );
      else await bounded(config.storage.clear(), undefined);
    });
  let flight:
    | { operation: SessionOperation<TSession>; result: Promise<TCredentials> }
    | undefined;
  const read = (operation: SessionOperation<TSession>): TCredentials => {
    if (!config.scope.owns(operation) || state?.operation !== operation)
      throw new SessionExpiredError();
    return state.credentials;
  };
  const write = (operation: SessionOperation<TSession>, credentials: TCredentials) =>
    serialize(async () => {
      read(operation);
      await bounded(config.storage.write(operation.context, credentials), credentials);
      operation.assertCurrent();
    });
  return {
    async login(session, credentials) {
      const operation = config.scope.replace(session);
      operation.assertCurrent();
      state = { operation, credentials };
      await write(operation, credentials);
      return operation;
    },
    logout() {
      config.scope.clear();
      state = undefined;
      const generation = config.scope.generation;
      return serialize(async () => {
        if (config.scope.generation === generation)
          await bounded(config.storage.clear(), undefined);
      });
    },
    read,
    refresh(operation) {
      const credentials = read(operation);
      if (flight?.operation === operation) return flight.result;
      const controller = new AbortController();
      const signal = AbortSignal.any([operation.signal, controller.signal]);
      const timer = setTimeout(
        () => controller.abort(new DOMException('Refresh timed out', 'TimeoutError')),
        timeout,
      );
      let onAbort: () => void = () => undefined;
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const result = operation
        .run(async () => {
          const next = await Promise.race([config.refresh(credentials, signal), abortPromise]);
          read(operation);
          // The server has issued these; with rotating tokens the old pair is
          // already spent. Memory takes them before persistence is tried, so a
          // slow or failing store cannot put the spent pair back.
          state = { operation, credentials: next };
          await write(operation, next);
          read(operation);
          return next;
        })
        .finally(() => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          if (flight?.result === result) flight = undefined;
        });
      flight = { operation, result };
      return result;
    },
  };
}
