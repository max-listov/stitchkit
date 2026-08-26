import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  type AgentRun,
  AgentRunSchema,
  type AgentSnapshot,
  AgentSnapshotSchema,
  AgentTerminalReasonSchema,
  AgentUsageSchema,
} from './schemas';

export const AgentStoreConflictSchema = z.object({
  outcome: z.literal('conflict'),
  actualVersion: AgentRecordVersionSchema,
});
export const AgentStoreNotFoundSchema = z.object({ outcome: z.literal('not_found') });
export const AgentStoreAppliedSchema = z.object({
  outcome: z.literal('applied'),
  snapshot: AgentSnapshotSchema,
});
export const AgentStoreDuplicateSchema = z.object({
  outcome: z.literal('duplicate'),
  input: AgentMessageSchema,
  inputMessageId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  assistantMessageId: AgentRecordIdSchema,
  run: AgentRunSchema,
  assistant: AgentMessageSchema.optional(),
  snapshot: AgentSnapshotSchema,
});
export const AgentStoreMutationResultSchema = z.discriminatedUnion('outcome', [
  AgentStoreAppliedSchema,
  AgentStoreDuplicateSchema,
  AgentStoreConflictSchema,
  AgentStoreNotFoundSchema,
]);
export type AgentStoreMutationResult = z.infer<typeof AgentStoreMutationResultSchema>;

/**
 * One run, read without reading the conversation it belongs to.
 *
 * `loadSnapshot` was the only way to resolve a `runId`, and most of the runtime
 * only ever wanted the run: the fencing check that runs before **every tool
 * call** loaded every message in the conversation to compare two numbers. A
 * twenty-tool run in a five-thousand-message conversation read a hundred
 * thousand messages to learn nothing about any of them.
 *
 * `assistant` is the retained terminal message, so it is present exactly when
 * the run is terminal — which is when anything asks for it.
 */
export const AgentRunViewSchema = z.object({
  /** The conversation's version at the moment of the read. */
  snapshotVersion: AgentRecordVersionSchema,
  run: AgentRunSchema,
  assistant: AgentMessageSchema.optional(),
});

export type AgentRunView = z.infer<typeof AgentRunViewSchema>;

export const AcceptInputAndAssignRunSchema = z.object({
  idempotencyKey: z.string().min(1),
  expectedVersion: AgentRecordVersionSchema.optional(),
  input: AgentMessageSchema,
  run: AgentRunSchema,
  coalesceIntoRunId: AgentRecordIdSchema.optional(),
});
export const AcquireAgentRunSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
});
export const CheckpointRunAssistantSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  fencingToken: AgentRecordVersionSchema.optional(),
  assistant: AgentMessageSchema,
  /**
   * What the run has cost so far.
   *
   * Persisted at every checkpoint, not only at the terminal commit, because a
   * process that dies mid-stream never reaches the terminal commit — and the
   * figure it had counted lived only in an event its executor did not survive
   * to emit. A requeued attempt continues from the last checkpointed value.
   */
  usage: AgentUsageSchema.optional(),
});
export const CommitRunTerminalSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  fencingToken: AgentRecordVersionSchema.optional(),
  assistant: AgentMessageSchema,
  reason: AgentTerminalReasonSchema,
  policyName: z.string().min(1).optional(),
  /** What the run cost, persisted with its terminal record (→ ADR 0110). */
  usage: AgentUsageSchema.optional(),
  /**
   * Queued runs whose input this run took on and answered.
   *
   * They are terminalized with `terminalReason: 'absorbed'` **in this same
   * transaction**, and their inputs join this run's `inputMessageIds`. That
   * ordering is the whole design (→ ADR 0113): the 0.63.0 version committed the
   * absorption at a step boundary, before the answer existed, which left an
   * accepted input that no path could ever answer.
   *
   * Nothing durable happens until this call, so a run that crashes, is closed,
   * or is interrupted after taking an input on leaves an ordinary queued
   * successor — which every other policy already produces and recovery already
   * handles.
   *
   * Only a **completing** reason may carry this. An entry whose run is no
   * longer queued is dropped rather than failing the commit: the answer this
   * run produced is not held hostage to a successor's bookkeeping, and a
   * dropped entry simply runs on its own.
   */
  absorb: z
    .array(
      z.object({
        runId: AgentRecordIdSchema,
        inputMessageIds: z.array(AgentRecordIdSchema).min(1),
      }),
    )
    .min(1)
    .optional(),
});
export const RequestRunInterruptSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
});
export const RecoverAgentRunSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  action: z.enum(['requeue', 'abandon']),
  replaySafe: z.boolean().optional(),
});
export const ReplaceCompactedRangeSchema = z.object({
  conversationId: AgentRecordIdSchema,
  expectedVersion: AgentRecordVersionSchema,
  replacedMessageIds: z.array(AgentRecordIdSchema).min(1),
  summary: AgentMessageSchema,
});

export type AcceptInputAndAssignRun = z.infer<typeof AcceptInputAndAssignRunSchema>;
export type AcquireAgentRun = z.infer<typeof AcquireAgentRunSchema>;
export type CheckpointRunAssistant = z.infer<typeof CheckpointRunAssistantSchema>;
export type CommitRunTerminal = z.infer<typeof CommitRunTerminalSchema>;
export type RequestRunInterrupt = z.infer<typeof RequestRunInterruptSchema>;
export type RecoverAgentRun = z.infer<typeof RecoverAgentRunSchema>;
export type ReplaceCompactedRange = z.infer<typeof ReplaceCompactedRangeSchema>;

export interface AgentRuntimeStore {
  /**
   * The whole conversation — every message and every run.
   *
   * Unbounded by construction, and the only read that is. Ask for it when you
   * need the conversation: composing a prompt, or compacting. To resolve a
   * `runId`, or to ask what is in flight, use `loadRun` / `listActiveRuns` —
   * they read one record and are the calls the runtime itself uses. See
   * "Reading a conversation" in the agent-runtime guide for what this costs and
   * what bounds it.
   */
  loadSnapshot(conversationId: string): Promise<AgentSnapshot>;
  /** One run by id. `undefined` if this conversation has no such run. */
  loadRun(input: { conversationId: string; runId: string }): Promise<AgentRunView | undefined>;
  /**
   * Every run of this conversation that has not reached a terminal state,
   * oldest first by `createdAt` and then by `id`.
   *
   * Deliberately a weaker order than `AgentSnapshot.runs`, which breaks a
   * `createdAt` tie by where the run sits in the conversation's history. That
   * tiebreak needs the history, and reading it is the cost this call exists to
   * avoid.
   */
  listActiveRuns(conversationId: string): Promise<readonly AgentRun[]>;
  acceptInputAndAssignRun(input: AcceptInputAndAssignRun): Promise<AgentStoreMutationResult>;
  acquireRun(input: AcquireAgentRun): Promise<AgentStoreMutationResult>;
  checkpointRunAssistant(input: CheckpointRunAssistant): Promise<AgentStoreMutationResult>;
  requestRunInterrupt(input: RequestRunInterrupt): Promise<AgentStoreMutationResult>;
  recoverRun(input: RecoverAgentRun): Promise<AgentStoreMutationResult>;
  commitRunTerminal(input: CommitRunTerminal): Promise<AgentStoreMutationResult>;
  replaceCompactedRange(input: ReplaceCompactedRange): Promise<AgentStoreMutationResult>;
  /**
   * One bounded page of recoverable runs.
   *
   * Bounded is the whole point (→ ADR 0101): recovery must not depend on
   * loading every recoverable conversation into memory to start. The driver
   * member of the same name has the same shape, so an adapter implements this
   * once at whichever level it plugs in.
   */
  scanRecoverable(input: {
    cursor?: string;
    limit: number;
  }): Promise<import('./store-driver').AgentRecoverablePage>;
}
