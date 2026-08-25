import type { z } from 'zod';
import { AppError } from '../contract/errors';
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

/** The phase a managed resource failed in — the vocabulary of `failures`. */
export type ApplicationResourcePhase = ApplicationResourceShutdown['failures'][number];

interface ResourceRecord {
  readonly entry: ResolvedManagedResource;
  state: ManagedResourceState;
  health: ApplicationHealth;
  attempted: boolean;
  activated: boolean;
  closeInvoked: boolean;
  closed: boolean;
  runtime?: ManagedResourceStartResult;
  failures: ApplicationResourcePhase[];
}

class ResourceCompletionBeforeReadyError extends Error {
  constructor(resourceId: string, cause?: unknown) {
    super(`[stitchkit] resource "${resourceId}" completed before reaching readiness`, {
      ...(cause !== undefined && { cause }),
    });
    this.name = 'ResourceCompletionBeforeReadyError';
  }
}

/**
 * The kernel interrupting its own startup because a shutdown overtook it.
 *
 * Distinguished from a resource's error by type rather than by message, so the
 * failure observer can stay silent for it: nothing failed here, and reporting
 * it would bury the one failure that did. Everything else thrown out of a
 * startup phase is the resource's own and is reported.
 */
class ApplicationStartupInterruptedError extends Error {
  constructor() {
    super('[stitchkit] application startup interrupted by shutdown');
    this.name = 'ApplicationStartupInterruptedError';
  }
}

/** One resource failure with the cause the phase label cannot carry. */
export interface ApplicationResourceFailure {
  readonly resourceId: string;
  readonly phase: ApplicationResourcePhase;
  /** The value the resource actually threw or rejected with. */
  readonly error: unknown;
}

/**
 * The budgets an application shutdown accepts.
 *
 * The same two names the server and the agent runtime use, and only those:
 * `retryAfterSeconds` is an HTTP response concern that belongs to the managed
 * server resource, and accepting it here typed and validated an option nothing
 * in the kernel ever read.
 */
export const ApplicationShutdownOptionsSchema = ShutdownOptionsSchema.pick({
  gracePeriodMs: true,
  forceTimeoutMs: true,
  signal: true,
});
export type ApplicationShutdownOptions = z.input<typeof ApplicationShutdownOptionsSchema>;

export interface ApplicationConfig {
  readonly id: string;
  readonly resources?: readonly ManagedResource[];
  readonly onSnapshot?: (snapshot: ApplicationSnapshot) => void | Promise<void>;
  /**
   * Observe why a phase failed.
   *
   * `ApplicationResourceShutdown.failures` names the phase and nothing else, so
   * an operator reading it learns that `drain` failed and has no way to learn
   * why. The published response stays a verdict — this is the internal half of
   * the same rule: outward a generic answer, inward everything.
   *
   * Called for every failure of a resource's OWN code, in every phase:
   * `start`, `ready`, `completion`, `admission`, `drain`, `close` — including
   * the `close` that runs while rolling a failed startup back — and `force`.
   * It is NOT called for the kernel's own interruption of a startup that a
   * shutdown overtook: nothing failed there, and reporting it would bury the
   * one failure that did.
   *
   * A throwing observer cannot break the lifecycle it observes, and neither can
   * a REJECTING one: an `async` observer type-checks against a `void` return,
   * and its rejected promise is invisible to a synchronous `try/catch` around
   * the call. Returning a promise is therefore part of the signature, and the
   * kernel isolates it — it does not await it, so an observer cannot slow a
   * shutdown down either.
   */
  readonly onResourceFailure?: (failure: ApplicationResourceFailure) => void | Promise<void>;
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
  shutdown(options?: ApplicationShutdownOptions): Promise<ApplicationShutdownResult>;
}

/**
 * An `AppError`, not an `Error` with a `code` field on it.
 *
 * The difference is the whole point of the class: `normalizeError` starts with
 * `AppError.is(err)`, and a plain `Error` — however carefully it names its own
 * code — falls through to the generic branch and reaches the caller as
 * `INTERNAL_SERVER_ERROR` / 500. So the declared 503 never left the process,
 * `createErrorHook({ unmappedCode })` never saw the code, and a registry entry
 * proved only that the code existed, never that it travelled.
 */
export class ApplicationAdmissionError extends AppError<'APPLICATION_NOT_ACCEPTING'> {
  constructor() {
    super('APPLICATION_NOT_ACCEPTING', 'Application is not accepting new operations', 503);
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
  const reportFailure = (
    resourceId: string,
    phase: ApplicationResourcePhase,
    error: unknown,
  ): void => {
    if (!config.onResourceFailure) return;
    try {
      // The returned value is isolated, not awaited: an `async` observer's
      // rejection is invisible to this `try/catch`, and awaiting it would let a
      // slow observer extend a shutdown it only watches.
      void Promise.resolve(config.onResourceFailure({ resourceId, phase, error })).catch(
        () => undefined,
      );
    } catch {
      // A diagnostic observer cannot break the lifecycle it observes — the same
      // rule the snapshot listeners follow.
    }
  };

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

  /**
   * A long-lived resource that ended AFTER it was ready.
   *
   * `failure` used to be a boolean, and the value the resource rejected with —
   * in scope at the call site — was dropped on the floor. So a poller, a queue
   * consumer or a bot that died an hour after `start()` recorded the phase and
   * nothing else, while the documented contract said every failure of a
   * resource's own code reports its cause. The phase label is the half an
   * operator already has; the cause is the half they need.
   *
   * `undefined` means the resource simply finished, which is not a failure.
   */
  const markLateCompletion = (record: ResourceRecord, failure?: { error: unknown }): void => {
    if (shutdownRequested || record.state === 'stopping' || record.state === 'stopped') return;
    if (failure) {
      record.failures.push('completion');
      reportFailure(record.entry.id, 'completion', failure.error);
    }
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
        // Rolling a failed startup back is still the resource's own `close`
        // throwing. It was the one path that recorded the phase and dropped the
        // cause, which is exactly the half an operator needs: the startup error
        // is already in hand, and this says what went wrong cleaning up after it.
        reportFailure(entry.id, 'close', error);
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
          throw new ApplicationStartupInterruptedError();
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
            throw new ApplicationStartupInterruptedError();
          }
          if (isStartResult(started)) {
            record.runtime = started;
            let resourceReady = started.ready === undefined;
            let completionSettled = false;
            let completionFailure: unknown;
            const completion = started.completion?.then(
              () => {
                completionSettled = true;
                if (resourceReady) markLateCompletion(record);
              },
              (error: unknown) => {
                completionSettled = true;
                completionFailure = error;
                if (resourceReady) markLateCompletion(record, { error });
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
            throw new ApplicationStartupInterruptedError();
          }
          record.state = 'ready';
          record.health = 'healthy';
          publish();
        } catch (error) {
          // A shutdown arriving mid-startup does not make the resource's own
          // error stop being one. Only the kernel's own interruption is silent
          // here; anything the resource threw is recorded and reported, and
          // then re-thrown because the startup is over either way.
          const interrupted = shutdownRequested || startupAbort.signal.aborted;
          if (!(error instanceof ApplicationStartupInterruptedError)) {
            record.failures.push(
              error instanceof ResourceCompletionBeforeReadyError
                ? 'completion'
                : record.runtime?.ready
                  ? 'ready'
                  : 'start',
            );
            record.state = 'failed';
            record.health = 'unhealthy';
            reportFailure(
              entry.id,
              record.failures[record.failures.length - 1] ?? 'start',
              error,
            );
            publish();
          }
          if (interrupted || entry.required) throw error;
        }
      }

      lifecycle = 'ready';
      publish();
      for (const entry of ordered) {
        if (shutdownRequested || startupAbort.signal.aborted) {
          throw new ApplicationStartupInterruptedError();
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
            throw new ApplicationStartupInterruptedError();
          }
          record.activated = true;
          if (entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
            throw new Error(
              `[stitchkit] required resource "${entry.id}" lost readiness during activation`,
            );
          }
        } catch (error) {
          // Same rule as the phase above: only the kernel's own interruption is
          // silent, and a resource that threw while activating is reported.
          const interrupted = shutdownRequested || startupAbort.signal.aborted;
          if (!(error instanceof ApplicationStartupInterruptedError)) {
            record.failures.push('start');
            record.state = 'failed';
            record.health = 'unhealthy';
            reportFailure(entry.id, 'start', error);
            publish();
          }
          if (interrupted || entry.required) throw error;
        }
      }
      if (shutdownRequested) {
        throw new ApplicationStartupInterruptedError();
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

  const shutdown = (
    options?: ApplicationShutdownOptions,
  ): Promise<ApplicationShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;
    const parsed = ApplicationShutdownOptionsSchema.parse(options ?? {});
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
        } catch (error) {
          record.failures.push('admission');
          reportFailure(entry.id, 'admission', error);
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
        } catch (error) {
          record.failures.push('drain');
          reportFailure(entry.id, 'drain', error);
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
        } catch (error) {
          record.failures.push('close');
          reportFailure(entry.id, 'close', error);
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
                // Its `close` was already invoked and has not settled. There is
                // nothing left to call, so the record ends in `force-failed` —
                // and used to end there with no cause at all, which reads as an
                // unexplained failure rather than the timeout it is.
                record.failures.push('force');
                reportFailure(
                  entry.id,
                  'force',
                  new Error(
                    `[stitchkit] resource "${entry.id}" was already closing and did not settle before the force deadline`,
                  ),
                );
                return;
              }
              const forced = await untilDeadline(
                cleanup ?? Promise.resolve(),
                forceAbort.signal,
              );
              if (!forced.settled || forced.error !== undefined) {
                record.failures.push('force');
                reportFailure(
                  entry.id,
                  'force',
                  forced.settled
                    ? forced.error
                    : new Error('[stitchkit] forced cleanup did not settle in time'),
                );
                return;
              }
              record.closed = true;
              record.state = 'stopped';
            } catch (error) {
              record.failures.push('force');
              reportFailure(entry.id, 'force', error);
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
