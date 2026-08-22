import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  AgentRunSchema,
  type AgentRuntimeStore,
  createMemoryAgentRuntimeStore,
  structuredCompaction,
} from '../src/agent-runtime';
import { createAgentRaceBarrier } from '../src/agent-runtime/testing';

const timestamp = '2026-08-22T00:00:00.000Z';

async function appendCompletedTurn(store: AgentRuntimeStore, index: number): Promise<void> {
  const input = AgentMessageSchema.parse({
    schemaVersion: 1,
    id: `input-${index}`,
    conversationId: 'conversation-1',
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: `question ${index}` }],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: `run-${index}`,
    conversationId: 'conversation-1',
    inputMessageIds: [input.id],
    assistantMessageId: `assistant-${index}`,
    state: 'queued',
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await store.acceptInputAndAssignRun({ idempotencyKey: `request-${index}`, input, run });
  const acquired = await store.acquireRun({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: 0,
    ownerId: 'test-runtime',
  });
  if (acquired.outcome !== 'applied') throw new Error('fixture run was not acquired');
  const current = acquired.snapshot.runs.find((candidate) => candidate.id === run.id);
  if (!current) throw new Error('fixture run missing');
  await store.commitRunTerminal({
    conversationId: 'conversation-1',
    runId: run.id,
    expectedRevision: current.revision,
    ownerId: 'test-runtime',
    assistant: AgentMessageSchema.parse({
      schemaVersion: 1,
      id: run.assistantMessageId,
      conversationId: 'conversation-1',
      runId: run.id,
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: `answer ${index}` }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    reason: 'success',
  });
}

describe('structured agent compaction', () => {
  test('does not apply a stale summary after a concurrent input', async () => {
    const store = createMemoryAgentRuntimeStore();
    await appendCompletedTurn(store, 1);
    await appendCompletedTurn(store, 2);
    await appendCompletedTurn(store, 3);
    const barrier = createAgentRaceBarrier();
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      threshold: () => true,
      async summarize() {
        await barrier.wait();
        return { summary: 'old summary' };
      },
      createSummaryMessage: ({ conversationId, summary }) =>
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: 'summary-1',
          conversationId,
          role: 'summary',
          status: 'committed',
          parts: [{ type: 'text', text: summary.summary }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
    });

    const resultPromise = compact({
      conversationId: 'conversation-1',
      store,
      signal: new AbortController().signal,
    });
    await barrier.reached;
    await appendCompletedTurn(store, 4);
    barrier.release();
    const result = await resultPromise;

    expect(result.outcome).toBe('conflict');
    const canonical = await store.loadSnapshot('conversation-1');
    expect(canonical.messages.some((message) => message.id === 'summary-1')).toBeFalse();
    expect(canonical.messages).toHaveLength(8);
  });
});
