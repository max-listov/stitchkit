import { z } from 'zod';
import type {
  AgentStoreEventEnvelope,
  AgentStoreEventPage,
  AppendAgentStoreEvent,
  ReadAgentStoreEvents,
} from './events';

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

/** Event kind recording one phase of an at-most-once effect: intent, accepted or uncertain. */
export const DURABILITY_EFFECT_EVENT_KIND = 'durability/effect';

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

const EffectIdentity = { runId: z.string().min(1), effectName: z.string().min(1) };

export const EffectEventPayloadSchema = z.discriminatedUnion('phase', [
  z.object({ ...EffectIdentity, phase: z.literal('intent') }),
  z.object({
    ...EffectIdentity,
    phase: z.literal('accepted'),
    /** `JSON.stringify` of the proof. A separate field so a corrupt value is decodable apart. */
    encoded: z.string(),
    /** Whether the proof came back from `run` or was found by `reconcile`. */
    via: z.enum(['run', 'reconcile']),
  }),
  z.object({ ...EffectIdentity, phase: z.literal('uncertain') }),
]);

export type EffectEventPayload = z.infer<typeof EffectEventPayloadSchema>;
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

/**
 * What an effect ended as. `uncertain` is a third answer, not a failure to
 * produce one: the effect may have happened, the recipient has no record of it,
 * and nothing here will try it again.
 */
export type EffectOutcome<P> =
  | { readonly outcome: 'accepted'; readonly proof: P }
  | { readonly outcome: 'uncertain' };

/** The two halves of an effect in another system. */
export interface EffectHandlers<P> {
  /**
   * Perform the effect, once, and return what the recipient named it — a
   * message id, a turn id. Called at most once per name, across every process
   * that shares the ledger.
   */
  run(): P | Promise<P>;
  /**
   * Find the effect at the recipient by the caller's own identity for it, and
   * return the same proof — or `null` when the recipient has no record. Called
   * only when an intent was recorded and no outcome was: the process that ran
   * the effect stopped before it could say how it ended.
   */
  reconcile(signal: AbortSignal): P | null | Promise<P | null>;
}

export interface EffectRunOptions extends StepRunOptions {
  /** How long `reconcile` may take, in milliseconds; its `signal` aborts at the deadline. Default 30 000. */
  reconcileTimeoutMs?: number;
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
  /**
   * Perform an effect in another system at most once.
   *
   * `step` records its result AFTER the body, so a body cut short by a crash
   * runs again — right for a computation, wrong for sending a message, where a
   * repeat is worse than a loss. Here the intent is recorded BEFORE `run`, and
   * its outcome after. A later call that finds the intent without an outcome
   * calls `reconcile`, never `run`: found is `accepted` with the proof, not
   * found is `uncertain`, and both are recorded, so neither is asked again.
   *
   * A `run` that throws leaves the intent standing — whether the effect
   * happened is exactly what is not known — and the call rejects with
   * `EffectUnresolvedError`; the next call reconciles. The proof is JSON of at
   * most 64 KiB: an identity, not a payload.
   */
  effect<P extends z.infer<ReturnType<typeof z.json>>>(
    name: string,
    handlers: EffectHandlers<P>,
    options?: EffectRunOptions,
  ): Promise<EffectOutcome<P>>;
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
 * An effect whose outcome could not be settled by this call.
 *
 * Its intent is recorded and stays recorded, so `run` is never called for this
 * name again; the next call reconciles instead. `reason` says which step did
 * not finish: `run` threw, `reconcile` threw or overran its deadline, or the
 * proof could not be recorded.
 */
export class EffectUnresolvedError extends Error {
  constructor(
    readonly effectName: string,
    readonly reason:
      | 'run-failed'
      | 'reconcile-failed'
      | 'reconcile-timeout'
      | 'proof-rejected',
    options?: { cause?: unknown },
  ) {
    super(`Effect "${effectName}" is unresolved (${reason}); its intent stands`, options);
    this.name = 'EffectUnresolvedError';
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
