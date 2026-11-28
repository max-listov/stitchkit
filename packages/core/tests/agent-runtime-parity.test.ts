import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AgentContextOverflowError,
  type AgentModelDriver,
  type AgentModelStreamPart,
  type AgentModelSystemMessage,
  type AgentRuntimeEvent,
  type AgentUsage,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { defineAgentTool } from '../src/entrypoints/tools';

const usage: AgentUsage = {
  inputTokens: { value: 1, provenance: 'provider-reported' },
  outputTokens: { value: 1, provenance: 'provider-reported' },
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

const answerProtocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
  terminalAcceptance: 'require-output',
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
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [{ type: 'finish', finishReason: 'stop', usage }],
        [{ type: 'finish', finishReason: 'length', usage }],
      ],
    });
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
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
    // The provider ended this turn for its own reason — a length cap, a content
    // filter — and no policy asked it to. It used to report `policy_stop` with
    // no `policyName`, naming a policy that does not exist.
    expect(second.reason).toBe('provider_stop');
    expect(second.policyName).toBeUndefined();
    await runtime.close();
  });

  test('applies required terminal output before commit without rejecting non-success endings', async () => {
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [{ type: 'finish', finishReason: 'stop', usage }],
        [
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'done' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
        [
          {
            type: 'file',
            mediaType: 'application/json',
            data: { type: 'data', data: new TextEncoder().encode('{"ok":true}') },
          },
          { type: 'finish', finishReason: 'stop', usage },
        ],
        [
          { type: 'custom', kind: 'test.structured' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: answerProtocol,
      store,
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      persistGeneratedFile: () => ({ reference: 'generated:answer.json' }),
    });
    const send = (index: number) =>
      runtime.submit({
        conversationId: `terminal-acceptance-${index}`,
        idempotencyKey: `terminal-acceptance-${index}`,
        context: {},
        parts: [{ type: 'text', text: 'answer' }],
        metadata: {},
      }).result;

    const empty = await send(1);
    const text = await send(2);
    const file = await send(3);
    const structured = await send(4);
    expect(empty.reason).toBe('output_rejected');
    expect(empty.message.status).toBe('failed');
    expect(text.reason).toBe('success');
    expect(file.message.parts).toContainEqual(
      expect.objectContaining({ type: 'file', reference: 'generated:answer.json' }),
    );
    expect(structured.message.parts).toContainEqual(
      expect.objectContaining({ type: 'provider' }),
    );
    expect((await store.loadSnapshot('terminal-acceptance-1')).runs[0]?.state).toBe('failed');
    await runtime.close();
  });

  test('terminal acceptance never rewrites an interrupted response', async () => {
    const delta = Promise.withResolvers<void>();
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream(_request, signal) {
        const chunks: AgentModelStreamPart[] = [
          { type: 'text-start', id: 'partial' },
          { type: 'text-delta', id: 'partial', delta: 'partial' },
          { type: 'text-delta', id: 'partial', delta: ' later' },
          { type: 'text-end', id: 'partial' },
          { type: 'finish', finishReason: 'stop', usage },
        ];
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) {
                await Bun.sleep(25);
                if (signal.aborted) return;
                yield chunk;
              }
            },
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      protocol: answerProtocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      publish: (event) => {
        if (event.type === 'assistant-delta') delta.resolve();
      },
    });
    const ticket = submit(runtime);
    await delta.promise;
    expect(runtime.stop('conversation-1', 'user-interrupt')).toBe(true);
    const terminal = await ticket.result;
    expect(terminal.reason).toBe('interrupted');
    expect(terminal.message.status).toBe('interrupted');
    await runtime.close();
  });

  test('passes structured instructions through the model boundary', async () => {
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [[{ type: 'finish', finishReason: 'stop', usage }]],
    });
    const instructions: AgentModelSystemMessage = {
      role: 'system',
      content: 'cache me',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    };
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions,
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
    });

    expect((await submit(runtime).result).reason).toBe('success');
    expect(driver.requests[0]?.instructions[0]).toEqual(instructions);
    await runtime.close();
  });

  test('runs prepareStep again after a tool call and carries its overrides forward', async () => {
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: '{"query":"value"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
        [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'done' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
    const seenSteps: number[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'initial',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: defineAgentTool({
          input: z.object({ query: z.string() }),
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
    expect(driver.requests).toHaveLength(2);
    expect(driver.requests[1]?.instructions[0]).toEqual({
      role: 'system',
      content: 'after tool',
    });
    expect(driver.requests[1]?.tools).toEqual([]);
    await runtime.close();
  });

  test('a typed refusal after a tool round preserves evidence and makes no extra provider call', async () => {
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: '{"query":"value"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
      ],
    });
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'initial',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'fits',
      }),
      tools: () => ({
        lookup: defineAgentTool({
          input: z.object({ query: z.string() }),
          execute: ({ query }) => ({ answer: query }),
        }),
      }),
      loop: {
        maxSteps: 3,
        prepareStep: ({ stepNumber }) => {
          if (stepNumber === 1) throw new AgentContextOverflowError();
          return {};
        },
      },
    });

    const terminal = await submit(runtime).result;
    expect(terminal.reason).toBe('context_overflow');
    expect(driver.requests).toHaveLength(1);
    expect(terminal.message.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-call', callId: 'call-1', toolName: 'lookup' }),
    );
    expect(terminal.message.parts).toContainEqual(
      expect.objectContaining({ type: 'tool-result', callId: 'call-1', toolName: 'lookup' }),
    );
    await runtime.close();
  });

  test('projects its persisted multi-step run into the next provider prompt by causal round', async () => {
    const finish = (finishReason: 'tool-calls' | 'stop'): AgentModelStreamPart => ({
      type: 'finish',
      finishReason,
      usage,
    });
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-a',
            toolName: 'lookupA',
            input: '{"query":"first"}',
          },
          finish('tool-calls'),
        ],
        [
          {
            type: 'tool-call',
            toolCallId: 'call-b',
            toolName: 'lookupB',
            input: '{"from":1}',
          },
          finish('tool-calls'),
        ],
        [
          { type: 'text-start', id: 'final' },
          { type: 'text-delta', id: 'final', delta: 'final' },
          { type: 'text-end', id: 'final' },
          finish('stop'),
        ],
        [
          { type: 'text-start', id: 'next' },
          { type: 'text-delta', id: 'next', delta: 'next' },
          { type: 'text-end', id: 'next' },
          finish('stop'),
        ],
      ],
    });
    const runtime = createAgentRuntime({
      protocol: answerProtocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookupA: defineAgentTool({
          input: z.object({ query: z.string() }),
          execute: () => ({ value: 1 }),
        }),
        lookupB: defineAgentTool({
          input: z.object({ from: z.number() }),
          execute: () => ({ value: 2 }),
        }),
      }),
    });

    await submit(runtime).result;
    await runtime.submit({
      conversationId: 'conversation-1',
      idempotencyKey: 'input-2',
      context: {},
      parts: [{ type: 'text', text: 'continue' }],
      metadata: {},
    }).result;

    const lastRequest = driver.requests[3];
    const prompt = [...(lastRequest?.instructions ?? []), ...(lastRequest?.messages ?? [])];
    expect(prompt.map((entry) => entry.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
    expect(JSON.stringify(prompt[2])).toContain('call-a');
    expect(JSON.stringify(prompt[4])).toContain('call-b');
    expect(JSON.stringify(prompt[6])).toContain('final');
    await runtime.close();
  });

  test('resets the inactivity deadline on stream activity', async () => {
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream() {
        const chunks: AgentModelStreamPart[] = [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'one' },
          { type: 'text-delta', id: 'text-1', delta: 'two' },
          { type: 'text-delta', id: 'text-1', delta: 'three' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', usage },
        ];
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunks) {
                await Bun.sleep(25);
                yield chunk;
              }
            },
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
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
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream(_request, signal) {
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
            },
          },
        };
      },
    };
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol,
      store,
      models: { resolve: () => ({ descriptor, driver }) },
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
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: '{"query":"value"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
      ],
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol: answerProtocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: defineAgentTool({
          input: z.object({ query: z.string() }),
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
    const provider = {
      schemaVersion: 1 as const,
      provider: 'ai-sdk',
      data: providerMetadata,
    };
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          { type: 'reasoning-start', id: 'reasoning-1', provider },
          {
            type: 'reasoning-delta',
            id: 'reasoning-1',
            delta: 'private thought',
            provider,
          },
          { type: 'reasoning-end', id: 'reasoning-1', provider },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
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
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: '{"query":"value"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
      ],
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol,
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor, driver }) },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        lookup: defineAgentTool({
          input: z.object({ query: z.string() }),
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
