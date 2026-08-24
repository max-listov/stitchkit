import type { ShutdownOptions } from '../server/shutdown';
import { ShutdownOptionsSchema } from '../server/shutdown';
import { type ResolvedManagedResource, resolveResourceGraph } from './graph';
import type {
  ManagedResource,
  ManagedResourceContext,
  ManagedResourceStartResult,
} from './resource';
import {
  type ApplicationHealth,
  ApplicationIdSchema,
  type ApplicationLifecycle,
  type ApplicationResourceShutdown,
  type ApplicationShutdownResult,
  ApplicationShutdownResultSchema,
  type ApplicationSnapshot,
  ApplicationSnapshotSchema,
  type ManagedResourceState,
} from './schemas';

type ResourceFailure = ApplicationResourceShutdown['failures'][number];

interface ResourceRecord {
  readonly entry: ResolvedManagedResource;
  state: ManagedResourceState;
  health: ApplicationHealth;
  attempted: boolean;
  activated: boolean;
  closeInvoked: boolean;
  closed: boolean;
  runtime?: ManagedResourceStartResult;
  failures: ResourceFailure[];
}

class ResourceCompletionBeforeReadyError extends Error {
  constructor(resourceId: string, cause?: unknown) {
    super(`[stitchkit] resource "${resourceId}" completed before reaching readiness`, {
      ...(cause !== undefined && { cause }),
    });
    this.name = 'ResourceCompletionBeforeReadyError';
  }
}

export interface ApplicationConfig {
  readonly id: string;
  readonly resources?: readonly ManagedResource[];
  readonly onSnapshot?: (snapshot: ApplicationSnapshot) => void | Promise<void>;
}

export interface ApplicationOperationLease {
  readonly released: boolean;
  release(): void;
}

export interface ApplicationAdmission {
  acquire(): ApplicationOperationLease | null;
  run<T>(work: () => T | Promise<T>): Promise<T>;
}

export interface ApplicationHandle {
  readonly id: string;
  readonly admission: ApplicationAdmission;
  start(): Promise<ApplicationSnapshot>;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: (snapshot: ApplicationSnapshot) => void): () => void;
  shutdown(options?: ShutdownOptions): Promise<ApplicationShutdownResult>;
}

export class ApplicationAdmissionError extends Error {
  readonly code = 'APPLICATION_NOT_ACCEPTING';

  constructor() {
    super('Application is not accepting new operations');
    this.name = 'ApplicationAdmissionError';
  }
}

function isStartResult(value: unknown): value is ManagedResourceStartResult {
  return typeof value === 'object' && value !== null;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function untilDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> {
  const result = await Promise.race([
    work.then(
      (value) => ({ settled: true, value }),
      (error: unknown) => ({ settled: true, error }),
    ),
    waitForAbort(signal).then(() => ({ settled: false })),
  ]);
  return result;
}

/** Compose process-local resources into one deterministic application lifetime. */
export function createApplication(config: ApplicationConfig): ApplicationHandle {
  const id = ApplicationIdSchema.parse(config.id);
  const ordered = resolveResourceGraph(config.resources ?? []);
  const reverse = [...ordered].reverse();
  const records = new Map<string, ResourceRecord>();
  for (const entry of ordered) {
    records.set(entry.id, {
      entry,
      state: 'registered',
      health: 'unknown',
      attempted: false,
      activated: false,
      closeInvoked: false,
      closed: false,
      failures: [],
    });
  }

  const epoch = crypto.randomUUID();
  const listeners = new Set<(snapshot: ApplicationSnapshot) => void>();
  const lifetimeAbort = new AbortController();
  const startupAbort = new AbortController();
  let lifecycle: ApplicationLifecycle = 'created';
  let revision = 0;
  let changedAt = new Date().toISOString();
  let accepting = false;
  let accepted = 0;
  let completed = 0;
  let pending = 0;
  let startPromise: Promise<ApplicationSnapshot> | undefined;
  let shutdownPromise: Promise<ApplicationShutdownResult> | undefined;
  let shutdownRequested = false;
  let activationComplete = false;
  const pendingWaiters = new Set<() => void>();

  const aggregateHealth = (): ApplicationHealth => {
    if (lifecycle === 'created' || lifecycle === 'starting') return 'unknown';
    let optionalUnhealthy = false;
    for (const record of records.values()) {
      if (record.entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
        return 'unhealthy';
      }
      if (
        !record.entry.required &&
        (record.state !== 'ready' || record.health !== 'healthy')
      ) {
        optionalUnhealthy = true;
      }
    }
    return optionalUnhealthy ? 'degraded' : 'healthy';
  };

  const isReady = (): boolean =>
    lifecycle === 'ready' &&
    [...records.values()].every(
      (record) =>
        !record.entry.required || (record.state === 'ready' && record.health === 'healthy'),
    );

  const snapshot = (): ApplicationSnapshot =>
    ApplicationSnapshotSchema.parse({
      id,
      epoch,
      revision,
      lifecycle,
      health: aggregateHealth(),
      ready: isReady(),
      capturedAt: new Date().toISOString(),
      changedAt,
      admission: { accepting, accepted, completed, pending },
      resources: ordered.map((entry) => {
        const record = records.get(entry.id);
        if (!record) throw new Error('Managed resource record disappeared');
        return {
          id: entry.id,
          required: entry.required,
          dependsOn: entry.dependsOn,
          state: record.state,
          health: record.health,
          ready: record.state === 'ready' && record.health === 'healthy',
        };
      }),
    });

  const publish = (): void => {
    revision += 1;
    changedAt = new Date().toISOString();
    const value = snapshot();
    for (const listener of listeners) {
      try {
        listener(value);
      } catch {
        // State observers cannot break the lifecycle they observe.
      }
    }
    if (config.onSnapshot) {
      void Promise.resolve()
        .then(() => config.onSnapshot?.(value))
        .catch(() => {
          // Sync and async state observers are equally isolated.
        });
    }
  };

  const contextFor = (
    record: ResourceRecord,
    options: { signal?: AbortSignal; deadlineAt?: number; forceDeadlineAt?: number } = {},
  ): ManagedResourceContext => ({
    applicationId: id,
    signal: options.signal ?? lifetimeAbort.signal,
    ...(options.deadlineAt !== undefined && { deadlineAt: options.deadlineAt }),
    ...(options.forceDeadlineAt !== undefined && {
      forceDeadlineAt: options.forceDeadlineAt,
    }),
    now: () => performance.now(),
    reportHealth(health) {
      if (record.state === 'stopped') return;
      record.health = health;
      accepting = activationComplete && !shutdownRequested && isReady();
      publish();
    },
  });

  const markLateCompletion = (record: ResourceRecord, failure: boolean): void => {
    if (shutdownRequested || record.state === 'stopping' || record.state === 'stopped') return;
    if (failure) record.failures.push('completion');
    record.state = 'failed';
    record.health = 'unhealthy';
    accepting = activationComplete && isReady();
    publish();
  };

  const closeAttempted = async (): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const entry of reverse) {
      const record = records.get(entry.id);
      if (!record?.attempted || record.closed) continue;
      record.state = 'stopping';
      try {
        record.closeInvoked = true;
        await entry.resource.close?.(contextFor(record, { signal: startupAbort.signal }));
        record.closed = true;
        record.state = 'stopped';
      } catch (error) {
        record.failures.push('close');
        record.state = 'failed';
        errors.push(error);
      }
      publish();
    }
    return errors;
  };

  const runStart = async (): Promise<ApplicationSnapshot> => {
    lifecycle = 'starting';
    publish();
    let startFailure: unknown;
    try {
      for (const entry of ordered) {
        if (shutdownRequested || startupAbort.signal.aborted) {
          throw new Error('[stitchkit] application startup interrupted by shutdown');
        }
        const record = records.get(entry.id);
        if (!record) throw new Error('Managed resource record disappeared');
        const dependencyFailed = entry.dependsOn.some(
          (dependencyId) => records.get(dependencyId)?.state !== 'ready',
        );
        if (dependencyFailed) {
          record.state = 'failed';
          record.health = 'unhealthy';
          record.failures.push('start');
          publish();
          if (entry.required) {
            throw new Error(
              `[stitchkit] required resource "${entry.id}" has an unavailable dependency`,
            );
          }
          continue;
        }
        record.attempted = true;
        record.state = 'starting';
        publish();
        try {
          const started = await entry.resource.start(
            contextFor(record, { signal: startupAbort.signal }),
          );
          if (shutdownRequested || startupAbort.signal.aborted) {
            throw new Error('[stitchkit] application startup interrupted by shutdown');
          }
          if (isStartResult(started)) {
            record.runtime = started;
            let resourceReady = started.ready === undefined;
            let completionSettled = false;
            let completionFailure: unknown;
            const completion = started.completion?.then(
              () => {
                completionSettled = true;
                if (resourceReady) markLateCompletion(record, false);
              },
              (error: unknown) => {
                completionSettled = true;
                completionFailure = error;
                if (resourceReady) markLateCompletion(record, true);
              },
            );
            if (started.ready && completion) {
              const readiness: Promise<'ready'> = started.ready.then(() => 'ready');
              const completionBeforeReady: Promise<'completion'> = completion.then(
                () => 'completion',
              );
              const first = await Promise.race([readiness, completionBeforeReady]);
              if (first === 'completion') {
                throw new ResourceCompletionBeforeReadyError(entry.id, completionFailure);
              }
              resourceReady = true;
              if (completionSettled) {
                throw new ResourceCompletionBeforeReadyError(entry.id, completionFailure);
              }
            } else if (started.ready) {
              await started.ready;
              resourceReady = true;
            } else if (completion) {
              void completion;
            }
          }
          if (shutdownRequested || startupAbort.signal.aborted) {
            throw new Error('[stitchkit] application startup interrupted by shutdown');
          }
          record.state = 'ready';
          record.health = 'healthy';
          publish();
        } catch (error) {
          if (shutdownRequested || startupAbort.signal.aborted) throw error;
          record.failures.push(
            error instanceof ResourceCompletionBeforeReadyError
              ? 'completion'
              : record.runtime?.ready
                ? 'ready'
                : 'start',
          );
          record.state = 'failed';
          record.health = 'unhealthy';
          publish();
          if (entry.required) throw error;
        }
      }

      lifecycle = 'ready';
      publish();
      for (const entry of ordered) {
        if (shutdownRequested || startupAbort.signal.aborted) {
          throw new Error('[stitchkit] application startup interrupted by shutdown');
        }
        const record = records.get(entry.id);
        if (record?.state !== 'ready') continue;
        const dependencyUnavailable = entry.dependsOn.some((dependencyId) => {
          const dependency = records.get(dependencyId);
          return dependency?.state !== 'ready' || !dependency.activated;
        });
        if (dependencyUnavailable) {
          record.failures.push('start');
          record.state = 'failed';
          record.health = 'unhealthy';
          publish();
          if (entry.required) {
            throw new Error(
              `[stitchkit] required resource "${entry.id}" has an unavailable activation dependency`,
            );
          }
          continue;
        }
        try {
          await entry.resource.activate?.(contextFor(record));
          if (shutdownRequested || startupAbort.signal.aborted) {
            throw new Error('[stitchkit] application startup interrupted by shutdown');
          }
          record.activated = true;
          if (entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
            throw new Error(
              `[stitchkit] required resource "${entry.id}" lost readiness during activation`,
            );
          }
        } catch (error) {
          if (shutdownRequested || startupAbort.signal.aborted) throw error;
          record.failures.push('start');
          record.state = 'failed';
          record.health = 'unhealthy';
          publish();
          if (entry.required) throw error;
        }
      }
      if (shutdownRequested) {
        throw new Error('[stitchkit] application startup interrupted by shutdown');
      }
      if (!isReady()) {
        throw new Error('[stitchkit] a required resource lost readiness during startup');
      }
      activationComplete = true;
      accepting = isReady();
      publish();
      return snapshot();
    } catch (error) {
      startFailure = error;
    }

    if (!shutdownRequested) {
      const rollbackErrors = await closeAttempted();
      lifecycle = 'failed';
      accepting = false;
      publish();
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [startFailure, ...rollbackErrors],
          '[stitchkit] application startup and rollback failed',
          { cause: startFailure },
        );
      }
    }
    throw startFailure;
  };

  const start = (): Promise<ApplicationSnapshot> => {
    if (startPromise) return startPromise;
    if (lifecycle !== 'created') {
      return Promise.reject(
        new Error(`[stitchkit] application cannot start from lifecycle "${lifecycle}"`),
      );
    }
    startPromise = runStart();
    void startPromise.catch(() => undefined);
    return startPromise;
  };

  const acquire = (): ApplicationOperationLease | null => {
    if (!accepting || !isReady()) return null;
    accepted += 1;
    pending += 1;
    publish();
    let released = false;
    return {
      get released() {
        return released;
      },
      release() {
        if (released) return;
        released = true;
        pending -= 1;
        completed += 1;
        if (pending === 0) {
          for (const waiter of pendingWaiters) waiter();
          pendingWaiters.clear();
        }
        publish();
      },
    };
  };

  const run = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const lease = acquire();
    if (!lease) throw new ApplicationAdmissionError();
    try {
      return await work();
    } finally {
      lease.release();
    }
  };

  const waitForPending = (): Promise<void> => {
    if (pending === 0) return Promise.resolve();
    return new Promise((resolve) => pendingWaiters.add(resolve));
  };

  const shutdown = (options?: ShutdownOptions): Promise<ApplicationShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;
    const parsed = ShutdownOptionsSchema.parse(options ?? {});
    const startedAt = performance.now();
    const graceDeadlineAt = startedAt + parsed.gracePeriodMs;
    const forceDeadlineAt = graceDeadlineAt + parsed.forceTimeoutMs;
    shutdownRequested = true;
    accepting = false;
    startupAbort.abort();
    lifecycle = lifecycle === 'created' ? 'stopping' : 'draining';
    publish();

    shutdownPromise = (async () => {
      const gracefulAbort = new AbortController();
      let forcedReason: 'deadline' | 'signal' | undefined;
      let gracefulFailed = [...records.values()].some(
        (record) => record.attempted && record.closeInvoked && !record.closed,
      );
      const force = (reason: 'deadline' | 'signal'): void => {
        if (forcedReason) return;
        forcedReason = reason;
        gracefulAbort.abort();
        lifetimeAbort.abort();
      };
      const graceTimer = setTimeout(
        () => force('deadline'),
        Math.max(0, graceDeadlineAt - performance.now()),
      );
      const onExternalAbort = (): void => force('signal');
      parsed.signal?.addEventListener('abort', onExternalAbort, { once: true });
      if (parsed.signal?.aborted) force('signal');

      if (startPromise) {
        await untilDeadline(
          startPromise.catch(() => undefined),
          gracefulAbort.signal,
        );
      }

      const gracefulContext = (record: ResourceRecord): ManagedResourceContext =>
        contextFor(record, {
          signal: gracefulAbort.signal,
          deadlineAt: graceDeadlineAt,
          forceDeadlineAt,
        });

      for (const entry of reverse) {
        if (gracefulAbort.signal.aborted) break;
        const record = records.get(entry.id);
        if (!record?.attempted || record.closed) continue;
        try {
          const result = await untilDeadline(
            Promise.resolve(entry.resource.stopAdmission?.(gracefulContext(record))),
            gracefulAbort.signal,
          );
          if (!result.settled) break;
          if (result.error !== undefined) throw result.error;
        } catch {
          record.failures.push('admission');
          gracefulFailed = true;
          lifetimeAbort.abort();
        }
      }

      if (!gracefulAbort.signal.aborted && !gracefulFailed) {
        const result = await untilDeadline(waitForPending(), gracefulAbort.signal);
        if (!result.settled) force('deadline');
      }

      for (const entry of reverse) {
        if (gracefulAbort.signal.aborted || gracefulFailed) break;
        const record = records.get(entry.id);
        if (!record?.attempted || record.closed) continue;
        record.state = 'stopping';
        publish();
        try {
          const drained = await untilDeadline(
            Promise.resolve(entry.resource.drain?.(gracefulContext(record))),
            gracefulAbort.signal,
          );
          if (!drained.settled) {
            force('deadline');
            break;
          }
          if (drained.error !== undefined) throw drained.error;
        } catch {
          record.failures.push('drain');
          gracefulFailed = true;
          lifetimeAbort.abort();
          break;
        }
      }

      lifecycle = 'stopping';
      publish();
      for (const entry of reverse) {
        if (gracefulAbort.signal.aborted || gracefulFailed) break;
        const record = records.get(entry.id);
        if (!record?.attempted || record.closed || record.closeInvoked) continue;
        try {
          record.closeInvoked = true;
          const closed = await untilDeadline(
            Promise.resolve(entry.resource.close?.(gracefulContext(record))),
            gracefulAbort.signal,
          );
          if (!closed.settled) {
            force('deadline');
            break;
          }
          if (closed.error !== undefined) throw closed.error;
          record.closed = true;
          record.state = 'stopped';
          publish();
        } catch {
          record.failures.push('close');
          record.state = 'failed';
          gracefulFailed = true;
          lifetimeAbort.abort();
          publish();
          break;
        }
      }

      clearTimeout(graceTimer);
      parsed.signal?.removeEventListener('abort', onExternalAbort);
      const mustForce = forcedReason !== undefined || gracefulFailed;
      const pendingOperationsAtForce = mustForce ? pending : 0;
      if (mustForce) {
        lifetimeAbort.abort();
        const forceAbort = new AbortController();
        const forceTimer = setTimeout(
          () => forceAbort.abort(),
          Math.max(0, forceDeadlineAt - performance.now()),
        );
        await Promise.all(
          reverse.map(async (entry) => {
            const record = records.get(entry.id);
            if (!record?.attempted || record.closed) return;
            try {
              let cleanup: Promise<void> | undefined;
              if (entry.resource.force) {
                cleanup = Promise.resolve(
                  entry.resource.force(
                    contextFor(record, {
                      signal: forceAbort.signal,
                      deadlineAt: graceDeadlineAt,
                      forceDeadlineAt,
                    }),
                  ),
                );
              } else if (entry.resource.close && !record.closeInvoked) {
                record.closeInvoked = true;
                cleanup = Promise.resolve(
                  entry.resource.close(
                    contextFor(record, {
                      signal: forceAbort.signal,
                      deadlineAt: graceDeadlineAt,
                      forceDeadlineAt,
                    }),
                  ),
                );
              } else if (entry.resource.close) {
                record.failures.push('force');
                return;
              }
              const forced = await untilDeadline(
                cleanup ?? Promise.resolve(),
                forceAbort.signal,
              );
              if (!forced.settled || forced.error !== undefined) {
                record.failures.push('force');
                return;
              }
              record.closed = true;
              record.state = 'stopped';
            } catch {
              record.failures.push('force');
            }
          }),
        );
        clearTimeout(forceTimer);
      }

      const cleanupComplete = [...records.values()].every(
        (record) => !record.attempted || record.closed,
      );
      lifecycle = cleanupComplete ? 'stopped' : 'failed';
      publish();
      return ApplicationShutdownResultSchema.parse({
        outcome: mustForce ? 'forced' : 'clean',
        ...(forcedReason && { reason: forcedReason }),
        cleanupComplete,
        acceptedOperations: accepted,
        completedOperations: completed,
        pendingOperations: pending,
        pendingOperationsAtForce,
        resources: ordered.map((entry) => {
          const record = records.get(entry.id);
          if (!record) throw new Error('Managed resource record disappeared');
          return {
            id: entry.id,
            state: !record.attempted
              ? 'not-started'
              : record.closed
                ? 'closed'
                : 'force-failed',
            failures: record.failures,
          };
        }),
        durationMs: performance.now() - startedAt,
      });
    })();
    void shutdownPromise.catch(() => undefined);
    return shutdownPromise;
  };

  return {
    id,
    admission: { acquire, run },
    start,
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    shutdown,
  };
}
