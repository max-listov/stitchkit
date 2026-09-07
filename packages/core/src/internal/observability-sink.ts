import {
  type ObservabilitySinkStatus,
  ObservabilitySinkStatusSchema,
} from '../observability/status';

export type BoundedSinkDropReason = 'capacity' | 'closed';

export interface BoundedSinkError<EVENT> {
  error: unknown;
  event?: EVENT;
}

export interface BoundedSinkDrop<EVENT> {
  reason: BoundedSinkDropReason;
  event: EVENT;
  pending: number;
}

export interface BoundedSinkConfig<EVENT> {
  write(event: EVENT): void | Promise<void>;
  filter?(event: EVENT): boolean;
  maxPending?: number;
  onSinkError?(failure: BoundedSinkError<EVENT>): void | Promise<void>;
  onDrop?(drop: BoundedSinkDrop<EVENT>): void | Promise<void>;
}

/**
 * A caller's limit on how long a drain may WAIT.
 *
 * Unbounded, a drain waits for every accepted event however long the sink
 * takes — correct when the sink is healthy, fatal when it is not. One write
 * that never settles, a database that has stopped answering, held `close()`
 * forever; an application whose shutdown graph gives every other step a
 * deadline then spent its whole budget here and exited by force. A drain that
 * cannot be bounded cannot take part in a shutdown budget: it either fits, or
 * it cancels the budget.
 *
 * The bound ends the WAITING, not the writes: a sink's `write` is handed no
 * cancellation, so an outstanding one keeps running against whatever the caller
 * closes next. And it is a bound on waiting for I/O, not on wall time — no
 * bound can preempt a `write` that occupies the event loop.
 */
export interface ObservabilityDrainBound {
  /** Give up waiting after this many milliseconds. */
  timeoutMs?: number;
  /** Give up waiting when this signal aborts. */
  signal?: AbortSignal;
}

/**
 * Refuse a nonsensical bound BEFORE anything is mutated, so a call that throws
 * has no effect — admission stays open rather than half-closed.
 */
export function assertDrainBound(bound: ObservabilityDrainBound | undefined): void {
  const timeoutMs = bound?.timeoutMs;
  if (timeoutMs === undefined) return;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Observability drain timeoutMs must be a non-negative finite number');
  }
}

/**
 * Wait for `work`, but not past `bound`. Resolves `true` when the work settled
 * first, `false` when the bound did.
 *
 * Composed by hand rather than with `AbortSignal.any`, because the composite it
 * returns registers itself on the caller's signal and is never released: on Bun
 * that is a dependent leaked per drain against a process-lifetime signal, and
 * `flush({ signal })` per batch is exactly the shape that accumulates them.
 * A listener and a timer, both disposed here, cost nothing and leave nothing.
 *
 * The timer is REF'D, and that is the whole mechanism. Unref'ing it reads like
 * good hygiene — a drain bound should not keep a process alive while it is
 * shutting down — and it silently destroys the feature: a pending write holds
 * nothing, so when the stuck write is the last thing left, an unref'd timer
 * lets the loop empty and the bound never fires at all. That is not an edge
 * case, it is the case this exists for. The timer cannot outlive the deadline
 * the caller itself asked for, so holding the loop for exactly that long is
 * what was wanted. Found only by installing the published package and running
 * it under `node`, where the process exits 13 on an unsettled top-level await;
 * every in-process test passes because the runner keeps the loop alive.
 */
export function withinBound(
  work: Promise<unknown>,
  bound: ObservabilityDrainBound | undefined,
): Promise<boolean> {
  assertDrainBound(bound);
  const { timeoutMs, signal } = bound ?? {};
  if (timeoutMs === undefined && !signal) return work.then(() => true);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const reached = new Promise<false>((resolve) => {
    const give = (): void => resolve(false);
    // An already-aborted signal never fires `abort`, so it is answered here —
    // and still through the race below, so `work` always gets a subscriber and
    // a late rejection can never become an unhandled one.
    if (signal?.aborted) {
      give();
      return;
    }
    if (signal) {
      onAbort = give;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs !== undefined) timer = setTimeout(give, timeoutMs);
  });

  return Promise.race([work.then(() => true), reached]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  });
}

export interface BoundedSinkManager<EVENT> {
  submit(produce: () => EVENT | Promise<EVENT>): void;
  /** Whether the generation admitted before this call settled inside the bound. */
  flush(bound?: ObservabilityDrainBound): Promise<boolean>;
  getStatus(): ObservabilitySinkStatus;
  /**
   * Stop admission and drain. The status is read AFTER the wait ends, so
   * `pending` and `preparing` say what the sink had not written — including
   * when the bound ended the wait early.
   */
  close(bound?: ObservabilityDrainBound): Promise<ObservabilitySinkStatus>;
}

const DEFAULT_MAX_PENDING = 1000;

function invokeIsolated(callback: (() => void | Promise<void>) | undefined): void {
  if (!callback) return;
  void Promise.resolve()
    .then(callback)
    .catch(() => {
      // Diagnostics cannot create an unhandled rejection.
    });
}

export function createBoundedSinkManager<EVENT>(
  config: BoundedSinkConfig<EVENT>,
): BoundedSinkManager<EVENT> {
  const maxPending = config.maxPending ?? DEFAULT_MAX_PENDING;
  if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
    throw new TypeError('Observability maxPending must be a positive safe integer');
  }

  let sequence = 0;
  let closed = false;
  let received = 0;
  let accepted = 0;
  let filtered = 0;
  let completed = 0;
  let dropped = 0;
  let failed = 0;
  let preparationFailed = 0;
  let drain: Promise<void> | undefined;
  const preparing = new Map<number, Promise<void>>();
  const writes = new Map<number, Promise<void>>();

  const reportError = (error: unknown, event?: EVENT): void => {
    invokeIsolated(
      config.onSinkError
        ? () => config.onSinkError?.({ error, ...(event !== undefined && { event }) })
        : undefined,
    );
  };
  const reportDrop = (reason: BoundedSinkDropReason, event: EVENT): void => {
    invokeIsolated(
      config.onDrop
        ? () => config.onDrop?.({ reason, event, pending: writes.size })
        : undefined,
    );
  };
  const admit = (id: number, event: EVENT): void => {
    try {
      if (config.filter && !config.filter(event)) {
        filtered += 1;
        return;
      }
    } catch (error) {
      preparationFailed += 1;
      reportError(error, event);
      return;
    }
    if (writes.size >= maxPending) {
      dropped += 1;
      reportDrop('capacity', event);
      return;
    }
    accepted += 1;
    // The counter and the map entry move TOGETHER. As a trailing `.finally`,
    // the delete ran one microtask after the increment, so a status read landing
    // in that gap saw an event counted as both `completed` and `pending` — and a
    // caller-supplied abort signal fires synchronously, which lands a bounded
    // drain's report exactly there. The observed report claimed `accepted: 1`
    // with `completed: 1` and `pending: 1`.
    const settle = (record: () => void): void => {
      record();
      writes.delete(id);
    };
    const write = Promise.resolve()
      .then(() => config.write(event))
      .then(
        () =>
          settle(() => {
            completed += 1;
          }),
        (error) =>
          settle(() => {
            failed += 1;
            reportError(error, event);
          }),
      );
    writes.set(id, write);
  };
  const awaitGeneration = async (boundary: number): Promise<void> => {
    const through = <VALUE>(values: Map<number, VALUE>): VALUE[] =>
      [...values].filter(([id]) => id <= boundary).map(([, value]) => value);
    await Promise.allSettled(through(preparing));
    await Promise.allSettled(through(writes));
  };

  return {
    submit(produce) {
      received += 1;
      const id = ++sequence;
      if (closed) {
        void Promise.resolve()
          .then(produce)
          .then((event) => {
            dropped += 1;
            reportDrop('closed', event);
          })
          .catch((error) => {
            preparationFailed += 1;
            reportError(error);
          });
        return;
      }
      // Same rule, and the same gap: as a trailing `.finally`, this id left
      // `preparing` two microtasks AFTER `admit` had already put it in
      // `writes`, so one event was counted twice by `pending + preparing` —
      // the sum a bounded drain reports as unwritten.
      const preparation = Promise.resolve()
        .then(produce)
        .then(
          (event) => {
            preparing.delete(id);
            admit(id, event);
          },
          (error) => {
            preparing.delete(id);
            preparationFailed += 1;
            reportError(error);
          },
        );
      preparing.set(id, preparation);
    },
    flush(bound) {
      assertDrainBound(bound);
      return withinBound(awaitGeneration(sequence), bound);
    },
    getStatus,
    close(bound) {
      assertDrainBound(bound);
      // The drain is started once and shared: a second close under a shorter
      // bound observes the SAME drain rather than starting another.
      drain ??= awaitGeneration(sequence);
      closed = true;
      // The SAME snapshot function, not a second copy of the same eleven-field
      // literal: as two, a new counter appeared in whichever one its author was
      // looking at, and the other kept reporting the old shape.
      return withinBound(drain, bound).then(getStatus);
    },
  };

  function getStatus() {
    return ObservabilitySinkStatusSchema.parse({
      capacity: maxPending,
      received,
      accepted,
      filtered,
      completed,
      dropped,
      failed,
      preparationFailed,
      preparing: preparing.size,
      pending: writes.size,
      closed,
    });
  }
}
