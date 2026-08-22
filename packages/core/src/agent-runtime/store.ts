import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  AgentRunSchema,
  type AgentSnapshot,
  AgentSnapshotSchema,
  AgentTerminalReasonSchema,
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
  assistant: AgentMessageSchema,
});
export const CommitRunTerminalSchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  expectedRevision: AgentRecordVersionSchema,
  ownerId: z.string().min(1),
  assistant: AgentMessageSchema,
  reason: AgentTerminalReasonSchema,
  policyName: z.string().min(1).optional(),
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
  loadSnapshot(conversationId: string): Promise<AgentSnapshot>;
  acceptInputAndAssignRun(input: AcceptInputAndAssignRun): Promise<AgentStoreMutationResult>;
  acquireRun(input: AcquireAgentRun): Promise<AgentStoreMutationResult>;
  checkpointRunAssistant(input: CheckpointRunAssistant): Promise<AgentStoreMutationResult>;
  requestRunInterrupt(input: RequestRunInterrupt): Promise<AgentStoreMutationResult>;
  recoverRun(input: RecoverAgentRun): Promise<AgentStoreMutationResult>;
  commitRunTerminal(input: CommitRunTerminal): Promise<AgentStoreMutationResult>;
  replaceCompactedRange(input: ReplaceCompactedRange): Promise<AgentStoreMutationResult>;
  scanRecoverable(): Promise<readonly AgentSnapshot[]>;
  scanRecoverablePage?(input: {
    cursor?: string;
    limit: number;
  }): Promise<import('./store-driver').AgentRecoverablePage>;
}
