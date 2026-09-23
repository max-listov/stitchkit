import type { z } from 'zod';
import type { ResolvedManagedResource } from './graph';
import { waitForPending } from './kernel-admission';
import {
  type ApplicationShutdownOptions,
  ApplicationShutdownOptionsSchema,
} from './kernel-contract';
import { contextFor } from './kernel-resource-context';
import {
  type KernelState,
  publish,
  type ResourceRecord,
  recordOf,
  reportFailure,
  untilDeadline,
} from './kernel-state';
import type { ManagedResourceContext } from './resource';
import { type ApplicationShutdownResult, ApplicationShutdownResultSchema } from './schemas';

/**
 * One shutdown in progress: its deadlines and what its phases have learned.
 *
 * The phases below run strictly one after another and each reads what the
 * previous ones decided — whether the graceful path was abandoned, and why —
 * so that verdict travels between them as this object.
 */
interface ShutdownRun {
  readonly state: KernelState;
  readonly startedAt: number;
  readonly graceDeadlineAt: number;
  readonly forceDeadlineAt: number;
  readonly gracefulAbort: AbortController;
  forcedReason: 'deadline' | 'signal' | undefined;
  gracefulFailed: boolean;
}

function force(shutdown: ShutdownRun, reason: 'deadline' | 'signal'): void {
  if (shutdown.forcedReason) return;
  shutdown.forcedReason = reason;
  shutdown.gracefulAbort.abort();
  shutdown.state.lifetimeAbort.abort();
}

function gracefulContext(
  shutdown: ShutdownRun,
  record: ResourceRecord,
): ManagedResourceContext {
  return contextFor(shutdown.state, record, {
    signal: shutdown.gracefulAbort.signal,
    deadlineAt: shutdown.graceDeadlineAt,
    forceDeadlineAt: shutdown.forceDeadlineAt,
  });
}

/** Phase one: every started resource stops admitting, in reverse order. */
async function stopAdmissionSweep(shutdown: ShutdownRun): Promise<void> {
  const { state } = shutdown;
  for (const entry of state.reverse) {
    if (shutdown.gracefulAbort.signal.aborted) break;
    const record = state.records.get(entry.id);
    if (!record?.attempted || record.closed) continue;
    try {
      const result = await untilDeadline(
        Promise.resolve(entry.resource.stopAdmission?.(gracefulContext(shutdown, record))),
        shutdown.gracefulAbort.signal,
      );
      if (!result.settled) break;
      if (result.error !== undefined) throw result.error;
    } catch (error) {
      record.failures.push('admission');
      reportFailure(state, entry.id, 'admission', error);
      shutdown.gracefulFailed = true;
      state.lifetimeAbort.abort();
    }
  }
}

/** Phase two: every started resource drains, in reverse order. */
async function drainSweep(shutdown: ShutdownRun): Promise<void> {
  const { state } = shutdown;
  for (const entry of state.reverse) {
    if (shutdown.gracefulAbort.signal.aborted || shutdown.gracefulFailed) break;
    const record = state.records.get(entry.id);
    if (!record?.attempted || record.closed) continue;
    record.state = 'stopping';
    publish(state);
    try {
      const drained = await untilDeadline(
        Promise.resolve(entry.resource.drain?.(gracefulContext(shutdown, record))),
        shutdown.gracefulAbort.signal,
      );
      if (!drained.settled) {
        force(shutdown, 'deadline');
        break;
      }
      if (drained.error !== undefined) throw drained.error;
    } catch (error) {
      record.failures.push('drain');
      reportFailure(state, entry.id, 'drain', error);
      shutdown.gracefulFailed = true;
      state.lifetimeAbort.abort();
      break;
    }
  }
}

/** Phase three: every started resource closes, in reverse order. */
async function closeSweep(shutdown: ShutdownRun): Promise<void> {
  const { state } = shutdown;
  for (const entry of state.reverse) {
    if (shutdown.gracefulAbort.signal.aborted || shutdown.gracefulFailed) break;
    const record = state.records.get(entry.id);
    if (!record?.attempted || record.closed || record.closeInvoked) continue;
    try {
      record.closeInvoked = true;
      const closed = await untilDeadline(
        Promise.resolve(entry.resource.close?.(gracefulContext(shutdown, record))),
        shutdown.gracefulAbort.signal,
      );
      if (!closed.settled) {
        force(shutdown, 'deadline');
        break;
      }
      if (closed.error !== undefined) throw closed.error;
      record.closed = true;
      record.state = 'stopped';
      publish(state);
    } catch (error) {
      record.failures.push('close');
      reportFailure(state, entry.id, 'close', error);
      record.state = 'failed';
      shutdown.gracefulFailed = true;
      state.lifetimeAbort.abort();
      publish(state);
      break;
    }
  }
}

/** The forced cleanup of one resource the graceful path did not close. */
async function forceOne(
  shutdown: ShutdownRun,
  entry: ResolvedManagedResource,
  forceSignal: AbortSignal,
): Promise<void> {
  const { state } = shutdown;
  const record = state.records.get(entry.id);
  if (!record?.attempted || record.closed) return;
  try {
    let cleanup: Promise<void> | undefined;
    if (entry.resource.force) {
      cleanup = Promise.resolve(
        entry.resource.force(
          contextFor(state, record, {
            signal: forceSignal,
            deadlineAt: shutdown.graceDeadlineAt,
            forceDeadlineAt: shutdown.forceDeadlineAt,
          }),
        ),
      );
    } else if (entry.resource.close && !record.closeInvoked) {
      record.closeInvoked = true;
      cleanup = Promise.resolve(
        entry.resource.close(
          contextFor(state, record, {
            signal: forceSignal,
            deadlineAt: shutdown.graceDeadlineAt,
            forceDeadlineAt: shutdown.forceDeadlineAt,
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
        state,
        entry.id,
        'force',
        new Error(
          `[stitchkit] resource "${entry.id}" was already closing and did not settle before the force deadline`,
        ),
      );
      return;
    }
    const forced = await untilDeadline(cleanup ?? Promise.resolve(), forceSignal);
    if (!forced.settled || forced.error !== undefined) {
      record.failures.push('force');
      reportFailure(
        state,
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
    reportFailure(state, entry.id, 'force', error);
  }
}

/** Phase four, only when the graceful path was abandoned: force, concurrently. */
async function forceSweep(shutdown: ShutdownRun): Promise<void> {
  shutdown.state.lifetimeAbort.abort();
  const forceAbort = new AbortController();
  const forceTimer = setTimeout(
    () => forceAbort.abort(),
    Math.max(0, shutdown.forceDeadlineAt - performance.now()),
  );
  await Promise.all(
    shutdown.state.reverse.map((entry) => forceOne(shutdown, entry, forceAbort.signal)),
  );
  clearTimeout(forceTimer);
}

function shutdownResult(
  shutdown: ShutdownRun,
  mustForce: boolean,
  pendingOperationsAtForce: number,
): ApplicationShutdownResult {
  const { state } = shutdown;
  const cleanupComplete = [...state.records.values()].every(
    (record) => !record.attempted || record.closed,
  );
  state.lifecycle = cleanupComplete ? 'stopped' : 'failed';
  publish(state);
  return ApplicationShutdownResultSchema.parse({
    outcome: mustForce ? 'forced' : 'clean',
    ...(shutdown.forcedReason && { reason: shutdown.forcedReason }),
    cleanupComplete,
    acceptedOperations: state.accepted,
    completedOperations: state.completed,
    pendingOperations: state.pending,
    pendingOperationsAtForce,
    resources: state.ordered.map((entry) => {
      const record = recordOf(state, entry.id);
      return {
        id: entry.id,
        state: !record.attempted ? 'not-started' : record.closed ? 'closed' : 'force-failed',
        failures: record.failures,
      };
    }),
    durationMs: performance.now() - shutdown.startedAt,
  });
}

async function runShutdown(
  state: KernelState,
  parsed: z.output<typeof ApplicationShutdownOptionsSchema>,
  startedAt: number,
): Promise<ApplicationShutdownResult> {
  const graceDeadlineAt = startedAt + parsed.gracePeriodMs;
  const shutdown: ShutdownRun = {
    state,
    startedAt,
    graceDeadlineAt,
    forceDeadlineAt: graceDeadlineAt + parsed.forceTimeoutMs,
    gracefulAbort: new AbortController(),
    forcedReason: undefined,
    gracefulFailed: [...state.records.values()].some(
      (record) => record.attempted && record.closeInvoked && !record.closed,
    ),
  };
  const graceTimer = setTimeout(
    () => force(shutdown, 'deadline'),
    Math.max(0, graceDeadlineAt - performance.now()),
  );
  const onExternalAbort = (): void => force(shutdown, 'signal');
  parsed.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (parsed.signal?.aborted) force(shutdown, 'signal');

  if (state.startPromise) {
    await untilDeadline(
      state.startPromise.catch(() => undefined),
      shutdown.gracefulAbort.signal,
    );
  }

  await stopAdmissionSweep(shutdown);

  if (!shutdown.gracefulAbort.signal.aborted && !shutdown.gracefulFailed) {
    const result = await untilDeadline(waitForPending(state), shutdown.gracefulAbort.signal);
    if (!result.settled) force(shutdown, 'deadline');
  }

  await drainSweep(shutdown);

  state.lifecycle = 'stopping';
  publish(state);
  await closeSweep(shutdown);

  clearTimeout(graceTimer);
  parsed.signal?.removeEventListener('abort', onExternalAbort);
  const mustForce = shutdown.forcedReason !== undefined || shutdown.gracefulFailed;
  const pendingOperationsAtForce = mustForce ? state.pending : 0;
  if (mustForce) await forceSweep(shutdown);

  return shutdownResult(shutdown, mustForce, pendingOperationsAtForce);
}

/** `shutdown()`: one bounded way down per application, shared by every caller. */
export function shutdown(
  state: KernelState,
  options?: ApplicationShutdownOptions,
): Promise<ApplicationShutdownResult> {
  if (state.shutdownPromise) return state.shutdownPromise;
  // The call's options win field by field; whatever it leaves out falls back
  // to the application's declared budget, then to the schema's defaults.
  const requested = options ?? {};
  const parsed = ApplicationShutdownOptionsSchema.parse({
    gracePeriodMs: requested.gracePeriodMs ?? state.shutdownBudget.gracePeriodMs,
    forceTimeoutMs: requested.forceTimeoutMs ?? state.shutdownBudget.forceTimeoutMs,
    ...(requested.signal !== undefined && { signal: requested.signal }),
  });
  const startedAt = performance.now();
  state.shutdownRequested = true;
  state.accepting = false;
  state.startupAbort.abort();
  state.lifecycle = state.lifecycle === 'created' ? 'stopping' : 'draining';
  publish(state);

  const stopping = runShutdown(state, parsed, startedAt);
  state.shutdownPromise = stopping;
  void stopping.catch(() => undefined);
  return stopping;
}
