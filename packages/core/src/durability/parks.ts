/**
 * The two parks — a durable sleep and a wait for a delivered event — as
 * functions over one engine's context. A park is recorded before it waits, so a
 * reconstruction resumes from the record instead of parking again.
 */
import { linkAbortSignals } from '../internal/abort-race';
import {
  DURABILITY_PARK_EVENT_KIND,
  type DurabilityClock,
  ParkAbortedError,
  ParkRecordDecodeError,
  type StepDurabilityLedger,
  type StepRunOptions,
} from './contract';
import { type DurabilityLedgerView, sleepParkKey, waitParkKey } from './ledger';
import {
  createParkWaiter,
  type InFlightDurability,
  notifyWaiters,
  waitForDeadline,
} from './scheduler';

/** What a park needs from the engine that owns it. */
export interface ParkContext {
  readonly store: StepDurabilityLedger;
  readonly conversationId: string;
  readonly runId: string;
  readonly signal: AbortSignal | undefined;
  readonly subscribe: ((wake: () => void) => () => void) | undefined;
  readonly clock: DurabilityClock;
  readonly waiters: InFlightDurability['waiters'];
  readLedger(): Promise<DurabilityLedgerView>;
}

/**
 * Run a park under the engine's signal and the call's, linked only while the park lasts: an
 * engine signal outlives every park it bounds, and must not retain one that has ended.
 */
async function withParkSignal<T>(
  park: ParkContext,
  runOptions: StepRunOptions | undefined,
  body: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!park.signal) return body(runOptions?.signal);
  const link = linkAbortSignals(runOptions?.signal, park.signal);
  try {
    return await body(link.signal);
  } finally {
    link.release();
  }
}

export function executeSleep(
  park: ParkContext,
  name: string,
  seconds: number,
  runOptions: StepRunOptions | undefined,
): Promise<void> {
  return withParkSignal(park, runOptions, (signal) => sleepPark(park, name, seconds, signal));
}

async function sleepPark(
  park: ParkContext,
  name: string,
  seconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const key = sleepParkKey(park.conversationId, park.runId, name);
  const ledger = await park.readLedger();
  const existing = ledger.parks.get(key);
  let deadline: number;
  if (existing) {
    if (existing.kind !== 'sleep') {
      throw new ParkRecordDecodeError(`Recorded park "${name}" is not a sleep record`);
    }
    deadline = existing.deadline;
  } else {
    deadline = park.clock.now() + seconds * 1000;
    if (!Number.isSafeInteger(Math.ceil(deadline)))
      throw new TypeError('Sleep deadline exceeds the supported clock range');
    await park.store.appendEvent({
      conversationId: park.conversationId,
      kind: DURABILITY_PARK_EVENT_KIND,
      payload: { runId: park.runId, kind: 'sleep', name, deadline },
    });
  }
  if (signal?.aborted) throw new ParkAbortedError(name);
  await waitForDeadline(park.clock, deadline, name, signal);
}

export function executeWait<T>(
  park: ParkContext,
  eventName: string,
  id: string,
  runOptions: StepRunOptions | undefined,
): Promise<T> {
  return withParkSignal(park, runOptions, (signal) =>
    waitPark<T>(park, eventName, id, signal),
  );
}

async function waitPark<T>(
  park: ParkContext,
  eventName: string,
  id: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  const key = waitParkKey(park.conversationId, park.runId, eventName, id);
  const label = `${eventName}#${id}`;
  for (;;) {
    if (signal?.aborted) throw new ParkAbortedError(label);
    // Register before reading so a delivery landing during the read still
    // wakes this waiter; a resolved promise is not lost by being awaited late.
    const waiter = createParkWaiter(park.waiters, key, signal);
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = park.subscribe?.(() => notifyWaiters(park.waiters, key));
      const ledger = await park.readLedger();
      if (ledger.deliveries.has(key)) {
        // The ledger type-erases the payload by key; the wait's own generic is
        // the only type available for a value already proven present.
        return JSON.parse(JSON.stringify(ledger.deliveries.get(key))) as T;
      }
      if (!ledger.parks.has(key)) {
        await park.store.appendEvent({
          conversationId: park.conversationId,
          kind: DURABILITY_PARK_EVENT_KIND,
          payload: { runId: park.runId, kind: 'wait', event: eventName, id },
        });
      }
      const outcome = await waiter.outcome;
      if (outcome === 'aborted') throw new ParkAbortedError(label);
    } finally {
      waiter.cancel();
      unsubscribe?.();
    }
  }
}
