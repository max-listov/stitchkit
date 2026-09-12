import { expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  type AgentTokenCount,
  composeAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

function count(value: number): AgentTokenCount {
  return { value, provenance: 'computed' };
}

test('the runtime counts seeded instructions once on first and second turn', async () => {
  const store = createMemoryAgentRuntimeStore();
  const prompts: unknown[] = [];
  const events: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'ok' },
            { type: 'text-end', id: 'a' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      };
    },
  });
  const composer = composeAgentPrompt([
    {
      name: 'brief',
      role: 'user',
      stability: 'stable',
      render: ({ event }) => {
        events.push(event);
        return 'BRIEF';
      },
      estimateTokens: () => count(40),
    },
  ]);
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'budget',
          contextWindow: 70,
          capabilities: [],
        },
        model,
      }),
    },
    prompt: ({ snapshot, context, signal, event }) =>
      composer({
        context,
        signal,
        event,
        budget: {
          contextWindow: 70,
          reservedOutput: 0,
          toolSchemas: count(0),
          attachments: count(0),
          providerOverhead: count(0),
        },
        historyTokens: count(
          snapshot.messages.reduce(
            (total, message) =>
              total +
              (message.parts.some((part) => part.type === 'text' && part.text === 'BRIEF')
                ? 40
                : message.parts.length
                  ? message.role === 'assistant'
                    ? 5
                    : 10
                  : 0),
            0,
          ),
        ),
      }),
    tools: () => ({}),
    loop: { maxSteps: 1 },
  });
  try {
    for (const id of ['first', 'second'])
      await runtime.submit({
        conversationId: 'budget',
        idempotencyKey: id,
        context: {},
        parts: [{ type: 'text', text: id }],
        metadata: {},
      }).result;
    expect(prompts).toHaveLength(2);
    expect(events).toEqual(['session.started', 'turn.started']);
    expect(
      (await store.loadSnapshot('budget')).messages.filter((message) =>
        message.parts.some((part) => part.type === 'text' && part.text === 'BRIEF'),
      ),
    ).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});

test('a genuine first-seed overflow is rejected and a partial import never reports applied', async () => {
  const composer = composeAgentPrompt([
    {
      name: 'brief',
      role: 'user',
      stability: 'stable',
      render: () => 'BRIEF',
      estimateTokens: () => count(40),
    },
  ]);
  const prompt = await composer({
    context: {},
    signal: new AbortController().signal,
    budget: {
      contextWindow: 70,
      reservedOutput: 0,
      toolSchemas: count(0),
      attachments: count(0),
      providerOverhead: count(0),
    },
    historyTokens: count(40),
  });
  expect(prompt.contextDecision).toBe('fits');
  expect(prompt.finalizeSeed?.(true).contextDecision).toBe('oversized');
  expect(prompt.finalizeSeed?.(false).contextDecision).toBe('fits');
  const store = createMemoryAgentRuntimeStore();
  const message = (id: string) =>
    AgentMessageSchema.parse({
      schemaVersion: 1,
      id,
      conversationId: 'seed',
      role: 'user',
      status: 'committed',
      parts: [{ type: 'text', text: id }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  await store.seedConversationInput({
    conversationId: 'seed',
    seedKey: 'import',
    inputs: [message('a')],
  });
  await expect(
    store.seedConversationInput({
      conversationId: 'seed',
      seedKey: 'brief',
      inputs: [message('a'), message('b')],
    }),
  ).rejects.toThrow('Partial instruction seed collision');
  expect((await store.loadSnapshot('seed')).messages.map((message) => message.id)).toEqual([
    'a',
  ]);
});
