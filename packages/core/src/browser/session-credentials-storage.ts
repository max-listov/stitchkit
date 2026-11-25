import { createMutationQueue } from '../internal/mutation-queue';
import { SessionExpiredError, type SessionOperation, type SessionScope } from './session';
import type { SessionClock } from './session-refresh-policy';

export interface ActiveSessionState<TSession, TCredentials> {
  readonly operation: SessionOperation<TSession>;
  credentials: TCredentials;
  receivedAt: number | undefined;
  unstored: boolean;
  rejected: boolean;
}

export interface SessionCredentialStorage<TSession, TCredentials> {
  read(): Promise<{ readonly session: TSession; readonly credentials: TCredentials } | null>;
  write(session: TSession, credentials: NoInfer<TCredentials>): Promise<void>;
  clear(): Promise<void>;
}

export type StoredReadOutcome<TSession, TCredentials> =
  | {
      readonly status: 'ok';
      readonly value: {
        readonly session: TSession;
        readonly credentials: TCredentials;
      } | null;
    }
  | { readonly status: 'unreadable'; readonly error: unknown }
  | { readonly status: 'stale' };

async function withClockDeadline(
  work: Promise<void>,
  timeoutMs: number,
  clock: SessionClock,
): Promise<{ readonly settled: true } | { readonly settled: false }> {
  let handle: { cancel(): void } | undefined;
  const expiry = new Promise<{ readonly settled: false }>((resolve) => {
    // `storageTimeoutMs` is at most an hour where it is taken: well inside one timer.
    handle = clock.schedule(() => resolve({ settled: false }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then((): { readonly settled: true } => ({ settled: true })),
      expiry,
    ]);
  } finally {
    handle?.cancel();
  }
}

/**
 * Serialized persistence queue with clock-bounded deadlines and late-write reconciliation.
 */
export function createCredentialPersistence<TSession, TCredentials>(ports: {
  readonly scope: SessionScope<TSession>;
  readonly storage: SessionCredentialStorage<TSession, TCredentials>;
  readonly clock: SessionClock;
  readonly capacity: number;
  readonly storageTimeout: number;
  readonly getState: () => ActiveSessionState<TSession, TCredentials> | undefined;
  readonly onConverged: () => void;
  readonly onRewriteFailed: (operation: SessionOperation<TSession>, error: unknown) => void;
}) {
  const serialize = createMutationQueue(ports.capacity);

  const bounded = async (
    work: Promise<void>,
    wrote: TCredentials | undefined,
    operation: SessionOperation<TSession> | undefined,
  ): Promise<void> => {
    const outcome = await withClockDeadline(work, ports.storageTimeout, ports.clock);
    if (outcome.settled) return;
    void work
      .then(() => {
        const current = ports.getState();
        if (
          operation &&
          ports.scope.owns(operation) &&
          current?.operation === operation &&
          current.credentials === wrote
        ) {
          current.unstored = false;
          ports.onConverged();
          return;
        }
        if (operation !== undefined || current !== undefined) {
          return rewriteStored().catch((error) => {
            const latest = ports.getState();
            if (latest && ports.scope.owns(latest.operation)) {
              ports.onRewriteFailed(latest.operation, error);
            }
          });
        }
      })
      .catch(() => undefined);
    throw new Error('Session storage did not answer within storageTimeoutMs');
  };

  const rewriteStored = (onlyIfUnstoredFor?: SessionOperation<TSession>): Promise<void> =>
    serialize(async () => {
      const current = ports.getState();
      if (onlyIfUnstoredFor) {
        if (!ports.scope.owns(onlyIfUnstoredFor) || current?.operation !== onlyIfUnstoredFor) {
          throw new SessionExpiredError();
        }
        if (!current.unstored) return;
      }
      if (current && ports.scope.owns(current.operation)) {
        const credentials = current.credentials;
        await bounded(
          ports.storage.write(current.operation.context, credentials),
          credentials,
          current.operation,
        );
        if (ports.getState() === current && current.credentials === credentials) {
          current.unstored = false;
          ports.onConverged();
        }
      } else {
        await bounded(ports.storage.clear(), undefined, undefined);
      }
    });

  const readStored = (
    generationBefore: number,
  ): Promise<StoredReadOutcome<TSession, TCredentials>> =>
    serialize(async () => {
      if (ports.scope.generation !== generationBefore) return { status: 'stale' };
      let loaded: { readonly session: TSession; readonly credentials: TCredentials } | null =
        null;
      try {
        const work = Promise.resolve()
          .then(() => ports.storage.read())
          .then((value) => {
            loaded = value;
          });
        const outcome = await withClockDeadline(work, ports.storageTimeout, ports.clock);
        if (!outcome.settled) {
          return {
            status: 'unreadable',
            error: new Error('Session storage did not answer within storageTimeoutMs'),
          };
        }
      } catch (error) {
        return { status: 'unreadable', error };
      }
      if (ports.scope.generation !== generationBefore) return { status: 'stale' };
      return { status: 'ok', value: loaded };
    });

  const write = (
    operation: SessionOperation<TSession>,
    credentials: TCredentials,
  ): Promise<void> =>
    serialize(async () => {
      const current = ports.getState();
      if (!ports.scope.owns(operation) || current?.operation !== operation) {
        throw new SessionExpiredError();
      }
      await bounded(
        ports.storage.write(operation.context, credentials),
        credentials,
        operation,
      );
      operation.assertCurrent();
    });

  const clearForGeneration = (generation: number): Promise<void> =>
    serialize(async () => {
      if (ports.scope.generation === generation) {
        await bounded(ports.storage.clear(), undefined, undefined);
      }
    });

  return { readStored, rewriteStored, write, clearForGeneration };
}
