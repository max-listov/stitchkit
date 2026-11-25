import { z } from 'zod';

const Id = z.string().min(1).max(256);
const Label = z.string().min(1).max(512);
const Count = z.int().nonnegative();
const Timestamp = z.iso.datetime({ offset: true });

/**
 * Who and what a model call is for. Free strings, no domain vocabulary (ADR 0002):
 * `scope` is the application's own boundary (a space, a tenant), `purpose` the job
 * (`live`, `compaction`, `title`), `operation` the stable name of the calling surface,
 * and `labels` whatever else the application filters on (`env`, `agentId`).
 */
export const SpendAttributionSchema = z.strictObject({
  scope: Label.optional(),
  purpose: Label,
  operation: Label.optional(),
  caller: Label.optional(),
  conversationId: Id.optional(),
  runId: Id.optional(),
  invocationId: Id.optional(),
  /** The agent runtime's attempt, when the call is one (`currentModelInvocationAttempt`). */
  invocationAttemptId: Id.optional(),
  step: Count.optional(),
  traceId: Id.optional(),
  parentSpanId: Id.optional(),
  labels: z.record(z.string().min(1).max(128), Label).optional(),
});
/** Who and what one model call is for; see {@link SpendAttributionSchema}. */
export type SpendAttribution = z.infer<typeof SpendAttributionSchema>;

/**
 * Where a cost came from. `reported` — the provider said it; `pending` — not yet
 * known, a reconciler may learn it; `unknown` — it will not be learned;
 * `estimated` — computed from a tariff, never summed with facts; `free` — the call
 * costs nothing by construction (a local model). Only `reported` and `free` carry
 * a number that counts as a fact; `pending` and `unknown` never carry one.
 */
export const SpendCostStatusSchema = z.enum([
  'reported',
  'pending',
  'unknown',
  'estimated',
  'free',
]);
/** Where a recorded cost came from; only `reported` and `free` are facts. */
export type SpendCostStatus = z.infer<typeof SpendCostStatusSchema>;

/**
 * How the attempt ended. `pending` — written before the call, not closed yet;
 * `succeeded`; `failed` — the provider or the transport refused; `aborted` — the
 * caller cancelled the request or the stream; `refused` — refused before anything
 * was sent; `orphaned` — closed by a sweep, its process never came back to it.
 */
export const SpendOutcomeSchema = z.enum([
  'pending',
  'succeeded',
  'failed',
  'aborted',
  'refused',
  'orphaned',
]);
/** How an attempt ended, `pending` until it is closed. */
export type SpendOutcome = z.infer<typeof SpendOutcomeSchema>;

/** What was observed about one attempt. Every field is optional: an attempt reports what it learned. */
export const SpendFactsSchema = z.strictObject({
  provider: Label.optional(),
  model: Label.optional(),
  resolvedModel: Label.optional(),
  providerRequestId: Id.optional(),
  httpStatus: z.int().min(100).max(599).optional(),
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  reasoningTokens: Count.optional(),
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
  /** Work that is not tokens (`seconds` of audio, `characters` spoken, `images` made), named freely. */
  workUnit: Label.optional(),
  workAmount: z.number().nonnegative().finite().optional(),
  costUsd: z.number().nonnegative().finite().optional(),
  costStatus: SpendCostStatusSchema,
  durationMs: Count.optional(),
  ttftMs: Count.optional(),
  failureCode: Label.optional(),
  /** Never request or response content: a code and a short reason. */
  failureMessage: z.string().max(1024).optional(),
});
/** What was observed about one attempt: tokens, cost and its status, timing, failure code. */
export type SpendFacts = z.infer<typeof SpendFactsSchema>;

/** The record written before the call: if nothing else survives, this does. */
export const SpendAttemptSchema = z.strictObject({
  attemptId: Id,
  gateway: Label,
  startedAt: Timestamp,
  attribution: SpendAttributionSchema,
  request: z.strictObject({
    method: z.string().min(1).max(16),
    origin: z.string().min(1).max(512),
    path: z.string().max(2048),
  }),
});
/** The record written before a call is sent. */
export type SpendAttempt = z.infer<typeof SpendAttemptSchema>;

/**
 * Which observer wrote a receipt; a higher rank knows more. 1 — the gateway closed
 * it from the transport; 2 — the provider's response reported usage; 3 — a
 * reconciler asked the provider afterwards.
 */
export const SpendReceiptRankSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
/** Which observer wrote a receipt: 1 transport, 2 reported usage, 3 reconciler. */
export type SpendReceiptRank = z.infer<typeof SpendReceiptRankSchema>;

/** One closing (or improving) observation of an attempt, merged by {@link mergeSpendReceipt}. */
export const SpendReceiptSchema = z.strictObject({
  attemptId: Id,
  rank: SpendReceiptRankSchema,
  at: Timestamp,
  outcome: SpendOutcomeSchema,
  facts: SpendFactsSchema,
});
/** One closing or improving observation of an attempt. */
export type SpendReceipt = z.infer<typeof SpendReceiptSchema>;

/** An attempt and what is known of it now: the row a ledger keeps. */
export const SpendRecordSchema = z.strictObject({
  attempt: SpendAttemptSchema,
  receipt: SpendReceiptSchema.optional(),
});
/** An attempt and its merged receipt, as a ledger keeps it. */
export type SpendRecord = z.infer<typeof SpendRecordSchema>;

/**
 * The application's ledger. Both writes are idempotent on `attemptId`: a spool
 * replays at least once. `settle` merges with {@link mergeSpendReceipt} — or the
 * same rule in the database (by rank, under a row lock) — so a late, lower-ranked
 * receipt never erases what a higher one learned.
 */
export interface SpendLedgerStore {
  begin(attempt: SpendAttempt): Promise<void>;
  settle(receipt: SpendReceipt): Promise<void>;
  /** Attempts whose cost is still `pending`, oldest first, for the reconciler. */
  pendingCosts?(input: { limit: number }): Promise<readonly SpendRecord[]>;
  /** Attempts with no closing receipt that started before `startedBefore`, for the sweep. */
  openAttempts?(input: {
    startedBefore: string;
    limit: number;
  }): Promise<readonly SpendAttempt[]>;
}
