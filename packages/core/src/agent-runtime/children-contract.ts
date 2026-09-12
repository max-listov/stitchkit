import { z } from 'zod';
import type { AgentUsage } from './schemas';
export const AgentChildBudgetSchema = z
  .object({
    usd: z.number().positive().optional(),
    tokens: z.int().positive().optional(),
    milliseconds: z.int().positive().optional(),
  })
  .strict();
export type AgentChildBudget = z.infer<typeof AgentChildBudgetSchema>;

export const AgentChildStateSchema = z.enum([
  'spawned',
  'running',
  'finished',
  'stopped',
  'lost',
]);
export type AgentChildState = z.infer<typeof AgentChildStateSchema>;

export const AgentChildRecordSchema = z
  .object({
    parentConversationId: z.string().min(1),
    childConversationId: z.string().min(1),
    seedUptoSeq: z.int().nonnegative(),
    state: AgentChildStateSchema,
    budget: AgentChildBudgetSchema,
    usage: z
      .object({
        tokens: z.int().nonnegative(),
        usd: z.number().nonnegative(),
        milliseconds: z.int().nonnegative(),
      })
      .strict(),
    resultReference: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type AgentChildRecord = z.infer<typeof AgentChildRecordSchema>;

/**
 * A child is a separate conversation with its own harness, so an approval or
 * input request is raised inside it. The parent owns presentation (ADR 0179):
 * the manager relays the request to the parent once and routes the parent's
 * answer back. This is the source shape an `AgentChildHandle` reports.
 */
export const AgentChildBlockingKindSchema = z.enum(['approval', 'input']);
export type AgentChildBlockingKind = z.infer<typeof AgentChildBlockingKindSchema>;

export const AgentChildBlockingSourceSchema = z
  .object({
    /** The child-local request id the child harness knows. */
    approvalId: z.string().min(1),
    callId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.json(),
    kind: AgentChildBlockingKindSchema.default('approval'),
    /**
     * Presentation grouping only. Each request requires its own answer;
     * absent means this request is its own group.
     */
    batchId: z.string().min(1).optional(),
  })
  .strict();
export type AgentChildBlockingSource = z.infer<typeof AgentChildBlockingSourceSchema>;

/** A blocking event as the parent presents it: the id is rewritten under the child. */
export const AgentChildBlockingEventSchema = z
  .object({
    parentConversationId: z.string().min(1),
    childConversationId: z.string().min(1),
    kind: AgentChildBlockingKindSchema,
    /** Parent-scoped id: `${childConversationId}:${childApprovalId}`. */
    approvalId: z.string().min(1),
    childApprovalId: z.string().min(1),
    callId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.json(),
    batchId: z.string().min(1),
    presentedAt: z.string(),
  })
  .strict();
export type AgentChildBlockingEvent = z.infer<typeof AgentChildBlockingEventSchema>;

/** The parent's answer to a presented child blocking event. */
export const ChildBlockingDecisionSchema = z.union([
  z
    .object({
      approvalId: z.string().min(1),
      approved: z.boolean(),
      reason: z.string().optional(),
    })
    .strict(),
  z.object({ approvalId: z.string().min(1), value: z.json() }).strict(),
]);
export type AgentChildBlockingDecision = z.infer<typeof ChildBlockingDecisionSchema>;

const ChildRowSchema = z.object({
  parent_conversation_id: z.string(),
  child_conversation_id: z.string(),
  seed_upto_seq: z.int().nonnegative(),
  state: AgentChildStateSchema,
  budget_payload: z.string(),
  usage_payload: z.string(),
  result_reference: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function parseChild(raw: unknown): AgentChildRecord {
  const row = ChildRowSchema.parse(raw);
  return AgentChildRecordSchema.parse({
    parentConversationId: row.parent_conversation_id,
    childConversationId: row.child_conversation_id,
    seedUptoSeq: row.seed_upto_seq,
    state: row.state,
    budget: JSON.parse(row.budget_payload),
    usage: JSON.parse(row.usage_payload),
    ...(row.result_reference && { resultReference: row.result_reference }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function usageNumbers(usage: AgentUsage): { tokens?: number; usd?: number } {
  const inputTokens = usage.inputTokens.value;
  const outputTokens = usage.outputTokens.value;
  return {
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { tokens: inputTokens + outputTokens }
      : {}),
    ...(usage.cost?.currency === 'USD' && usage.cost.value !== undefined
      ? { usd: usage.cost.value }
      : {}),
  };
}

export interface AgentChildHandle {
  result: Promise<{ resultReference?: string }>;
  stopPolicy(name: string): void | Promise<void>;
  sendMessage?(input: unknown): void | Promise<void>;
  reachable?(): boolean | Promise<boolean>;
  /**
   * Child-local blocking events the parent must own. The host wires this to
   * its child harness (`pendingApprovals`); the manager presents them on the
   * parent and never on the child. → ADR 0179
   */
  blockingEvents?():
    | readonly AgentChildBlockingSource[]
    | Promise<readonly AgentChildBlockingSource[]>;
  /** Route the parent's answer to the child harness (`respondToApproval`). */
  respondToBlocking?(decision: AgentChildBlockingDecision): void | Promise<void>;
}

export interface AgentChildManager {
  spawnChild(request: {
    parentConversationId: string;
    childConversationId?: string;
    seedUptoSeq?: number;
    childInput: unknown;
    budget: AgentChildBudget;
  }): Promise<AgentChildRecord>;
  listChildren(parentConversationId: string): readonly AgentChildRecord[];
  recordStepUsage(request: {
    childConversationId: string;
    usage: AgentUsage;
    elapsedMs: number;
  }): Promise<{
    stop: boolean;
    /** Whether a stop was delivered to the child's host from this process. */
    enforced: boolean;
    policyName?: string;
    overrun: { tokens: number; usd: number; milliseconds: number };
  }>;
  stopChildren(parentConversationId: string): Promise<void>;
  sendMessage(
    parentConversationId: string,
    childConversationId: string,
    input: unknown,
  ): Promise<void>;
  interruptChild(parentConversationId: string, childConversationId: string): Promise<void>;
  waitChild(childConversationId: string): Promise<void>;
  /**
   * Present each live child's blocking events on the parent exactly once and
   * return the pending set. Never writes a presentation event to the child's
   * own conversation. → ADR 0179
   */
  listChildBlocking(parentConversationId: string): Promise<readonly AgentChildBlockingEvent[]>;
  /**
   * Route the parent's answer to the child that raised the request. A missing,
   * stale or already-answered id is refused. Answering one request preserves
   * every unanswered sibling, including requests in the same presentation batch.
   */
  respondToChildBlocking(
    parentConversationId: string,
    decision: AgentChildBlockingDecision,
  ): Promise<void>;
}
