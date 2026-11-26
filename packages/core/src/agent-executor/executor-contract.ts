import { z } from 'zod';
import { AgentMessagePartSchema } from '../agent-parts/parts';
import { MAX_TIMER_MS } from '../internal/timers';
import { ExecutorDeltaSchema, ExecutorThreadDispositionSchema } from './vocabulary';

/** An id the contract carries: a turn, a thread, an executor, an instance, a profile. */
export const ExecutorIdSchema = z.string().min(1).max(256);
/** A monotonic count of grants of one thread: a report under an older fence is from a lease that ended. */
const Fence = z.int().positive();
/**
 * A turn's place among its thread's turns, as the server offered them: 1, 2, 3… It travels back
 * on every report, so a server that let a turn's receipt go still knows the turn is not a new one.
 */
export const TurnOrdinalSchema = z.int().positive();

/**
 * Leases are on threads, not turns. A thread's history lives in one engine
 * profile on one machine, so a thread is pinned to `executorId + profileId`,
 * and a second instance gets it only after the first released it or was
 * proven gone. TTLs run on the server's monotonic clock; the executor renews
 * every `ttlMs / 3` and never compares machine times.
 */
export const ThreadClaimSchema = z.strictObject({
  threadId: ExecutorIdSchema,
  executorId: ExecutorIdSchema,
  instance: ExecutorIdSchema,
  profileId: ExecutorIdSchema,
});
/**
 * Active thread lease grant carrying its monotonic fence and server TTL in milliseconds. The TTL
 * becomes the executor's renewal timer, so it states the timer ceiling: a grant past it would be
 * renewed at once and forever.
 */
export const ThreadLeaseSchema = z.strictObject({
  threadId: ExecutorIdSchema,
  fence: Fence,
  ttlMs: z.int().positive().max(MAX_TIMER_MS),
});
/** Request payload to renew an active thread lease under its current instance and fence. */
export const ThreadRenewSchema = z.strictObject({
  threadId: ExecutorIdSchema,
  instance: ExecutorIdSchema,
  fence: Fence,
});
/** Request payload to release an active thread lease under its current instance and fence. */
export const ThreadReleaseSchema = ThreadRenewSchema;

/**
 * A turn the server offers a leased thread. `turnId`, `threadId` and `turnOrdinal` are the
 * server's: a later turn of a thread gets a larger ordinal.
 */
export const TurnOfferSchema = z.strictObject({
  turnId: ExecutorIdSchema,
  threadId: ExecutorIdSchema,
  turnOrdinal: TurnOrdinalSchema,
  fence: Fence,
  input: z.array(AgentMessagePartSchema).min(1),
  /** The input's digest, so a resent offer is recognized as the same turn. */
  inputDigest: z.string().min(1),
  /** The engine's own session id once known: only a join key, never an identity. */
  nativeThreadId: z.string().min(1).optional(),
});

/**
 * Where a turn stands, as the executor reports it:
 * `leased → dispatching → delivered → completed | interrupted | failed | unknown`,
 * and `unknown_after_restart` for a turn that was `dispatching` when the
 * executor died and whose engine cannot be asked (`reconcile: 'none'`).
 * `cancelled` is the server's word alone, and a refusal before acceptance is
 * an operation error, not a phase.
 */
export const TurnPhaseSchema = z.enum([
  'leased',
  'dispatching',
  'delivered',
  'completed',
  'interrupted',
  'failed',
  'unknown',
  'unknown_after_restart',
]);

/** Closed classification of terminal failure kinds reported by an executor turn. */
export const TurnFailureKindSchema = z.enum([
  'authRequired',
  'rateLimited',
  'engineCrashed',
  'protocol',
  'timeout',
  'staleTurn',
]);

/**
 * One report of a turn. `executorSeq` numbers this executor's reports of the
 * turn, so a report resent after a lost answer is applied once; the server
 * acknowledges the highest it holds. It is not the thread's `sequence` that
 * readers page by — the server assigns that.
 */
export const TurnReportSchema = z.strictObject({
  turnId: ExecutorIdSchema,
  threadId: ExecutorIdSchema,
  /** The ordinal the turn was offered under. */
  turnOrdinal: TurnOrdinalSchema,
  instance: ExecutorIdSchema,
  fence: Fence,
  executorSeq: z.int().positive(),
  phase: TurnPhaseSchema,
  deltas: z.array(ExecutorDeltaSchema).max(512),
  failure: z
    .strictObject({
      kind: TurnFailureKindSchema,
      message: z.string().min(1).max(4096),
      threadDisposition: ExecutorThreadDispositionSchema.optional(),
    })
    .optional(),
});
/**
 * The server's answer to a turn report. `applied` — this report advanced the turn, and the
 * server records its deltas; `duplicate` — a resend of what the server already holds, up to
 * `ackedSeq`; `not-retained` — the server keeps the last turns of each thread only, has let
 * older ones go, and holds no receipt of this one: a resend of a turn it already accepted and
 * then forgot, which the executor stops resending. Nothing is recorded for it.
 */
export const TurnReportAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied'), ackedSeq: z.int().positive() }),
  z.strictObject({ outcome: z.literal('duplicate'), ackedSeq: z.int().positive() }),
  z.strictObject({ outcome: z.literal('not-retained') }),
]);

/** Request payload to interrupt an in-flight turn on a leased thread. */
export const TurnInterruptSchema = z.strictObject({
  turnId: ExecutorIdSchema,
  threadId: ExecutorIdSchema,
});

/** An answer to an engine's request. A reply to an unknown `interactionId` is refused, never guessed. */
export const InteractionReplySchema = z.strictObject({
  turnId: ExecutorIdSchema,
  interactionId: ExecutorIdSchema,
  reply: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('approve'),
      /** Approval lifetime: one-shot (`once`, default when omitted) or session-scoped (`session`). */
      scope: z.enum(['once', 'session']).optional(),
      /** Optional rewritten tool input object forwarded when the engine supports tool input rewriting. */
      updatedInput: z.record(z.string(), z.json()).optional(),
    }),
    z.strictObject({
      kind: z.literal('deny'),
      message: z.string().min(1),
      /** When `true`, cancel/interrupt the running turn immediately rather than letting it continue. */
      interrupt: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal('input'), value: z.json() }),
  ]),
});

/** Refusal codes of the contract's operations. */
export const EXECUTOR_ERRORS = {
  fenceStale: 'EXECUTOR_FENCE_STALE',
  threadLeased: 'EXECUTOR_THREAD_LEASED',
  unknownTurn: 'EXECUTOR_UNKNOWN_TURN',
  invalidPhase: 'EXECUTOR_INVALID_PHASE',
} as const;

/** Thread lease claim payload inferred from `ThreadClaimSchema`. */
export type ThreadClaim = z.infer<typeof ThreadClaimSchema>;
/** Granted thread lease payload inferred from `ThreadLeaseSchema`. */
export type ThreadLease = z.infer<typeof ThreadLeaseSchema>;
/** Server-issued turn offer inferred from `TurnOfferSchema`. */
export type TurnOffer = z.infer<typeof TurnOfferSchema>;
/** Executor-reported turn lifecycle phase inferred from `TurnPhaseSchema`. */
export type TurnPhase = z.infer<typeof TurnPhaseSchema>;
/** Executor turn progress report inferred from `TurnReportSchema`. */
export type TurnReport = z.infer<typeof TurnReportSchema>;
/** The server's answer to a turn report, inferred from `TurnReportAckSchema`. */
export type TurnReportAck = z.infer<typeof TurnReportAckSchema>;
/** Answer to an engine interaction request inferred from `InteractionReplySchema`. */
export type InteractionReply = z.infer<typeof InteractionReplySchema>;
