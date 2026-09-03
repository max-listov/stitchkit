import { z } from 'zod';
import { AppError } from '../contract/errors';
import { ShutdownOptionsSchema } from '../server/shutdown';
import { type ResolvedManagedResource, resolveResourceGraph } from './graph';
import type {
  ManagedResource,
  ManagedResourceContext,
  ManagedResourcePublished,
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
  /**
   * Whether the resource itself has said something about its health.
   *
   * Becoming ready used to assign `healthy` unconditionally, which threw away
   * whatever `reportHealth` had been told during `start`. It was hard to notice
   * because the guide's own minimal example reports `healthy` — the same value
   * that overwrote it — so the example appeared to work and taught the habit.
   * For a resource that starts DEGRADED on purpose (up, but still dialling
   * something external) the report vanished and the resource looked healthy
   * from outside: an API that accepts a value and silently discards it, which
   * is the worst shape a failure can take.
   */
  healthReported: boolean;
  /**
   * Whether this resource was healthy at any point.
   *
   * The discriminator the two refusal messages need, and neither
   * `healthReported` nor "health before activation" is it: both are true of a
   * database that started fine and then dropped, and of a resource that
   * deliberately started degraded. Telling the first "put it behind
   * `required: false`" is the worst possible advice, and telling the second it
   * "lost readiness" points at something that never happened.
   */
  everHealthy: boolean;
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

/**
 * The budget this application spends on stopping — and the one thing a failed
 * startup's rollback had no way to know.
 *
 * A rollback happens inside `start()`, so there is no call for a caller to pass
 * options to. The budget therefore has to be declared where the application is,
 * and once it is declared there it is also the sensible default for
 * `shutdown()` with no options: one number for "how long this application may
 * take to stop", not two that can disagree.
 *
 * `signal` is deliberately absent. A budget is a property of the application; a
 * signal belongs to the one call that carries it.
 */
export const ApplicationShutdownBudgetSchema = ShutdownOptionsSchema.pick({
  gracePeriodMs: true,
  forceTimeoutMs: true,
});
export type ApplicationShutdownBudget = z.input<typeof ApplicationShutdownBudgetSchema>;

export interface ApplicationConfig {
  readonly id: string;
  readonly resources?: readonly ManagedResource[];
  /**
   * How long stopping may take — for `shutdown()` called with no options, and
   * for the rollback of a failed `start()`, which has no other way to be told.
   */
  readonly shutdown?: ApplicationShutdownBudget;
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

export const ApplicationRestartInputSchema = z
  .object({
    resourceId: z.string().min(1),
    /**
     * Optional overrides of the application shutdown budget, for this restart.
     *
     * A restart takes its subtree down through the same three phases a shutdown
     * does, so it asks the same budget question and defaults to the same answer.
     * Naming one here is for the case a caller knows this subtree drains faster
     * than the process is allowed to.
     */
    gracePeriodMs: z.number().int().nonnegative().optional(),
    forceTimeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .readonly();
export type ApplicationRestartInput = z.infer<typeof ApplicationRestartInputSchema>;

export const ApplicationRestartOutcomeSchema = z.enum(['restarted', 'failed', 'refused']);
export type ApplicationRestartOutcome = z.infer<typeof ApplicationRestartOutcomeSchema>;

export const ApplicationRestartResultSchema = z
  .object({
    /** The resource that was asked for. */
    resourceId: z.string(),
    /**
     * Everything that was actually taken down and brought back, in start order:
     * the resource named, and every resource that depends on it transitively.
     *
     * A dependant that kept running while the thing under it was replaced would
     * be holding a handle to a closed generation — which is why the subtree,
     * and not the resource, is the unit.
     */
    affected: z.array(z.string()).readonly(),
    outcome: ApplicationRestartOutcomeSchema,
    /** Present on `failed` and `refused` — never on success. */
    reason: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type ApplicationRestartResult = z.infer<typeof ApplicationRestartResultSchema>;

export interface ApplicationHandle {
  readonly id: string;
  readonly admission: ApplicationAdmission;
  start(): Promise<ApplicationSnapshot>;
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: (snapshot: ApplicationSnapshot) => void): () => void;
  shutdown(options?: ApplicationShutdownOptions): Promise<ApplicationShutdownResult>;
  /**
   * Replace one resource and everything that depends on it, leaving the rest of
   * the graph running and the process epoch unchanged.
   *
   * Serialised against itself and refused during shutdown: two restarts of
   * overlapping subtrees, or a restart racing the way down, are the two ways to
   * end up with two live generations of one resource — which is the failure this
   * exists to make impossible, not merely unlikely.
   */
  restart(input: ApplicationRestartInput): Promise<ApplicationRestartResult>;
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
  const shutdownBudget = ApplicationShutdownBudgetSchema.parse(config.shutdown ?? {});
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

  /**
   * What each resource handed to its dependants, kept for the application's
   * whole life rather than only until readiness: a dependant may still need the
   * handle it was given while it drains, and dropping it at the end of startup
   * would make `use()` work in `start` and fail in `close`.
   */
  const published = new Map<string, unknown>();

  const records = new Map<string, ResourceRecord>();
  for (const entry of ordered) {
    records.set(entry.id, {
      entry,
      state: 'registered',
      health: 'unknown',
      healthReported: false,
      everHealthy: false,
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

  /** The subtree a restart is replacing right now — empty between restarts. */
  let restartingIds: readonly string[] = [];

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
      restarting: [...restartingIds],
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
    use<TResource extends ManagedResource>(resource: TResource) {
      const dependencyId = resource?.id;
      if (typeof dependencyId !== 'string' || dependencyId.length === 0) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}": use() takes a managed resource, and this one has no id`,
        );
      }
      // Declared-first, on purpose. Reading a value the graph was never told
      // about is an ordering bug that happens to work today: nothing makes the
      // owner start first, so it breaks the moment declaration order changes.
      if (!record.entry.dependsOn.includes(dependencyId)) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}" used "${dependencyId}" without declaring it in dependsOn`,
        );
      }
      if (!published.has(dependencyId)) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}" used "${dependencyId}", which published no value from start()`,
        );
      }
      // Boundary: the store is one untyped map for the whole graph, while the
      // signature's type is computed from the caller's own literal resource
      // type. There is no representation that is both, so the bridge is here
      // and nowhere else.
      return published.get(dependencyId) as ManagedResourcePublished<TResource>;
    },
    reportHealth(health) {
      if (record.state === 'stopped') return;
      record.health = health;
      record.healthReported = true;
      if (health === 'healthy') record.everHealthy = true;
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
    // Rolling back a failed startup is not a full shutdown — it runs `close`
    // and only `close`, one phase of five — but it is still a stopping path,
    // and it needs the deadlines every other stopping path gets. Without them a resource reading
    // `deadlineAt` sees nothing, and the honest arithmetic — `now - now` — comes
    // out as ZERO: `managedServerResource` then handed its server
    // `{ gracePeriodMs: 0, forceTimeoutMs: 0 }`, an immediate hard abort of
    // requests already in flight, on a path nobody chose to be on.
    //
    // The absence of a deadline means "none was given", not "no time". So the
    // rollback spends the application's declared budget — the same one
    // `shutdown()` spends — and the ceiling costs nothing when there is nothing
    // to drain: a grace period is a deadline, not a sleep, and `shutdown`
    // returns as soon as the last request finishes. What it DOES cost is a
    // failed startup with a request that never finishes: that used to be
    // reported in milliseconds and now waits out the budget. An application
    // that would rather hear about a broken start immediately says so —
    // `createApplication({ shutdown: { gracePeriodMs: 0 } })` — which is also
    // the only way this bound is testable in less than the budget.
    const rollbackStartedAt = performance.now();
    const rollbackDeadlineAt = rollbackStartedAt + shutdownBudget.gracePeriodMs;
    const rollbackForceDeadlineAt = rollbackDeadlineAt + shutdownBudget.forceTimeoutMs;
    // And ENFORCED, not merely handed out. A deadline a loop does not watch is a
    // number, not a bound: `close` is the only phase a rollback runs, nothing
    // wraps it, and a resource whose `close` never returns — a poller awaiting
    // its own completion, a consumer resource with a hung upstream — stopped a
    // failed startup from ever reporting why it failed. Passing budgets without
    // this timer would have moved that hang from "forever" to "forever", while
    // reading as if it were fixed.
    const rollbackAbort = new AbortController();
    const rollbackTimer = setTimeout(
      () => rollbackAbort.abort(),
      Math.max(0, rollbackForceDeadlineAt - performance.now()),
    );
    try {
      await closeEachAttempted(rollbackAbort.signal, errors, {
        deadlineAt: rollbackDeadlineAt,
        forceDeadlineAt: rollbackForceDeadlineAt,
      });
    } finally {
      clearTimeout(rollbackTimer);
    }
    return errors;
  };

  /** The reverse-order `close` sweep a rollback runs, bounded by `signal`. */
  const closeEachAttempted = async (
    bound: AbortSignal,
    errors: unknown[],
    deadlines: { deadlineAt: number; forceDeadlineAt: number },
  ): Promise<void> => {
    for (const entry of reverse) {
      const record = records.get(entry.id);
      if (!record?.attempted || record.closed) continue;
      record.state = 'stopping';
      try {
        record.closeInvoked = true;
        const settled = await untilDeadline(
          Promise.resolve(
            entry.resource.close?.(
              contextFor(record, { signal: startupAbort.signal, ...deadlines }),
            ),
          ),
          bound,
        );
        if (!settled.settled) {
          // The budget ran out with this resource still closing. Reported as a
          // close failure, because that is what it is — and the startup cause
          // stays the `cause` of the AggregateError either way.
          record.failures.push('close');
          record.state = 'failed';
          const timedOut = new Error(
            `[stitchkit] resource "${entry.id}" did not finish closing during rollback`,
          );
          reportFailure(entry.id, 'close', timedOut);
          errors.push(timedOut);
          publish();
          break;
        }
        if (settled.error !== undefined) throw settled.error;
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
  };

  /**
   * Start these resources, in order.
   *
   * Extracted so a subtree restart runs the SAME code as a full startup
   * rather than a second copy of it. Only two things differ between the two
   * callers: which resources are being started, and whose abort signal ends
   * the attempt. Everything a resource can do on the way up — publish a value
   * before readiness, settle its completion first, report its own health —
   * is behaviour a restart has to reproduce exactly, and the only way to be
   * sure it does is for there to be one implementation.
   */
  const startEach = async (
    entries: readonly ResolvedManagedResource[],
    signal: AbortSignal,
  ): Promise<void> => {
    for (const entry of entries) {
      if (shutdownRequested || signal.aborted) {
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
        const started = await entry.resource.start(contextFor(record, { signal: signal }));
        if (shutdownRequested || signal.aborted) {
          throw new ApplicationStartupInterruptedError();
        }
        if (isStartResult(started)) {
          record.runtime = started;
          // Published before readiness is awaited: a dependant only runs after
          // this resource reaches `ready`, and a resource that reports its own
          // readiness asynchronously still handed the value over here.
          if (started.value !== undefined) published.set(entry.id, started.value);
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
        if (shutdownRequested || signal.aborted) {
          throw new ApplicationStartupInterruptedError();
        }
        record.state = 'ready';
        // Only when the resource said nothing. A resource that reported its
        // own health during `start` has already answered this question, and
        // the answer is more specific than the default.
        if (!record.healthReported) {
          record.health = 'healthy';
          record.everHealthy = true;
        }
        publish();
      } catch (error) {
        // A shutdown arriving mid-startup does not make the resource's own
        // error stop being one. Only the kernel's own interruption is silent
        // here; anything the resource threw is recorded and reported, and
        // then re-thrown because the startup is over either way.
        const interrupted = shutdownRequested || signal.aborted;
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
  };

  /** Activate these resources, in order. Same reasoning as `startEach`. */
  const activateEach = async (
    entries: readonly ResolvedManagedResource[],
    signal: AbortSignal,
  ): Promise<void> => {
    for (const entry of entries) {
      if (shutdownRequested || signal.aborted) {
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
        // The check still fires for every required resource that is not ready
        // and healthy after activating — that is what pushes the phase onto
        // `failures`, calls `onResourceFailure`, and stops the cascade before
        // the next resource's `activate` arms a schedule or opens a long
        // poll. Loosening it to "lost it" alone kept the startup failing (the
        // final readiness gate still refuses) but reported no phase for it and
        // let every downstream activation run first.
        //
        // Only the WORDING depends on history: this test read "lost
        // readiness" when becoming ready assigned `healthy` unconditionally,
        // and a resource that reported `degraded` during `start` would
        // otherwise be told it lost something it never had.
        await entry.resource.activate?.(contextFor(record));
        if (shutdownRequested || signal.aborted) {
          throw new ApplicationStartupInterruptedError();
        }
        record.activated = true;
        if (entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
          const observed = `${record.state}/${record.health}`;
          throw new Error(
            record.everHealthy
              ? `[stitchkit] required resource "${entry.id}" lost readiness during activation (${observed})`
              : `[stitchkit] required resource "${entry.id}" is not healthy (${observed}). A required resource must be healthy for the application to be ready; a resource that is expected to start degraded belongs behind \`required: false\`.`,
          );
        }
      } catch (error) {
        // Same rule as the phase above: only the kernel's own interruption is
        // silent, and a resource that threw while activating is reported.
        const interrupted = shutdownRequested || signal.aborted;
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
  };

  /** The resource named, plus every resource that transitively depends on it. */
  const subtreeOf = (resourceId: string): readonly ResolvedManagedResource[] => {
    const affected = new Set([resourceId]);
    // One forward pass is enough because `ordered` is topological: a dependant
    // always appears after everything it depends on.
    for (const entry of ordered) {
      if (entry.dependsOn.some((dependencyId) => affected.has(dependencyId))) {
        affected.add(entry.id);
      }
    }
    return ordered.filter((entry) => affected.has(entry.id));
  };

  /** Take one resource down through its own phases, then forget its generation. */
  const closeOne = async (
    entry: ResolvedManagedResource,
    record: ResourceRecord,
    signal: AbortSignal,
    deadlines: { deadlineAt: number; forceDeadlineAt: number },
  ): Promise<void> => {
    const context = () => contextFor(record, { ...deadlines, signal });
    if (record.attempted && !record.closed) {
      // Bounded, like every other path that takes a resource down — and bounded
      // by a signal an actual timer fires, not by a number nobody watches. One
      // `drain()` awaiting work that never finishes used to hang the restart for
      // the life of the process, and because restarts are serialised it hung
      // every restart queued behind it too.
      const phase = async (work: unknown, what: string): Promise<void> => {
        const settled = await untilDeadline(Promise.resolve(work), signal);
        if (!settled.settled) {
          throw new Error(
            `[stitchkit] resource "${entry.id}" did not ${what} within the restart budget`,
          );
        }
        if (settled.error !== undefined) throw settled.error;
      };
      await phase(entry.resource.stopAdmission?.(context()), 'stop admitting');
      await phase(entry.resource.drain?.(context()), 'drain');
      record.closeInvoked = true;
      await phase(entry.resource.close?.(context()), 'close');
    }
    // Every trace of the old generation goes, including the value it published:
    // a dependant that started again must `use()` the NEW handle, and leaving
    // the old one behind is how a restart quietly hands back a closed resource.
    //
    // `closed` goes back to FALSE rather than staying true, because the record
    // now describes a registered resource that has not been started — not one
    // the shutdown has already dealt with. Left true, the resource comes back
    // up and is then skipped on the way down: a live generation the shutdown
    // believes it has already closed.
    record.closed = false;
    record.closeInvoked = false;
    record.attempted = false;
    record.activated = false;
    record.state = 'registered';
    record.health = 'unknown';
    record.healthReported = false;
    record.runtime = undefined;
    // `failures` and `everHealthy` deliberately survive: they are the process's
    // history, not this generation's state, and the shutdown report is the one
    // place a failure that was later restarted away is still visible.
    published.delete(entry.id);
  };

  let restarting: Promise<unknown> = Promise.resolve();

  const runRestart = async (
    input: ApplicationRestartInput,
  ): Promise<ApplicationRestartResult> => {
    const startedAt = Date.now();
    const parsed = ApplicationRestartInputSchema.parse(input);
    const affected = subtreeOf(parsed.resourceId);
    const affectedIds = affected.map((entry) => entry.id);
    const refuse = (reason: string): ApplicationRestartResult => ({
      resourceId: parsed.resourceId,
      affected: affectedIds,
      outcome: 'refused',
      reason,
      durationMs: Date.now() - startedAt,
    });

    if (!records.has(parsed.resourceId)) {
      return refuse(`no resource is registered as "${parsed.resourceId}"`);
    }
    if (shutdownRequested) {
      return refuse('the application is shutting down');
    }
    if (lifecycle !== 'ready') {
      return refuse(`the application is ${lifecycle}, not ready`);
    }

    // The application's own shutdown budget, unless this call names another.
    // A restart takes resources down through the same three phases a shutdown
    // does, so it is the same budget question, and inventing a second default
    // would mean two numbers to keep in agreement.
    // Per field, starting from the application's own budget. Re-parsing a
    // partial input instead would let a caller who named only one of the two
    // silently take the SCHEMA default for the other, rather than the budget
    // this application was configured with — a declared option quietly not
    // honoured, which is the defect this repository fails most often.
    const budget = {
      gracePeriodMs: parsed.gracePeriodMs ?? shutdownBudget.gracePeriodMs,
      forceTimeoutMs: parsed.forceTimeoutMs ?? shutdownBudget.forceTimeoutMs,
    };
    const closeDeadlineAt = performance.now() + budget.gracePeriodMs;
    const deadlines = {
      deadlineAt: closeDeadlineAt,
      forceDeadlineAt: closeDeadlineAt + budget.forceTimeoutMs,
    };

    restartingIds = affectedIds;
    const restartAbort = new AbortController();
    const closeTimer = setTimeout(
      () => restartAbort.abort(),
      Math.max(0, deadlines.forceDeadlineAt - performance.now()),
    );
    /** Every resource that ended this restart in `failed`, in start order. */
    const stillFailed = () => affectedIds.filter((id) => records.get(id)?.state === 'failed');
    try {
      for (const entry of [...affected].reverse()) {
        const record = records.get(entry.id);
        if (record) await closeOne(entry, record, restartAbort.signal, deadlines);
      }
      publish();
      await startEach(affected, restartAbort.signal);
      await activateEach(affected, restartAbort.signal);
      publish();
      // `startEach` re-throws only for a REQUIRED resource: an optional one that
      // will not start again is recorded, skipped, and the loop finishes
      // normally. Reporting that as `restarted` was a result contradicting the
      // snapshot it came with — success on the return value, `failed` and
      // `unhealthy` in the very next `getSnapshot()`. The records decide.
      const failed = stillFailed();
      if (failed.length > 0) {
        return {
          resourceId: parsed.resourceId,
          affected: affectedIds,
          outcome: 'failed',
          reason: `did not come back: ${failed.join(', ')}`,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        resourceId: parsed.resourceId,
        affected: affectedIds,
        outcome: 'restarted',
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // Whatever is still running under this restart is told to stop. Without
      // this the controller was constructed, threaded through every phase, and
      // never fired — an abort signal nothing ever aborts.
      restartAbort.abort();
      // The snapshot already carries what failed and in which phase, because
      // `startEach` records it the same way a startup does. Nothing is rolled
      // forward here: the old generation is closed and the new one did not come
      // up, which is exactly what the snapshot now says.
      publish();
      return {
        resourceId: parsed.resourceId,
        affected: affectedIds,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      restartingIds = [];
      clearTimeout(closeTimer);
      publish();
    }
  };

  const runStart = async (): Promise<ApplicationSnapshot> => {
    lifecycle = 'starting';
    publish();
    let startFailure: unknown;
    try {
      await startEach(ordered, startupAbort.signal);

      lifecycle = 'ready';
      publish();
      await activateEach(ordered, startupAbort.signal);
      if (shutdownRequested) {
        throw new ApplicationStartupInterruptedError();
      }
      if (!isReady()) {
        // Named, and described for what it is. "Lost readiness" was the only
        // way to get here while becoming ready assigned `healthy`
        // unconditionally; a resource that reports its own health can now
        // arrive here having never been healthy, and a message about losing
        // something is then a false lead.
        //
        // The advice is branched for the same reason, in the other direction:
        // telling the operator of a database that just dropped to put it behind
        // `required: false` is the worst possible suggestion. `everHealthy` is
        // the fact that separates the two: it says whether the resource ever
        // had the state it is now missing.
        const blocking = [...records.values()]
          .filter(
            (record) =>
              record.entry.required &&
              (record.state !== 'ready' || record.health !== 'healthy'),
          )
          .map((record) => `${record.entry.id} (${record.state}/${record.health})`);
        // Cannot be empty today — `isReady()` being false means the same
        // predicate matches at least one required record — but a message that
        // renders as "required resources ." if that stops holding is a
        // formatting assumption, not a fact.
        if (blocking.length === 0) blocking.push('(none identified)');
        const chosen = [...records.values()].some(
          (record) =>
            record.entry.required && record.health !== 'healthy' && !record.everHealthy,
        );
        throw new Error(
          `[stitchkit] the application is not ready after startup — required ${blocking.length === 1 ? 'resource' : 'resources'} ${blocking.join(', ')}. A required resource must be healthy for the application to be ready; ${
            chosen
              ? 'a resource that is expected to start degraded belongs behind `required: false`.'
              : 'this one was healthy and stopped being so — read `onResourceFailure` for the cause.'
          }`,
        );
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
    // The call's options win field by field; whatever it leaves out falls back
    // to the application's declared budget, then to the schema's defaults.
    const requested = options ?? {};
    const parsed = ApplicationShutdownOptionsSchema.parse({
      gracePeriodMs: requested.gracePeriodMs ?? shutdownBudget.gracePeriodMs,
      forceTimeoutMs: requested.forceTimeoutMs ?? shutdownBudget.forceTimeoutMs,
      ...(requested.signal !== undefined && { signal: requested.signal }),
    });
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
    restart(input: ApplicationRestartInput) {
      // Queued behind whatever restart is already running, rather than refused:
      // two callers asking for overlapping subtrees is ordinary, and the thing
      // that must never happen is their phases interleaving.
      const queued = restarting.then(() => runRestart(input));
      restarting = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
  };
}
