import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalAgentJson } from '../src/agent-runtime/store-events';
import { createMemoryAgentRuntimeStore } from '../src/entrypoints/agent-runtime';
import { branch, branchInput, branchTurn } from './support/agent-branch-fixture';
import { branchRuntime } from './support/agent-branch-runtime-fixture';

test('branches a real streamed runtime turn, preserves provider message references and continues its context', async () => {
  const store = createMemoryAgentRuntimeStore();
  const seen: string[] = [];
  let calls = 0;
  const runtime = branchRuntime(store, (prompt) => {
    calls++;
    seen.push(JSON.stringify(prompt));
  });
  try {
    await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'first',
      context: {},
      parts: [{ type: 'text', text: 'remember the original question' }],
      metadata: {},
    }).result;
    expect(calls).toBe(1);
    await branch(store, {
      requestKey: 'real',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source' },
    });
    expect(calls).toBe(1);
    await runtime.submit({
      conversationId: 'copy',
      idempotencyKey: 'continue',
      context: {},
      parts: [{ type: 'text', text: 'continue this conversation' }],
      metadata: {},
    }).result;
    expect(calls).toBe(2);
    expect(seen[1]).toContain('remember the original question');
    expect(seen[1]).toContain('retained answer');
    expect(seen[1]).toContain('continue this conversation');
  } finally {
    await runtime.close();
  }
});

test('a settled middle remains branchable while the later source run has a live checkpoint', async () => {
  const store = createMemoryAgentRuntimeStore();
  await branchTurn(store, 'source', 'settled');
  const run = {
    schemaVersion: 1,
    id: 'live',
    conversationId: 'source',
    inputMessageIds: ['input-live'],
    assistantMessageId: 'answer-live',
    state: 'queued',
    revision: 0,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  } satisfies Parameters<typeof store.acceptInputAndAssignRun>[0]['run'];
  await store.acceptInputAndAssignRun({
    idempotencyKey: 'live',
    input: branchInput('source', 'input-live'),
    run,
  });
  await store.acquireRun({
    conversationId: 'source',
    runId: 'live',
    expectedRevision: 0,
    ownerId: 'live-owner',
  });
  await store.checkpointRunAssistant({
    conversationId: 'source',
    runId: 'live',
    expectedRevision: 1,
    ownerId: 'live-owner',
    assistant: {
      ...branchInput('source', 'answer-live'),
      runId: 'live',
      role: 'assistant',
      status: 'streaming',
      parts: [
        { type: 'text', text: 'still writing' },
        { type: 'tool-call', callId: 'live-call', toolName: 'example', input: {} },
      ],
    },
  });
  const message = {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'live-call', toolName: 'example', input: {} }],
  };
  await store.appendEvent({
    conversationId: 'source',
    kind: 'provider/message',
    payload: {
      message,
      sha256: createHash('sha256').update(canonicalAgentJson(message)).digest('hex'),
    },
  });
  await expect(
    branch(store, {
      requestKey: 'tip',
      destinationConversationId: 'tip',
      source: { kind: 'conversation', conversationId: 'source' },
    }),
  ).rejects.toThrow('not settled');
  await branch(store, {
    requestKey: 'middle',
    destinationConversationId: 'middle',
    source: { kind: 'conversation', conversationId: 'source', throughRunId: 'settled' },
  });
  expect((await store.loadSnapshot('middle')).messages).toHaveLength(2);
  expect((await store.listActiveRuns('source'))[0]?.state).toBe('running');
  await expect(
    branch(store, {
      requestKey: 'live',
      destinationConversationId: 'bad',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: 'live' },
    }),
  ).rejects.toThrow('no exact settled event');
});
