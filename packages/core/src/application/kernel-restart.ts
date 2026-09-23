import type { ResolvedManagedResource } from './graph';
import {
  type ApplicationRestartInput,
  ApplicationRestartInputSchema,
  type ApplicationRestartResult,
} from './kernel-contract';
import { contextFor } from './kernel-resource-context';
import { activateEach, startEach } from './kernel-start';
import { type KernelState, publish, type ResourceRecord, untilDeadline } from './kernel-state';

/** The resource named, plus every resource that transitively depends on it. */
function subtreeOf(
  state: KernelState,
  resourceId: string,
): readonly ResolvedManagedResource[] {
  const affected = new Set([resourceId]);
  // One forward pass is enough because `ordered` is topological: a dependant
  // always appears after everything it depends on.
  for (const entry of state.ordered) {
    if (entry.dependsOn.some((dependencyId) => affected.has(dependencyId))) {
      affected.add(entry.id);
    }
  }
  return state.ordered.filter((entry) => affected.has(entry.id));
}

/** Take one resource down through its own phases, then forget its generation. */
async function closeOne(
  state: KernelState,
  entry: ResolvedManagedResource,
  record: ResourceRecord,
  signal: AbortSignal,
  deadlines: { deadlineAt: number; forceDeadlineAt: number },
): Promise<void> {
  const context = () => contextFor(state, record, { ...deadlines, signal });
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
  state.published.delete(entry.id);
}

async function runRestart(
  state: KernelState,
  input: ApplicationRestartInput,
): Promise<ApplicationRestartResult> {
  const startedAt = Date.now();
  const parsed = ApplicationRestartInputSchema.parse(input);
  const affected = subtreeOf(state, parsed.resourceId);
  const affectedIds = affected.map((entry) => entry.id);
  const refuse = (reason: string): ApplicationRestartResult => ({
    resourceId: parsed.resourceId,
    affected: affectedIds,
    outcome: 'refused',
    reason,
    durationMs: Date.now() - startedAt,
  });

  if (!state.records.has(parsed.resourceId)) {
    return refuse(`no resource is registered as "${parsed.resourceId}"`);
  }
  if (state.shutdownRequested) {
    return refuse('the application is shutting down');
  }
  if (state.lifecycle !== 'ready') {
    return refuse(`the application is ${state.lifecycle}, not ready`);
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
    gracePeriodMs: parsed.gracePeriodMs ?? state.shutdownBudget.gracePeriodMs,
    forceTimeoutMs: parsed.forceTimeoutMs ?? state.shutdownBudget.forceTimeoutMs,
  };
  const closeDeadlineAt = performance.now() + budget.gracePeriodMs;
  const deadlines = {
    deadlineAt: closeDeadlineAt,
    forceDeadlineAt: closeDeadlineAt + budget.forceTimeoutMs,
  };

  state.restartingIds = affectedIds;
  const restartAbort = new AbortController();
  const closeTimer = setTimeout(
    () => restartAbort.abort(),
    Math.max(0, deadlines.forceDeadlineAt - performance.now()),
  );
  /** Every resource that ended this restart in `failed`, in start order. */
  const stillFailed = () =>
    affectedIds.filter((id) => state.records.get(id)?.state === 'failed');
  try {
    for (const entry of [...affected].reverse()) {
      const record = state.records.get(entry.id);
      if (record) await closeOne(state, entry, record, restartAbort.signal, deadlines);
    }
    publish(state);
    await startEach(state, affected, restartAbort.signal);
    await activateEach(state, affected, restartAbort.signal);
    publish(state);
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
    publish(state);
    return {
      resourceId: parsed.resourceId,
      affected: affectedIds,
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    state.restartingIds = [];
    clearTimeout(closeTimer);
    publish(state);
  }
}

/** `restart()`: one subtree replacement, serialised behind any in flight. */
export function restart(
  state: KernelState,
  input: ApplicationRestartInput,
): Promise<ApplicationRestartResult> {
  // Queued behind whatever restart is already running, rather than refused:
  // two callers asking for overlapping subtrees is ordinary, and the thing
  // that must never happen is their phases interleaving.
  const queued = state.restarting.then(() => runRestart(state, input));
  state.restarting = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}
