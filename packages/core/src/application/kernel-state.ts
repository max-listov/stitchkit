import type { z } from 'zod';
import { type ResolvedManagedResource, resolveResourceGraph } from './graph';
import {
  type ApplicationConfig,
  type ApplicationResourcePhase,
  ApplicationShutdownBudgetSchema,
} from './kernel-contract';
import type { ManagedResourceStartResult } from './resource';
import {
  type ApplicationHealth,
  ApplicationIdSchema,
  type ApplicationLifecycle,
  type ApplicationShutdownResult,
  type ApplicationSnapshot,
  ApplicationSnapshotSchema,
  type ManagedResourceState,
} from './schemas';

export interface ResourceRecord {
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

/**
 * Everything one application's phases share, as one explicit object.
 *
 * The kernel was a single closure whose phases reached this state through
 * captured `let` bindings; the phases now live in their own modules and are
 * handed this object instead, so what each phase reads and writes is visible
 * in its signature rather than implied by lexical scope.
 */
export interface KernelState {
  readonly id: string;
  readonly config: ApplicationConfig;
  /** Start order: topological, so a dependant follows everything it depends on. */
  readonly ordered: readonly ResolvedManagedResource[];
  /** Stop order: `ordered`, reversed. */
  readonly reverse: readonly ResolvedManagedResource[];
  readonly shutdownBudget: z.output<typeof ApplicationShutdownBudgetSchema>;
  /**
   * What each resource handed to its dependants, kept for the application's
   * whole life rather than only until readiness: a dependant may still need the
   * handle it was given while it drains, and dropping it at the end of startup
   * would make `use()` work in `start` and fail in `close`.
   */
  readonly published: Map<string, unknown>;
  readonly records: Map<string, ResourceRecord>;
  readonly epoch: string;
  readonly listeners: Set<(snapshot: ApplicationSnapshot) => void>;
  readonly lifetimeAbort: AbortController;
  readonly startupAbort: AbortController;
  lifecycle: ApplicationLifecycle;
  revision: number;
  changedAt: string;
  accepting: boolean;
  accepted: number;
  completed: number;
  pending: number;
  startPromise: Promise<ApplicationSnapshot> | undefined;
  shutdownPromise: Promise<ApplicationShutdownResult> | undefined;
  shutdownRequested: boolean;
  activationComplete: boolean;
  readonly pendingWaiters: Set<() => void>;
  /** The subtree a restart is replacing right now — empty between restarts. */
  restartingIds: readonly string[];
  /** The tail of the restart queue; each restart waits for the one before it. */
  restarting: Promise<unknown>;
}

export class ResourceCompletionBeforeReadyError extends Error {
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
export class ApplicationStartupInterruptedError extends Error {
  constructor() {
    super('[stitchkit] application startup interrupted by shutdown');
    this.name = 'ApplicationStartupInterruptedError';
  }
}

export function isStartResult(value: unknown): value is ManagedResourceStartResult {
  return typeof value === 'object' && value !== null;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

export async function untilDeadline<T>(
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

/** Registration: resolve the graph and give every resource its record. */
export function createKernelState(config: ApplicationConfig): KernelState {
  const id = ApplicationIdSchema.parse(config.id);
  const ordered = resolveResourceGraph(config.resources ?? []);
  const shutdownBudget = ApplicationShutdownBudgetSchema.parse(config.shutdown ?? {});
  const reverse = [...ordered].reverse();

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

  return {
    id,
    config,
    ordered,
    reverse,
    shutdownBudget,
    published: new Map<string, unknown>(),
    records,
    epoch: crypto.randomUUID(),
    listeners: new Set(),
    lifetimeAbort: new AbortController(),
    startupAbort: new AbortController(),
    lifecycle: 'created',
    revision: 0,
    changedAt: new Date().toISOString(),
    accepting: false,
    accepted: 0,
    completed: 0,
    pending: 0,
    startPromise: undefined,
    shutdownPromise: undefined,
    shutdownRequested: false,
    activationComplete: false,
    pendingWaiters: new Set(),
    restartingIds: [],
    restarting: Promise.resolve(),
  };
}

/** The record of a resource the graph registered; its absence is a kernel bug. */
export function recordOf(state: KernelState, resourceId: string): ResourceRecord {
  const record = state.records.get(resourceId);
  if (!record) throw new Error('Managed resource record disappeared');
  return record;
}

export function reportFailure(
  state: KernelState,
  resourceId: string,
  phase: ApplicationResourcePhase,
  error: unknown,
): void {
  const config = state.config;
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
}

function aggregateHealth(state: KernelState): ApplicationHealth {
  if (state.lifecycle === 'created' || state.lifecycle === 'starting') return 'unknown';
  let optionalUnhealthy = false;
  for (const record of state.records.values()) {
    if (record.entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
      return 'unhealthy';
    }
    if (!record.entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
      optionalUnhealthy = true;
    }
  }
  return optionalUnhealthy ? 'degraded' : 'healthy';
}

export function isReady(state: KernelState): boolean {
  return (
    state.lifecycle === 'ready' &&
    [...state.records.values()].every(
      (record) =>
        !record.entry.required || (record.state === 'ready' && record.health === 'healthy'),
    )
  );
}

export function snapshot(state: KernelState): ApplicationSnapshot {
  return ApplicationSnapshotSchema.parse({
    id: state.id,
    epoch: state.epoch,
    revision: state.revision,
    lifecycle: state.lifecycle,
    health: aggregateHealth(state),
    ready: isReady(state),
    capturedAt: new Date().toISOString(),
    changedAt: state.changedAt,
    admission: {
      accepting: state.accepting,
      accepted: state.accepted,
      completed: state.completed,
      pending: state.pending,
    },
    restarting: [...state.restartingIds],
    resources: state.ordered.map((entry) => {
      const record = recordOf(state, entry.id);
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
}

export function publish(state: KernelState): void {
  state.revision += 1;
  state.changedAt = new Date().toISOString();
  const value = snapshot(state);
  for (const listener of state.listeners) {
    try {
      listener(value);
    } catch {
      // State observers cannot break the lifecycle they observe.
    }
  }
  const config = state.config;
  if (config.onSnapshot) {
    void Promise.resolve()
      .then(() => config.onSnapshot?.(value))
      .catch(() => {
        // Sync and async state observers are equally isolated.
      });
  }
}
