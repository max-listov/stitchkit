import assert from 'node:assert/strict';
import {
  agentOutlineProjection,
  agentStateSlotsProjection,
  agentSummaryProjection,
  createAgentProjectionStore,
  createAgentRuntime,
  createAgentSpillStore,
  createAgentStateSlotStore,
  defineAgentProtocol,
  defineStateSlot,
} from 'stitchkit/agent-runtime';
import { createScriptedModelDriver } from 'stitchkit/agent-runtime/testing';
import { defineAgentTool } from 'stitchkit/tools';
import { z } from 'zod';

/** Real public writes only; produces archives compatible with 0.109.4+ fixtures. */
export async function streamingFixture(sqlite, providerMetadata) {
  const conversationId = 'stream-source';
  const spills = createAgentSpillStore({ host: sqlite.host, conversationId });
  const artifact = await spills.write({
    data: new TextEncoder().encode('streamed artifact evidence'),
    mediaType: 'text/plain',
    authorization: { operation: 'read', path: 'source-only' },
  });
  const usage = {
    inputTokens: { value: 1, provenance: 'provider-reported' },
    outputTokens: { value: 1, provenance: 'provider-reported' },
  };
  const provider = providerMetadata
    ? { schemaVersion: 1, provider: 'ai-sdk', data: providerMetadata }
    : undefined;
  const driver = createScriptedModelDriver({
    provider: 'test',
    modelId: 'stream-fixture',
    steps: [
      [
        ...(provider
          ? [
              { type: 'text-start', id: 'intro', provider },
              { type: 'text-delta', id: 'intro', delta: 'streamed intro', provider },
              { type: 'text-end', id: 'intro', provider },
              { type: 'reasoning-start', id: 'reasoning', provider },
              {
                type: 'reasoning-delta',
                id: 'reasoning',
                delta: 'synthetic reasoning',
                provider,
              },
              { type: 'reasoning-end', id: 'reasoning', provider },
            ]
          : []),
        {
          ...(provider && { provider }),
          type: 'tool-call',
          toolCallId: 'fixture-call',
          toolName: 'run_command',
          input: '{}',
        },
        { type: 'finish', finishReason: 'tool-calls', usage },
      ],
      [
        { type: 'text-start', id: 'text', ...(provider && { provider }) },
        {
          type: 'text-delta',
          id: 'text',
          delta: 'streamed answer',
          ...(provider && { provider }),
        },
        { type: 'text-end', id: 'text', ...(provider && { provider }) },
        { type: 'finish', finishReason: 'stop', usage },
      ],
    ],
  });
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
        driver,
      }),
    },
    prompt: () => ({
      instructions: 'fixture',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      run_command: defineAgentTool({
        input: z.object({}),
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
  assert.equal(driver.requests.length, 2);
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
  const projections = createAgentProjectionStore({ store: sqlite.store, host: sqlite.host });
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
