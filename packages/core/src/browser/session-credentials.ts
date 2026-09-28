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
  let state: { operation: SessionOperation<TSession>; credentials: TCredentials } | undefined;
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
      await config.storage.write(operation.context, credentials);
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
        if (config.scope.generation === generation) await config.storage.clear();
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
          await write(operation, next);
          read(operation);
          state = { operation, credentials: next };
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
