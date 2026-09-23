import type { z } from 'zod';
import {
  DURABILITY_EVENT_EVENT_KIND,
  DURABILITY_STEP_EVENT_KIND,
  type DurabilityClock,
  type EffectHandlers,
  type EffectOutcome,
  type EffectRunOptions,
  type LocalStepDurability,
  type LocalStepDurabilityOptions,
  StepAbortedError,
  type StepRunOptions,
} from './contract';
import { executeEffect } from './effect';
import {
  type DurabilityLedgerView,
  effectKey,
  encodeDeliveredPayload,
  encodeStepResult,
  readDurabilityLedger,
  sleepParkKey,
  stepKey,
  waitParkKey,
} from './ledger';
import { executeSleep, executeWait, type ParkContext } from './parks';
import { notifyWaiters, stores, systemClock } from './scheduler';

export type {
  EffectHandlers,
  EffectOutcome,
  EffectRunOptions,
  LocalStepDurability,
  LocalStepDurabilityOptions,
  StepDurabilityLedger,
  StepRunOptions,
} from './contract';
export {
  DURABILITY_STEP_EVENT_KIND,
  EffectUnresolvedError,
  ParkAbortedError,
  ParkRecordDecodeError,
  StepAbortedError,
  StepResultDecodeError,
  StepResultNotSerializableError,
} from './contract';

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
    effects: new Map(),
    parks: new Map(),
    waiters: new Map(),
  };
  stores.set(store, inFlight);
  const {
    steps: inFlightSteps,
    effects: inFlightEffects,
    parks: inFlightParks,
    waiters: parkWaiters,
  } = inFlight;
  const clock: DurabilityClock = options.clock ?? systemClock;
  const view: DurabilityLedgerView = {
    steps: new Map(),
    effects: new Map(),
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

  const park: ParkContext = {
    store,
    conversationId,
    runId,
    signal: options.signal,
    subscribe: options.subscribe,
    clock,
    waiters: parkWaiters,
    readLedger,
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

  const effect = <P extends z.infer<ReturnType<typeof z.json>>>(
    name: string,
    handlers: EffectHandlers<P>,
    runOptions?: EffectRunOptions,
  ): Promise<EffectOutcome<P>> => {
    const key = effectKey(conversationId, runId, name);
    const existing = inFlightEffects.get(key);
    if (existing) {
      // Same boundary as `step`: the registry is keyed by the durable key, so
      // a second caller in this process shares the first one's single `run`.
      return detachedResult<EffectOutcome<P>>(existing);
    }
    const pending = executeEffect<P>(
      { store, conversationId, runId, signal: options.signal, readLedger },
      name,
      handlers,
      runOptions,
    );
    inFlightEffects.set(key, pending);
    releaseSettled(inFlightEffects, key, pending);
    return detachedResult<EffectOutcome<P>>(pending);
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
    const pending = executeSleep(park, name, seconds, runOptions);
    inFlightParks.set(key, pending);
    releaseSettled(inFlightParks, key, pending);
    return pending;
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
    const pending = executeWait<T>(park, input.event, input.id, runOptions);
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
    effect,
  };
}
