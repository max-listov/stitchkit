import { z } from 'zod';

const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const PositiveSafeIntegerSchema = z.number().int().positive().safe();
const TimerDelaySchema = z.number().int().positive().max(2_147_483_647);

export const RevisionSignalStateSchema = z.enum(['open', 'closed']);
export type RevisionSignalState = z.infer<typeof RevisionSignalStateSchema>;

export const RevisionSignalWaitOutcomeSchema = z.enum([
  'changed',
  'timed-out',
  'aborted',
  'closed',
  'capacity',
]);
export type RevisionSignalWaitOutcome = z.infer<typeof RevisionSignalWaitOutcomeSchema>;

export const RevisionSignalWaitResultSchema = z
  .object({
    outcome: RevisionSignalWaitOutcomeSchema,
    revision: NonNegativeSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type RevisionSignalWaitResult = z.infer<typeof RevisionSignalWaitResultSchema>;

export const RevisionSignalAdvanceResultSchema = z
  .object({
    outcome: z.enum(['advanced', 'closed']),
    revision: NonNegativeSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type RevisionSignalAdvanceResult = z.infer<typeof RevisionSignalAdvanceResultSchema>;

export const RevisionSignalSnapshotSchema = z
  .object({
    state: RevisionSignalStateSchema,
    revision: NonNegativeSafeIntegerSchema,
    pending: NonNegativeSafeIntegerSchema,
    maxWaiters: PositiveSafeIntegerSchema,
    advances: NonNegativeSafeIntegerSchema,
    refusedAdvances: NonNegativeSafeIntegerSchema,
    waits: NonNegativeSafeIntegerSchema,
    changed: NonNegativeSafeIntegerSchema,
    timedOut: NonNegativeSafeIntegerSchema,
    aborted: NonNegativeSafeIntegerSchema,
    closedWaits: NonNegativeSafeIntegerSchema,
    capacityRefusals: NonNegativeSafeIntegerSchema,
    clockFailures: NonNegativeSafeIntegerSchema,
  })
  .strict()
  .readonly();
export type RevisionSignalSnapshot = z.infer<typeof RevisionSignalSnapshotSchema>;

export interface RevisionSignalTimer {
  cancel(): void;
}

/** Timer boundary for deterministic wait-budget tests. */
export interface RevisionSignalClock {
  schedule(callback: () => void, delayMs: number): RevisionSignalTimer;
}

export interface RevisionSignalConfig {
  /** Maximum simultaneously parked waits. */
  readonly maxWaiters: number;
  /** Defaults to the platform timer. */
  readonly clock?: RevisionSignalClock;
}

export interface RevisionSignalWaitOptions {
  readonly signal?: AbortSignal;
  /** Absent means wait until an advance, abort or close. */
  readonly timeoutMs?: number;
}

export interface RevisionSignal {
  /** Advance the monotonic revision and broadcast it to every older waiter. */
  advance(): RevisionSignalAdvanceResult;
  /**
   * Wait for a revision newer than `after`.
   *
   * An already newer revision resolves immediately. The current revision parks the wait. A
   * future revision is a caller bug and is rejected before any waiter is retained.
   */
  wait(after: number, options?: RevisionSignalWaitOptions): Promise<RevisionSignalWaitResult>;
  close(): RevisionSignalSnapshot;
  getSnapshot(): RevisionSignalSnapshot;
}

interface RevisionWaiter {
  settle(outcome: RevisionSignalWaitOutcome): void;
}

const systemClock: RevisionSignalClock = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Finite process-local broadcast wake-up keyed by a monotonic revision. */
export function createRevisionSignal(config: RevisionSignalConfig): RevisionSignal {
  const maxWaiters = PositiveSafeIntegerSchema.parse(config.maxWaiters);
  const clock = config.clock ?? systemClock;
  const waiters = new Set<RevisionWaiter>();
  let state: RevisionSignalState = 'open';
  let revision = 0;
  let advances = 0;
  let refusedAdvances = 0;
  let waits = 0;
  let changed = 0;
  let timedOut = 0;
  let aborted = 0;
  let closedWaits = 0;
  let capacityRefusals = 0;
  let clockFailures = 0;

  const result = (outcome: RevisionSignalWaitOutcome): RevisionSignalWaitResult => {
    if (outcome === 'changed') changed += 1;
    else if (outcome === 'timed-out') timedOut += 1;
    else if (outcome === 'aborted') aborted += 1;
    else if (outcome === 'closed') closedWaits += 1;
    else capacityRefusals += 1;
    return RevisionSignalWaitResultSchema.parse({ outcome, revision });
  };

  const snapshot = (): RevisionSignalSnapshot =>
    RevisionSignalSnapshotSchema.parse({
      state,
      revision,
      pending: waiters.size,
      maxWaiters,
      advances,
      refusedAdvances,
      waits,
      changed,
      timedOut,
      aborted,
      closedWaits,
      capacityRefusals,
      clockFailures,
    });

  return {
    advance() {
      if (state === 'closed') {
        refusedAdvances += 1;
        return RevisionSignalAdvanceResultSchema.parse({ outcome: 'closed', revision });
      }
      if (revision === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Revision signal exhausted the safe-integer revision range');
      }
      revision += 1;
      advances += 1;
      for (const waiter of [...waiters]) waiter.settle('changed');
      return RevisionSignalAdvanceResultSchema.parse({ outcome: 'advanced', revision });
    },
    wait(after, options = {}) {
      const parsedAfter = NonNegativeSafeIntegerSchema.parse(after);
      const timeoutMs =
        options.timeoutMs === undefined
          ? undefined
          : TimerDelaySchema.parse(options.timeoutMs);

      if (parsedAfter > revision) {
        throw new RangeError(
          `Revision signal cannot wait after future revision ${parsedAfter}; current revision is ${revision}`,
        );
      }
      waits += 1;
      if (state === 'closed') return Promise.resolve(result('closed'));
      if (parsedAfter < revision) return Promise.resolve(result('changed'));
      if (options.signal?.aborted) return Promise.resolve(result('aborted'));
      if (waiters.size >= maxWaiters) return Promise.resolve(result('capacity'));

      return new Promise<RevisionSignalWaitResult>((resolve) => {
        let settled = false;
        let timer: RevisionSignalTimer | undefined;
        const waiter: RevisionWaiter = {
          settle(outcome) {
            if (settled) return;
            settled = true;
            timer?.cancel();
            options.signal?.removeEventListener('abort', onAbort);
            waiters.delete(waiter);
            resolve(result(outcome));
          },
        };
        function onAbort(): void {
          waiter.settle('aborted');
        }

        waiters.add(waiter);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (timeoutMs !== undefined) {
          try {
            const scheduled = clock.schedule(() => waiter.settle('timed-out'), timeoutMs);
            timer = scheduled;
            if (settled) scheduled.cancel();
          } catch (error) {
            settled = true;
            options.signal?.removeEventListener('abort', onAbort);
            waiters.delete(waiter);
            clockFailures += 1;
            throw error;
          }
        }
      });
    },
    close() {
      if (state === 'closed') return snapshot();
      state = 'closed';
      for (const waiter of [...waiters]) waiter.settle('closed');
      return snapshot();
    },
    getSnapshot: snapshot,
  };
}
