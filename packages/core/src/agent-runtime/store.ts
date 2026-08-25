import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
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
});
/**
 * Move a queued successor's inputs into the run already answering, atomically.
 *
 * The alternative — attaching a new input straight to a running run — has a
 * loss case with no honest answer: the run may terminate before the loop ever
 * reaches a step boundary, and the input is then recorded as answered by a turn
 * that never saw it. Accepting it as an ordinary successor first means the
 * fallback is simply that the successor runs, which is the behaviour every
 * other policy already has.
 */
export const AbsorbQueuedRunSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runningRunId: AgentRecordIdSchema,
  runningExpectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  fencingToken: AgentRecordVersionSchema.optional(),
  queuedRunId: AgentRecordIdSchema,
  queuedExpectedRevision: AgentRecordVersionSchema,
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
export type AbsorbQueuedRun = z.infer<typeof AbsorbQueuedRunSchema>;
export type RequestRunInterrupt = z.infer<typeof RequestRunInterruptSchema>;
export type RecoverAgentRun = z.infer<typeof RecoverAgentRunSchema>;
export type ReplaceCompactedRange = z.infer<typeof ReplaceCompactedRangeSchema>;

export interface AgentRuntimeStore {
  loadSnapshot(conversationId: string): Promise<AgentSnapshot>;
  acceptInputAndAssignRun(input: AcceptInputAndAssignRun): Promise<AgentStoreMutationResult>;
  acquireRun(input: AcquireAgentRun): Promise<AgentStoreMutationResult>;
  checkpointRunAssistant(input: CheckpointRunAssistant): Promise<AgentStoreMutationResult>;
  requestRunInterrupt(input: RequestRunInterrupt): Promise<AgentStoreMutationResult>;
  absorbQueuedRun(input: AbsorbQueuedRun): Promise<AgentStoreMutationResult>;
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
