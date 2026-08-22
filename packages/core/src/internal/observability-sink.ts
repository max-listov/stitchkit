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

export interface BoundedSinkManager<EVENT> {
  submit(produce: () => EVENT | Promise<EVENT>): void;
  flush(): Promise<void>;
  getStatus(): ObservabilitySinkStatus;
  close(): Promise<ObservabilitySinkStatus>;
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
  let closePromise: Promise<ObservabilitySinkStatus> | undefined;
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
    const write = Promise.resolve()
      .then(() => config.write(event))
      .then(() => {
        completed += 1;
      })
      .catch((error) => {
        failed += 1;
        reportError(error, event);
      })
      .finally(() => writes.delete(id));
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
      const preparation = Promise.resolve()
        .then(produce)
        .then((event) => admit(id, event))
        .catch((error) => {
          preparationFailed += 1;
          reportError(error);
        })
        .finally(() => preparing.delete(id));
      preparing.set(id, preparation);
    },
    flush() {
      return awaitGeneration(sequence);
    },
    getStatus() {
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
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = awaitGeneration(sequence).then(() =>
        ObservabilitySinkStatusSchema.parse({
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
        }),
      );
      return closePromise;
    },
  };
}
