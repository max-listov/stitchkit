import { expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentMessageSchema,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const protocol = defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) });

function message(id: string, role: 'user' | 'assistant', text: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId: 'conversation',
    role,
    status: role === 'user' ? 'committed' : 'completed',
    parts: [{ type: 'text', text }],
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
  });
}

const lightsOff = {
  conversationId: 'conversation',
  seedKey: 'voice-command-1',
  placement: 'after-settled' as const,
  inputs: [
    message('voice-user', 'user', 'turn the lights off'),
    message('voice-receipt', 'assistant', 'Lights are off.'),
  ],
};

test('an exchange written without a model is history the next run reads, and an active run stays whole', async () => {
  const prompts: string[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let started: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    started = resolve;
  });
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      calls++;
      if (calls === 1) {
        started();
        await held;
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: `answer-${calls}` },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }),
      };
    },
  });
  const store = createMemoryAgentRuntimeStore();
  const runtime = createAgentRuntime({
    protocol,
    store,
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'test-model',
          contextWindow: 1_000,
          capabilities: [],
        },
        model,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
  });
  const submit = (key: string, text: string) =>
    runtime.submit({
      conversationId: 'conversation',
      idempotencyKey: key,
      context: {},
      parts: [{ type: 'text', text }],
      metadata: {},
    });

  const first = submit('first', 'what is the weather');
  await inFlight;
  // The first run is in flight, held inside its provider call.
  expect((await store.seedConversationInput(lightsOff)).outcome).toBe('applied');
  expect((await store.seedConversationInput(lightsOff)).outcome).toBe('applied');
  release();
  await first.result;

  const settled = await store.loadSnapshot('conversation');
  const texts = settled.messages.map((entry) =>
    entry.parts.map((part) => ('text' in part ? part.text : '')).join(''),
  );
  expect(texts).toEqual([
    'turn the lights off',
    'Lights are off.',
    'what is the weather',
    'answer-1',
  ]);

  await submit('second', 'and now?').result;
  const second = prompts.at(-1) ?? '';
  expect(second).toContain('turn the lights off');
  expect(second).toContain('Lights are off.');
  expect(second.indexOf('Lights are off.')).toBeLessThan(
    second.indexOf('what is the weather'),
  );
  await runtime.close();
});

test('a settled exchange refuses messages a run owns or that are not settled', async () => {
  const store = createMemoryAgentRuntimeStore();
  await expect(
    store.seedConversationInput({
      ...lightsOff,
      inputs: [{ ...message('streaming', 'assistant', 'x'), status: 'streaming' }],
    }),
  ).rejects.toThrow('A settled exchange must be committed user and completed assistant');
  await expect(
    store.seedConversationInput({
      ...lightsOff,
      inputs: [{ ...message('owned', 'user', 'x'), runId: 'run' }],
    }),
  ).rejects.toThrow('A settled exchange must be committed user and completed assistant');
});

test('compaction may summarize a settled exchange, and its key never writes it again', async () => {
  const store = createMemoryAgentRuntimeStore();
  expect((await store.seedConversationInput(lightsOff)).outcome).toBe('applied');
  const before = await store.loadSnapshot('conversation');
  const compacted = await store.replaceCompactedRange({
    conversationId: 'conversation',
    expectedVersion: before.version,
    replacedMessageIds: ['voice-user', 'voice-receipt'],
    summary: AgentMessageSchema.parse({
      ...message('voice-summary', 'user', 'The owner turned the lights off.'),
      role: 'summary',
    }),
  });
  expect(compacted.outcome).toBe('applied');
  await store.seedConversationInput(lightsOff);
  const after = await store.loadSnapshot('conversation');
  expect(after.messages.map((entry) => entry.id)).toEqual(['voice-summary']);
});
