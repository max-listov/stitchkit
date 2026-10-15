import {
  type AgentMessage,
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  type BranchAgentConversationInput,
} from '../../src/entrypoints/agent-runtime';

export const branchTime = '2026-10-15T00:00:00.000Z';

export function branch(store: AgentRuntimeStore, input: BranchAgentConversationInput) {
  if (!store.branchConversation)
    throw new Error('Store does not implement branchConversation');
  return store.branchConversation(input);
}

export function branchInput(conversationId: string, id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: branchTime,
    updatedAt: branchTime,
  });
}

export async function branchTurn(
  store: AgentRuntimeStore,
  conversationId: string,
  id: string,
  parts?: AgentMessage['parts'],
) {
  const input = branchInput(conversationId, `input-${id}`);
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: `answer-${id}`,
    state: 'queued',
    revision: 0,
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `key-${id}`, input, run });
  await store.acquireRun({
    conversationId,
    runId: id,
    expectedRevision: 0,
    ownerId: 'source-owner',
  });
  const assistant = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: run.assistantMessageId,
    conversationId,
    runId: id,
    role: 'assistant',
    status: 'completed',
    parts: parts ?? [{ type: 'text', text: `answer ${id}` }],
    createdAt: branchTime,
    updatedAt: branchTime,
  });
  const result = await store.commitRunTerminal({
    conversationId,
    runId: id,
    expectedRevision: 1,
    ownerId: 'source-owner',
    assistant,
    reason: 'success',
  });
  if (result.outcome !== 'applied')
    throw new Error(`Fixture terminal failed: ${result.outcome}`);
  return result.snapshot;
}
