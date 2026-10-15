import assert from 'node:assert/strict';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  agentOutlineProjection,
  agentStateSlotsProjection,
  agentSummaryProjection,
  createAgentRuntime,
  createAgentStateSlotStore,
  createSqliteAgentProjectionStore,
  createSqliteAgentSpillStore,
  defineAgentProtocol,
  defineStateSlot,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';

/** Real public writes only; also runs unchanged against the published 0.109.4 SDK. */
export async function streamingFixture(sqlite) {
  const conversationId = 'stream-source';
  const spills = createSqliteAgentSpillStore({ sqlite, conversationId });
  const artifact = await spills.write({
    data: new TextEncoder().encode('streamed artifact evidence'),
    mediaType: 'text/plain',
    authorization: { operation: 'read', path: 'source-only' },
  });
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: sqlite.store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'stream-fixture',
          contextWindow: 4096,
          capabilities: [],
        },
        model: new MockLanguageModelV4({
          doStream: async () => {
            calls++;
            return {
              stream: simulateReadableStream({
                chunks:
                  calls === 1
                    ? [
                        {
                          type: 'tool-call',
                          toolCallId: 'fixture-call',
                          toolName: 'run_command',
                          input: '{}',
                        },
                        {
                          type: 'finish',
                          finishReason: { unified: 'tool-calls', raw: undefined },
                          usage,
                        },
                      ]
                    : [
                        { type: 'text-start', id: 'text' },
                        { type: 'text-delta', id: 'text', delta: 'streamed answer' },
                        { type: 'text-end', id: 'text' },
                        {
                          type: 'finish',
                          finishReason: { unified: 'stop', raw: undefined },
                          usage,
                        },
                      ],
              }),
            };
          },
        }),
      }),
    },
    prompt: () => ({
      instructions: 'fixture',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      run_command: tool({
        inputSchema: z.object({}),
        execute: async () => ({
          executable: 'fixture',
          exitCode: 0,
          signal: null,
          stdout: 'tool evidence',
          stderr: '',
          outcome: 'exited',
          artifact: {
            reference: artifact.reference,
            bytes: 26,
            truncated: true,
            headBytes: 0,
            tailBytes: 0,
            omittedBytes: 26,
          },
        }),
      }),
    }),
  });
  try {
    await runtime.submit({
      conversationId,
      idempotencyKey: 'stream',
      context: {},
      metadata: {},
      parts: [{ type: 'text', text: 'retain the original streamed question' }],
    }).result;
  } finally {
    await runtime.close();
  }
  assert.equal(calls, 2);
  const snapshot = await sqlite.store.loadSnapshot(conversationId);
  const runId = snapshot.runs[0]?.id;
  assert.ok(runId);
  assert.equal(snapshot.runs[0].state, 'completed');
  const compacted = await sqlite.store.replaceCompactedRange({
    conversationId,
    expectedVersion: snapshot.version,
    replacedMessageIds: snapshot.messages.map((message) => message.id),
    summary: {
      schemaVersion: 1,
      id: 'fixture-summary',
      conversationId,
      role: 'summary',
      status: 'committed',
      parts: [{ type: 'text', text: 'compacted streamed context' }],
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    },
  });
  assert.equal(compacted.outcome, 'applied');
  const state = createAgentStateSlotStore({
    store: sqlite.store,
    definitions: [defineStateSlot({ name: 'permission', schema: z.boolean() })],
  });
  await state.set({ conversationId, name: 'permission', value: true, actor: 'human' });
  await sqlite.store.appendEvent({
    conversationId,
    kind: 'durability/effect',
    payload: { runId, effectName: 'pending', phase: 'intent' },
  });
  const projections = createSqliteAgentProjectionStore({ sqlite });
  for (const definition of [
    agentSummaryProjection,
    agentOutlineProjection,
    agentStateSlotsProjection,
  ])
    await projections.advance(conversationId, definition);
  return {
    bytes: await sqlite.store.exportConversation(conversationId),
    runId,
    conversationId,
  };
}
