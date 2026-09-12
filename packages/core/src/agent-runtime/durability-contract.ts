import { z } from 'zod';
import type {
  AgentStoreEventEnvelope,
  AgentStoreEventPage,
  AppendAgentStoreEvent,
  ReadAgentStoreEvents,
} from './store-events';

/**
 * The durable ledger a local step implementation needs.
 *
 * Narrower than `AgentRuntimeStore` on purpose: durability owns no records of
 * its own, it reads and appends the conversation's canonical event log, so a
 * store that already satisfies this slice can back it without the rest of the
 * runtime.
 *
 * A park (`sleep`/`waitFor`) is recorded the same way a step result is: as an
 * ordinary event in this ledger. The local scheduler waits in-process, and a
 * reconstruction resumes from the records that survived a restart.
 */
export interface StepDurabilityLedger {
  appendEvent(input: AppendAgentStoreEvent): Promise<AgentStoreEventEnvelope>;
  readEvents(input: ReadAgentStoreEvents): Promise<AgentStoreEventPage>;
}

/** Event kind carrying one recorded step result in the canonical ledger. */
export const DURABILITY_STEP_EVENT_KIND = 'durability/step';

/** Event kind recording that a run parked on time or on an external event. */
export const DURABILITY_PARK_EVENT_KIND = 'durability/park';

/** Event kind recording an external event delivered to a parked wait. */
export const DURABILITY_EVENT_EVENT_KIND = 'durability/event';

export const StepEventPayloadSchema = z.object({
  runId: z.string().min(1),
  stepName: z.string().min(1),
  /** `JSON.stringify` of the step's result. A separate field so a corrupt value is decodable apart. */
  encoded: z.string(),
});

const SleepParkSchema = z.object({
  runId: z.string().min(1),
  kind: z.literal('sleep'),
  name: z.string().min(1),
  /** Absolute wall-clock deadline in epoch milliseconds; survives a restart. */
  deadline: z.number(),
});

const WaitParkSchema = z.object({
  runId: z.string().min(1),
  kind: z.literal('wait'),
  event: z.string().min(1),
  id: z.string().min(1),
});

export const ParkEventPayloadSchema = z.discriminatedUnion('kind', [
  SleepParkSchema,
  WaitParkSchema,
]);

export const DeliveredEventPayloadSchema = z.object({
  runId: z.string().min(1),
  event: z.string().min(1),
  id: z.string().min(1),
  /** `JSON.stringify` of the delivered payload. A separate field so a corrupt value is decodable apart. */
  encoded: z.string(),
});

export type ParkEventPayload = z.infer<typeof ParkEventPayloadSchema>;
export type StepEventPayload = z.infer<typeof StepEventPayloadSchema>;

/**
 * The time source a park uses.
 *
 * `now` is the wall clock the durable sleep deadline is stamped from and
 * re-evaluated against, so a reconstructed park resumes from the recorded
 * value. A test replaces the pair with a manual clock to advance time without
 * waiting in real time.
 */
export interface DurabilityClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): { cancel(): void };
}

export interface LocalStepDurabilityOptions {
  store: StepDurabilityLedger;
  conversationId: string;
  runId: string;
  signal?: AbortSignal;
  /** Host-owned notification for ledger writes made by another process. */
  subscribe?(wake: () => void): () => void;
  /**
   * Injectable time source for `sleep`. Defaults to the wall clock and
   * `setTimeout`; a test passes a manual clock so advancing time
   * deterministically resumes a park without waiting in real time.
   */
  clock?: {
    now(): number;
    schedule(callback: () => void, delayMs: number): { cancel(): void };
  };
}

export interface StepRunOptions {
  /** Aborting refuses to *start* a body and releases a park; it never removes a record already written. */
  signal?: AbortSignal;
}

export interface LocalStepDurability {
  /**
   * Run `name` once and durably record its JSON result.
   *
   * The first execution runs `body` and appends the result to the ledger. A
   * replay — a fresh process, or a second durability object built over the same
   * store — decodes the record and returns it without calling `body` again.
   */
  step<T extends z.infer<ReturnType<typeof z.json>>>(
    name: string,
    body: () => T | Promise<T>,
    options?: StepRunOptions,
  ): Promise<T>;
  /** The decoded result of an already-recorded step, or `undefined` if none. */
  readRecordedStep(name: string): Promise<unknown | undefined>;
  /** Whether `name` has a recorded result. */
  hasRecordedStep(name: string): Promise<boolean>;
  /**
   * Wait on a lightweight local timer for `seconds`, retaining a durable deadline.
   *
   * The first call records a park with an absolute deadline; a replay whose
   * deadline has passed returns immediately, one before it waits out the
   * remainder. `name` is the park's identity within the run and must be stable
   * across replays. It defaults to the duration, so a caller that parks twice
   * for the same length must pass distinct names.
   */
  sleep(input: { seconds: number; name?: string }, options?: StepRunOptions): Promise<void>;
  /**
   * Park the run until an external event `{ event, id }` is delivered.
   *
   * Resolves with the delivered payload. A waiter that starts after delivery
   * returns immediately, as does a reconstruction that finds the delivery in
   * the ledger.
   */
  waitFor<T = unknown>(
    input: { event: string; id: string },
    options?: StepRunOptions,
  ): Promise<T>;
  /**
   * Durably record an external event and wake any waiter for it.
   *
   * The record is append-only and survives a restart: reconstruction finds it
   * and a `waitFor` for the same key resolves without a second delivery.
   */
  deliver(input: { event: string; id: string; payload?: unknown }): Promise<void>;
}

/**
 * The record for `name` cannot be trusted.
 *
 * Thrown instead of re-running `body`: a body is arbitrary and often effectful,
 * and a record that cannot be decoded is evidence the ledger is not what this
 * run wrote, never evidence the step never ran.
 */
export class StepResultDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StepResultDecodeError';
  }
}

/** A step body returned a value that cannot be represented as JSON. */
export class StepResultNotSerializableError extends Error {
  constructor(stepName: string, cause: unknown) {
    super(`Step "${stepName}" returned a value that is not JSON-serializable`, {
      cause,
    });
    this.name = 'StepResultNotSerializableError';
  }
}

/** The caller aborted before the step body was started. No record was written. */
export class StepAbortedError extends Error {
  constructor(stepName: string) {
    super(`Step "${stepName}" was aborted before it started`);
    this.name = 'StepAbortedError';
  }
}

/**
 * A park or delivered-event record cannot be trusted.
 *
 * Thrown instead of parking on a record whose shape is not ours: an
 * undecodable park is evidence the ledger is not what this run wrote, never
 * evidence the park never happened.
 */
export class ParkRecordDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParkRecordDecodeError';
  }
}

/**
 * A sleeping or waiting park was aborted before it was satisfied.
 *
 * No record is removed: the park stays in the ledger, so a later replay
 * resumes from the same durable state instead of starting a new park.
 */
export class ParkAbortedError extends Error {
  constructor(park: string) {
    super(`Park "${park}" was aborted before it was satisfied`);
    this.name = 'ParkAbortedError';
  }
}
