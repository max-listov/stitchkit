/**
 * Admission belongs to the RUNTIME, not only to the coordinator.
 *
 * `close()` used to delegate straight to `coordinator.close()`, which refuses to
 * *execute* — and by the time it refuses, `submit()` has already run preflight,
 * written a durable input and a queued run to the store, and resolved
 * `accepted`. The result is exactly the state the close exists to prevent:
 * durable work with no executor, indistinguishable from a crash.
 *
 * So the gate is checked twice, and the second one is the load-bearing half: a
 * close that arrives while a preflight is in flight must still stop the write
 * that follows it. Before the store call the answer is a clean refusal; after
 * it there is nothing to refuse, and the coordinator's own drain owns the run.
 */
export interface RuntimeAdmissionGate {
  /** Set once by `close()`; every admission path reads it, none resets it. */
  closed: boolean;
  /** Hold the gate open for one admission until the returned release is called. */
  begin(): () => void;
  /** Wait, within `budgetMs`, for admissions already inside; returns how many never arrived. */
  drain(budgetMs: number | undefined): Promise<number>;
}

export const closedError = (): Error =>
  new Error('[stitchkit] agent runtime is closed and admits no further work');

export function refuse<T>(): { accepted: Promise<void>; result: Promise<T> } {
  const error = closedError();
  const accepted = Promise.reject<void>(error);
  const result = Promise.reject<T>(error);
  // Rejections a caller may legitimately ignore must not become unhandled.
  void accepted.catch(() => undefined);
  void result.catch(() => undefined);
  return { accepted, result };
}

export function createRuntimeAdmissionGate(): RuntimeAdmissionGate {
  /**
   * Admissions that are PAST the gate and not yet handed to the coordinator.
   *
   * The gate above stops what has not started. This holds what already has, and
   * without it the gate is only half a close: a submission that passed the
   * check and is inside `acceptInputAndAssignRun` owns no coordinator lane yet,
   * so a `close()` that drains only the coordinator finds nothing, reports
   * `settled: true, remaining: 0`, and the store then commits a queued run for
   * it. The run lands with nothing to execute it — the exact state close exists
   * to prevent, reached through the door marked closed.
   *
   * An entry is released the moment the admission reaches one side or the
   * other: a refusal before the durable write, or a handoff the coordinator's
   * own drain now owns. It is never held for the length of a run.
   */
  const admissionsInFlight = new Set<PromiseWithResolvers<void>>();
  const begin = (): (() => void) => {
    const handoff = Promise.withResolvers<void>();
    admissionsInFlight.add(handoff);
    return () => {
      if (admissionsInFlight.delete(handoff)) handoff.resolve();
    };
  };

  /**
   * Wait for those admissions, and say how many never arrived.
   *
   * Bounded by the SAME budget the caller gave, not a second one beside it:
   * whatever this spends is taken off what the coordinator is then allowed to
   * spend, so "every combination is bounded" survives the extra wait.
   */
  const drain = async (budgetMs: number | undefined): Promise<number> => {
    const pending = [...admissionsInFlight].map((handoff) => handoff.promise);
    if (pending.length === 0) return 0;
    let stranded = pending.length;
    const settled = Promise.all(
      pending.map((promise) =>
        promise.then(() => {
          stranded -= 1;
        }),
      ),
    );
    if (budgetMs === undefined) {
      await settled;
      return 0;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return stranded;
  };

  return { closed: false, begin, drain };
}
