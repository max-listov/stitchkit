import {
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
} from '../../src/agent-runtime';

export function purgeAdmission(conversationId = 'target', suffix = '1') {
  const timestamp = '2026-08-31T00:00:00.000Z';
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${suffix}`,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: 'private input' }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `run-${suffix}`,
    conversationId,
    inputMessageIds: [input.id],
    assistantMessageId: `assistant-${suffix}`,
    state: 'queued',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return { idempotencyKey: `request-${suffix}`, input, run };
}

export async function beginPurgeFixture(store: AgentRuntimeStore, conversationId = 'target') {
  const admission = purgeAdmission(conversationId);
  await store.acceptInputAndAssignRun(admission);
  const acquired = await store.acquireRun({
    conversationId,
    runId: admission.run.id,
    expectedRevision: 0,
    ownerId: 'owner',
  });
  if (acquired.outcome !== 'applied') throw new Error('fixture acquire failed');
  const run = acquired.snapshot.runs[0];
  if (!run) throw new Error('fixture run missing');
  const assistant = AgentMessageSchema.parse({
    ...admission.input,
    id: run.assistantMessageId,
    role: 'assistant',
    runId: run.id,
    status: 'completed',
    parts: [{ type: 'text', text: 'private answer' }],
  });
  const terminal = {
    conversationId,
    runId: run.id,
    expectedRevision: run.revision,
    ownerId: 'owner',
    fencingToken: run.fencingToken,
    assistant,
  };
  return { admission, terminal };
}

export async function completePurgeFixture(
  store: AgentRuntimeStore,
  conversationId = 'target',
) {
  const { admission, terminal } = await beginPurgeFixture(store, conversationId);
  const result = await store.commitRunTerminal({ ...terminal, reason: 'success' });
  if (result.outcome !== 'applied') throw new Error('fixture terminal failed');
  return { admission, terminal, snapshot: result.snapshot };
}
