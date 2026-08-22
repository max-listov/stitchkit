import { describe, expect, test } from 'bun:test';
import { type Instructions, simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeEvent,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const descriptor = {
  provider: 'test',
  modelId: 'test-model',
  contextWindow: 1_000,
  capabilities: [],
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

function submit(runtime: ReturnType<typeof createAgentRuntime>) {
  return runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'hello' }],
    metadata: {},
  });
}

describe('agent runtime mature-consumer parity', () => {
  test('distinguishes empty success from a provider-truncated terminal result', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage,
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'finish',
                finishReason: { unified: 'length', raw: undefined },
                usage,
              },
            ],
          }),
        },
      ],
    });
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });
    const first = await submit(runtime).result;
    const second = await runtime.submit({
      conversationId: 'conversation-2',
      idempotencyKey: 'input-2',
      context: {},
      parts: [{ type: 'text', text: 'hello again' }],
      metadata: {},
    }).result;
    expect(first.reason).toBe('success');
    expect(first.message.parts).toEqual([]);
    expect(second.reason).toBe('policy_stop');
    await runtime.close();
  });

  test('passes structured instructions through the model boundary', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const instructions: Instructions = {
      role: 'system',
      content: 'cache me',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    };
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions,
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });

    expect((await submit(runtime).result).reason).toBe('success');
    expect(model.doStreamCalls[0]?.prompt[0]).toEqual(instructions);
    await runtime.close();
  });

  test('runs prepareStep again after a tool call and carries its overrides forward', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'lookup',
                input: '{"query":"value"}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage,
              },
            ],
          }),
        },
      ],
    });
    const seenSteps: number[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'initial',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: ({ query }) => ({ answer: query }),
        }),
      }),
      loop: {
        maxSteps: 3,
        prepareStep: ({ stepNumber, toolFenceLifecycle }) => {
          seenSteps.push(stepNumber);
          expect(toolFenceLifecycle).toBeDefined();
          return stepNumber === 1 ? { activeTools: [], instructions: 'after tool' } : {};
        },
      },
    });

    const terminal = await submit(runtime).result;
    expect(terminal.reason).toBe('success');
    expect(seenSteps).toEqual([0, 1]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.prompt[0]).toEqual({
      role: 'system',
      content: 'after tool',
    });
    expect(model.doStreamCalls[1]?.tools).toBeUndefined();
    await runtime.close();
  });

  test('resets the inactivity deadline on stream activity', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 25,
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'one' },
            { type: 'text-delta', id: 'text-1', delta: 'two' },
            { type: 'text-delta', id: 'text-1', delta: 'three' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { idleTimeoutMs: 70 },
    });

    const startedAt = performance.now();
    const terminal = await submit(runtime).result;
    expect(performance.now() - startedAt).toBeGreaterThan(70);
    expect(terminal.reason).toBe('success');
    expect(terminal.message.parts).toContainEqual({ type: 'text', text: 'onetwothree' });
    await runtime.close();
  });

  test('terminalizes a stalled stream with the durable timeout reason', async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
      }),
    });
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol,
      store,
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { idleTimeoutMs: 20 },
    });

    const terminal = await submit(runtime).result;
    expect(terminal.reason).toBe('timeout');
    expect(terminal.run.state).toBe('cancelled');
    expect((await store.loadSnapshot('conversation-1')).runs[0]?.terminalReason).toBe(
      'timeout',
    );
    await runtime.close();
  });

  test('publishes safe tool payloads and the name of a custom stop policy', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'lookup',
              input: '{"query":"value"}',
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: ({ query }) => ({ answer: query }),
        }),
      }),
      loop: { stopPolicies: [{ name: 'enough-evidence', when: () => true }] },
      publish: (event) => {
        events.push(event);
      },
    });

    const terminal = await submit(runtime).result;
    expect(terminal.reason).toBe('policy_stop');
    expect(terminal.policyName).toBe('enough-evidence');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        status: 'started',
        input: { query: 'value' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        status: 'completed',
        output: { answer: 'value' },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'terminal',
        reason: 'policy_stop',
        policyName: 'enough-evidence',
      }),
    );
    await runtime.close();
  });

  test('publishes ordered transient reasoning lifecycle with provider metadata', async () => {
    const providerMetadata = {
      openrouter: { cacheControl: { type: 'ephemeral' } },
    };
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'reasoning-start', id: 'reasoning-1', providerMetadata },
            {
              type: 'reasoning-delta',
              id: 'reasoning-1',
              delta: 'private thought',
              providerMetadata,
            },
            { type: 'reasoning-end', id: 'reasoning-1', providerMetadata },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
    });

    const terminal = await submit(runtime).result;
    const reasoning = events.filter(
      (event) =>
        event.type === 'reasoning-start' ||
        event.type === 'reasoning-delta' ||
        event.type === 'reasoning-end',
    );
    expect(reasoning).toEqual([
      expect.objectContaining({
        type: 'reasoning-start',
        provider: { schemaVersion: 1, provider: 'ai-sdk', data: providerMetadata },
      }),
      expect.objectContaining({
        type: 'reasoning-delta',
        textDelta: 'private thought',
        provider: { schemaVersion: 1, provider: 'ai-sdk', data: providerMetadata },
      }),
      expect.objectContaining({
        type: 'reasoning-end',
        provider: { schemaVersion: 1, provider: 'ai-sdk', data: providerMetadata },
      }),
    ]);
    const sequences = reasoning.map((event) => event.sequence);
    expect(sequences[1]).toBe((sequences[0] ?? 0) + 1);
    expect(sequences[2]).toBe((sequences[1] ?? 0) + 1);
    expect(terminal.message.parts).toContainEqual(
      expect.objectContaining({ type: 'reasoning', text: 'private thought' }),
    );
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'terminal' }));
    await runtime.close();
  });

  test('redacts internal tool failures from application events', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'lookup',
              input: '{"query":"value"}',
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, model }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: (): { answer: string } => {
            throw new Error('private provider failure detail');
          },
        }),
      }),
      loop: { stopPolicies: [{ name: 'failed-once', when: () => true }] },
      publish: (event) => {
        events.push(event);
      },
    });

    await submit(runtime).result;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        status: 'failed',
        output: { message: 'Tool execution failed' },
      }),
    );
    expect(JSON.stringify(events)).not.toContain('private provider failure detail');
    await runtime.close();
  });
});
