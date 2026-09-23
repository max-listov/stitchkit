import { contextFor } from './kernel-resource-context';
import { type KernelState, publish, reportFailure, untilDeadline } from './kernel-state';

/** Close every resource a failed startup attempted, within the declared budget. */
export async function closeAttempted(state: KernelState): Promise<unknown[]> {
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
  const rollbackDeadlineAt = rollbackStartedAt + state.shutdownBudget.gracePeriodMs;
  const rollbackForceDeadlineAt = rollbackDeadlineAt + state.shutdownBudget.forceTimeoutMs;
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
    await closeEachAttempted(state, rollbackAbort.signal, errors, {
      deadlineAt: rollbackDeadlineAt,
      forceDeadlineAt: rollbackForceDeadlineAt,
    });
  } finally {
    clearTimeout(rollbackTimer);
  }
  return errors;
}

/** The reverse-order `close` sweep a rollback runs, bounded by `signal`. */
async function closeEachAttempted(
  state: KernelState,
  bound: AbortSignal,
  errors: unknown[],
  deadlines: { deadlineAt: number; forceDeadlineAt: number },
): Promise<void> {
  for (const entry of state.reverse) {
    const record = state.records.get(entry.id);
    if (!record?.attempted || record.closed) continue;
    record.state = 'stopping';
    try {
      record.closeInvoked = true;
      const settled = await untilDeadline(
        Promise.resolve(
          entry.resource.close?.(
            contextFor(state, record, { signal: state.startupAbort.signal, ...deadlines }),
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
        reportFailure(state, entry.id, 'close', timedOut);
        errors.push(timedOut);
        publish(state);
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
      reportFailure(state, entry.id, 'close', error);
      errors.push(error);
    }
    publish(state);
  }
}
