import type { z } from 'zod';
import {
  DURABILITY_EVENT_EVENT_KIND,
  DURABILITY_PARK_EVENT_KIND,
  DURABILITY_STEP_EVENT_KIND,
  type DurabilityClock,
  type LocalStepDurability,
  type LocalStepDurabilityOptions,
  ParkAbortedError,
  ParkRecordDecodeError,
  StepAbortedError,
  type StepRunOptions,
} from './durability-contract';
import {
  type DurabilityLedgerView,
  encodeDeliveredPayload,
  encodeStepResult,
  readDurabilityLedger,
  sleepParkKey,
  stepKey,
  waitParkKey,
} from './durability-ledger';
import {
  createParkWaiter,
  notifyWaiters,
  stores,
  systemClock,
  waitForDeadline,
} from './durability-scheduler';

export type {
  LocalStepDurability,
  LocalStepDurabilityOptions,
  StepDurabilityLedger,
  StepRunOptions,
} from './durability-contract';
export {
  DURABILITY_STEP_EVENT_KIND,
  ParkAbortedError,
  ParkRecordDecodeError,
  StepAbortedError,
  StepResultDecodeError,
  StepResultNotSerializableError,
} from './durability-contract';

function releaseSettled(
  registry: Map<string, Promise<unknown>>,
  key: string,
  pending: Promise<unknown>,
) {
  const release = () => {
    if (registry.get(key) === pending) registry.delete(key);
  };
  void pending.then(release, release);
}

/** The registry stores validated JSON; each caller owns a separate decoded value. */
function detachedResult<T>(pending: Promise<unknown>): Promise<T> {
  // The durable key, rather than the type-erased registry, defines T.
  return pending.then((value) => JSON.parse(JSON.stringify(value)) as T);
}

/**
 * A local step-durability port over an `AgentRuntimeStore`.
 *
 * Replaying is reading the ledger: nothing is kept between instances, so a
 * fresh object over the same store resumes from the records that survived a
 * process restart. Completed records are append-only — there is no deletion
 * path — so cancellation cannot remove one, and a park that completed is never
 * created a second time.
 */
export function createLocalStepDurability(
  options: LocalStepDurabilityOptions,
): LocalStepDurability {
  const { store, conversationId, runId } = options;
  const inFlight = stores.get(store) ?? {
    steps: new Map(),
    parks: new Map(),
    waiters: new Map(),
  };
  stores.set(store, inFlight);
  const { steps: inFlightSteps, parks: inFlightParks, waiters: parkWaiters } = inFlight;
  const clock: DurabilityClock = options.clock ?? systemClock;
  const view: DurabilityLedgerView = {
    steps: new Map(),
    parks: new Map(),
    deliveries: new Map(),
    nextSeq: 1,
  };
  let reading = Promise.resolve(view);
  const readLedger = () => {
    reading = reading
      .catch(() => view)
      .then(() => readDurabilityLedger(store, conversationId, view));
    return reading;
  };

  const readRecordedStep = async (name: string): Promise<unknown | undefined> => {
    const key = stepKey(conversationId, runId, name);
    const records = await readLedger();
    const value = records.steps.get(key);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  };

  const execute = async <T extends z.infer<ReturnType<typeof z.json>>>(
    name: string,
    body: () => T | Promise<T>,
    runOptions: StepRunOptions | undefined,
  ): Promise<T> => {
    const recorded = await readRecordedStep(name);
    if (recorded !== undefined) {
      // The ledger type-erases results by key; the step's own generic is the
      // only type available for a value already proven present for this key.
      return recorded as T;
    }
    if (runOptions?.signal?.aborted || options.signal?.aborted)
      throw new StepAbortedError(name);
    const value = await body();
    const encoded = encodeStepResult(name, value);
    await store.appendEvent({
      conversationId,
      kind: DURABILITY_STEP_EVENT_KIND,
      payload: { runId, stepName: name, encoded },
    });
    // The lossless codec proves the JSON value; T belongs to this named step's boundary.
    return JSON.parse(encoded) as T;
  };

  const step = <T extends z.infer<ReturnType<typeof z.json>>>(
    name: string,
    body: () => T | Promise<T>,
    runOptions?: StepRunOptions,
  ): Promise<T> => {
    const key = stepKey(conversationId, runId, name);
    const existing = inFlightSteps.get(key);
    if (existing) {
      // Same boundary as `execute`: the in-flight registry is keyed by the
      // durable key, so the promise belongs to the same step's generic.
      return detachedResult<T>(existing);
    }
    const pending = execute<T>(name, body, runOptions);
    inFlightSteps.set(key, pending);
    releaseSettled(inFlightSteps, key, pending);
    return detachedResult<T>(pending);
  };

  const executeSleep = async (
    name: string,
    seconds: number,
    runOptions: StepRunOptions | undefined,
  ): Promise<void> => {
    const key = sleepParkKey(conversationId, runId, name);
    const signal =
      options.signal && runOptions?.signal
        ? AbortSignal.any([options.signal, runOptions.signal])
        : (runOptions?.signal ?? options.signal);
    const ledger = await readLedger();
    const existing = ledger.parks.get(key);
    let deadline: number;
    if (existing) {
      if (existing.kind !== 'sleep') {
        throw new ParkRecordDecodeError(`Recorded park "${name}" is not a sleep record`);
      }
      deadline = existing.deadline;
    } else {
      deadline = clock.now() + seconds * 1000;
      if (!Number.isSafeInteger(Math.ceil(deadline)))
        throw new TypeError('Sleep deadline exceeds the supported clock range');
      await store.appendEvent({
        conversationId,
        kind: DURABILITY_PARK_EVENT_KIND,
        payload: { runId, kind: 'sleep', name, deadline },
      });
    }
    if (signal?.aborted) throw new ParkAbortedError(name);
    await waitForDeadline(clock, deadline, name, signal);
  };

  const sleep = (
    input: { seconds: number; name?: string },
    runOptions?: StepRunOptions,
  ): Promise<void> => {
    const { seconds } = input;
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError(
        `sleep seconds must be a non-negative finite number, got ${String(seconds)}`,
      );
    }
    const name = input.name ?? `sleep:${seconds}`;
    const key = sleepParkKey(conversationId, runId, name);
    const existing = inFlightParks.get(key);
    if (existing) {
      // Same boundary as `step`: the registry is keyed by the durable key, so
      // the promise settles this exact park.
      return existing as Promise<void>;
    }
    const pending = executeSleep(name, seconds, runOptions);
    inFlightParks.set(key, pending);
    releaseSettled(inFlightParks, key, pending);
    return pending;
  };

  const executeWait = async <T>(
    eventName: string,
    id: string,
    runOptions: StepRunOptions | undefined,
  ): Promise<T> => {
    const key = waitParkKey(conversationId, runId, eventName, id);
    const park = `${eventName}#${id}`;
    const signal =
      options.signal && runOptions?.signal
        ? AbortSignal.any([options.signal, runOptions.signal])
        : (runOptions?.signal ?? options.signal);
    for (;;) {
      if (signal?.aborted) throw new ParkAbortedError(park);
      // Register before reading so a delivery landing during the read still
      // wakes this waiter; a resolved promise is not lost by being awaited late.
      const waiter = createParkWaiter(parkWaiters, key, signal);
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = options.subscribe?.(() => notifyWaiters(parkWaiters, key));
        const ledger = await readLedger();
        if (ledger.deliveries.has(key)) {
          // The ledger type-erases the payload by key; the wait's own generic is
          // the only type available for a value already proven present.
          return JSON.parse(JSON.stringify(ledger.deliveries.get(key))) as T;
        }
        if (!ledger.parks.has(key)) {
          await store.appendEvent({
            conversationId,
            kind: DURABILITY_PARK_EVENT_KIND,
            payload: { runId, kind: 'wait', event: eventName, id },
          });
        }
        const outcome = await waiter.outcome;
        if (outcome === 'aborted') throw new ParkAbortedError(park);
      } finally {
        waiter.cancel();
        unsubscribe?.();
      }
    }
  };

  const waitFor = <T = unknown>(
    input: { event: string; id: string },
    runOptions?: StepRunOptions,
  ): Promise<T> => {
    const key = waitParkKey(conversationId, runId, input.event, input.id);
    const existing = inFlightParks.get(key);
    if (existing) {
      // Same boundary as `step`: the registry is keyed by the durable key, so
      // the promise settles this exact wait.
      return detachedResult<T>(existing);
    }
    const pending = executeWait<T>(input.event, input.id, runOptions);
    inFlightParks.set(key, pending);
    releaseSettled(inFlightParks, key, pending);
    return detachedResult<T>(pending);
  };

  const deliver = async (input: {
    event: string;
    id: string;
    payload?: unknown;
  }): Promise<void> => {
    const key = waitParkKey(conversationId, runId, input.event, input.id);
    const ledger = await readLedger();
    if (!ledger.deliveries.has(key)) {
      const encoded = encodeDeliveredPayload(input.event, input.id, input.payload);
      await store.appendEvent({
        conversationId,
        kind: DURABILITY_EVENT_EVENT_KIND,
        payload: { runId, event: input.event, id: input.id, encoded },
      });
    }
    notifyWaiters(parkWaiters, key);
  };

  return {
    step,
    readRecordedStep,
    hasRecordedStep: async (name) => (await readRecordedStep(name)) !== undefined,
    sleep,
    waitFor,
    deliver,
  };
}
