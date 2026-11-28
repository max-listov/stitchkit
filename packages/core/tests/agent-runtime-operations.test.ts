import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentCompactionResult,
  type AgentModelDriver,
  type AgentModelStreamPart,
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  type AgentUsage,
  type ComposedAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  defineModelRegistry,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';
import {
  AgentControlDeliverySchema,
  createAgentControlView,
  reduceAgentControlEvent,
} from '../src/entrypoints/agent-runtime/browser';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { defineAgentTool } from '../src/entrypoints/tools';

const usage: AgentUsage = {
  inputTokens: { value: 1, provenance: 'provider-reported' },
  outputTokens: { value: 1, provenance: 'provider-reported' },
};

const sdkUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
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

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 7, 14, 0, tick++));
}

function submit(runtime: ReturnType<typeof createAgentRuntime>, suffix = '1') {
  return runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey: `input-${suffix}`,
    context: {},
    parts: [{ type: 'text', text: 'hello' }],
    metadata: {},
  });
}

function operations(events: readonly AgentRuntimeEvent[]) {
  return events.flatMap((event) => (event.type === 'run-operation' ? [event] : []));
}

function prompt(): ComposedAgentPrompt {
  return {
    instructions: 'test',
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  };
}

function runtimeConfig(
  driver: AgentModelDriver,
  events: AgentRuntimeEvent[],
  store: AgentRuntimeStore = createMemoryAgentRuntimeStore(),
) {
  return {
    protocol,
    store,
    models: { resolve: () => ({ descriptor, driver }) },
    prompt,
    tools: () => ({}),
    publish: (event: AgentRuntimeEvent) => {
      events.push(event);
    },
    now: clock(),
  };
}

describe('agent runtime durable operation lifecycle', () => {
  test('publishes request start before a blocked provider and first output only for content', async () => {
    const events: AgentRuntimeEvent[] = [];
    const started = Promise.withResolvers<void>();
    const firstOutput = Promise.withResolvers<void>();
    const releaseDelta = Promise.withResolvers<void>();
    const releaseFinish = Promise.withResolvers<void>();
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream() {
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-start', id: 'text-1' };
              await releaseDelta.promise;
              yield { type: 'text-delta', id: 'text-1', delta: 'hello' };
              await releaseFinish.promise;
              yield { type: 'text-end', id: 'text-1' };
              yield { type: 'finish', finishReason: 'stop', usage };
            },
          },
        };
      },
    };
    const config = runtimeConfig(driver, events);
    const store = config.store;
    config.publish = (event) => {
      events.push(event);
      if (event.type === 'run-operation' && event.operation.phase === 'started') {
        started.resolve();
      }
      if (event.type === 'run-operation' && event.operation.phase === 'first-output') {
        firstOutput.resolve();
      }
    };
    const runtime = createAgentRuntime(config);
    const ticket = submit(runtime);
    await ticket.accepted;
    await started.promise;

    const beforeDelta = operations(events);
    expect(beforeDelta.map((event) => event.operation.phase)).toEqual(['started']);
    const durableStart = (await store.loadSnapshot('conversation-1')).runs[0]?.lastOperation;
    expect(durableStart).toEqual(beforeDelta[0]?.operation);

    releaseDelta.resolve();
    await firstOutput.promise;
    const first = operations(events)[1];
    expect(first?.operation).toMatchObject({
      kind: 'model-request',
      phase: 'first-output',
      step: 0,
      operationId: beforeDelta[0]?.operation.operationId,
      startedAt: beforeDelta[0]?.operation.startedAt,
    });
    expect(first?.operation.firstOutputAt).not.toBe(first?.operation.startedAt);

    releaseFinish.resolve();
    const result = await ticket.result;
    expect(result.reason).toBe('success');
    expect(operations(events).at(-1)?.operation).toMatchObject({
      phase: 'completed',
      firstOutputAt: first?.operation.firstOutputAt,
    });

    const delivery = AgentControlDeliverySchema.parse({
      schemaVersion: 1,
      type: 'event',
      event: first,
    });
    if (delivery.type !== 'event') throw new Error('expected event delivery');
    let view = createAgentControlView();
    view = reduceAgentControlEvent(view, delivery.event);
    expect(view.cursor.conversations['conversation-1']?.durableEventIds).toContain(
      first?.eventId,
    );
    await runtime.close();
  });

  test('gives two model steps distinct durable request identities', async () => {
    const events: AgentRuntimeEvent[] = [];
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
        [
          { type: 'text-start', id: 'text-2' },
          { type: 'text-delta', id: 'text-2', delta: 'done' },
          { type: 'text-end', id: 'text-2' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
    const config = runtimeConfig(driver, events);
    const store = config.store;
    const runtime = createAgentRuntime({
      ...config,
      tools: () => ({
        lookup: defineAgentTool({ input: z.object({}), execute: () => ({ ok: true }) }),
      }),
      loop: { maxSteps: 3 },
    });

    await submit(runtime).result;
    const starts = operations(events).filter((event) => event.operation.phase === 'started');
    expect(starts.map((event) => event.operation.step)).toEqual([0, 1]);
    expect(starts[0]?.operation.operationId).not.toBe(starts[1]?.operation.operationId);
    const reconnected = (await store.loadSnapshot('conversation-1')).runs[0]?.lastOperation;
    expect(reconnected).toMatchObject({
      operationId: starts[1]?.operation.operationId,
      step: 1,
      phase: 'completed',
      startedAt: starts[1]?.operation.startedAt,
    });
    await runtime.close();
  });

  test('keeps lifecycle admission around an AI SDK v3 provider model', async () => {
    const events: AgentRuntimeEvent[] = [];
    expect(() => fromAiSdkModel(new MockLanguageModelV3())).toThrow(TypeError);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'v4-text' },
            { type: 'text-delta', id: 'v4-text', delta: 'done' },
            { type: 'text-end', id: 'v4-text' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: sdkUsage,
            },
          ],
        }),
      }),
    });
    const runtime = createAgentRuntime(runtimeConfig(fromAiSdkModel(model), events));

    expect((await submit(runtime).result).reason).toBe('success');
    expect(model.doStreamCalls).toHaveLength(1);
    expect(operations(events).map((event) => event.operation.phase)).toEqual([
      'started',
      'first-output',
      'completed',
    ]);
    await runtime.close();
  });

  test('admits a global provider model ID before provider execution', async () => {
    const events: AgentRuntimeEvent[] = [];
    let providerCalls = 0;
    expect(() => fromAiSdkModel('openai/gpt-4.1-mini')).toThrow(TypeError);
    const registry = defineModelRegistry({
      models: {
        'openai/gpt-4.1-mini': {
          provider: 'test',
          modelId: 'openai/gpt-4.1-mini',
          contextWindow: 1_000,
          capabilities: [],
        },
      },
      providers: {
        test: {
          create: (modelId) => ({
            provider: 'test',
            modelId,
            async stream() {
              providerCalls += 1;
              return {
                parts: {
                  async *[Symbol.asyncIterator]() {
                    yield { type: 'finish', finishReason: 'stop', usage };
                  },
                },
              };
            },
          }),
        },
      },
    });
    const runtime = createAgentRuntime({
      ...runtimeConfig(registry.resolve('openai/gpt-4.1-mini').driver, events),
      models: { resolve: () => registry.resolve('openai/gpt-4.1-mini') },
    });
    expect((await submit(runtime).result).reason).toBe('success');
    expect(providerCalls).toBe(1);
    expect(operations(events).map((event) => event.operation.phase)).toEqual([
      'started',
      'completed',
    ]);
    await runtime.close();
  });

  test('serializes a deferred lifecycle write after the previous structural checkpoint', async () => {
    const events: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    const structuralCheckpoint = Promise.withResolvers<void>();
    const order: string[] = [];
    let startedWrites = 0;
    const store: AgentRuntimeStore = {
      ...durable,
      async recordRunOperation(input) {
        if (input.operation.kind === 'model-request' && input.operation.phase === 'started') {
          startedWrites += 1;
          if (startedWrites === 2) await structuralCheckpoint.promise;
        }
        return durable.recordRunOperation(input);
      },
      async checkpointRunAssistant(input) {
        const result = await durable.checkpointRunAssistant(input);
        if (input.assistant.parts.some((part) => part.type === 'tool-result')) {
          order.push('structural-checkpoint');
          structuralCheckpoint.resolve();
        }
        return result;
      },
    };
    let providerCalls = 0;
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream() {
        providerCalls += 1;
        order.push(`provider-${providerCalls}`);
        const parts: AgentModelStreamPart[] =
          providerCalls === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'tool-deferred',
                  toolName: 'lookup',
                  input: '{}',
                },
                { type: 'finish', finishReason: 'tool-calls', usage },
              ]
            : [
                { type: 'text-start', id: 'text-deferred' },
                { type: 'text-delta', id: 'text-deferred', delta: 'done' },
                { type: 'text-end', id: 'text-deferred' },
                { type: 'finish', finishReason: 'stop', usage },
              ];
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              for (const part of parts) yield part;
            },
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      ...runtimeConfig(driver, events, store),
      tools: () => ({
        lookup: defineAgentTool({ input: z.object({}), execute: () => ({ answer: 42 }) }),
      }),
      loop: { maxSteps: 3, checkpointEveryEvents: 10_000 },
    });

    expect((await submit(runtime).result).reason).toBe('success');
    const starts = operations(events).filter((event) => event.operation.phase === 'started');
    expect(providerCalls).toBe(2);
    expect(starts.map((event) => event.operation.step)).toEqual([0, 1]);
    expect(starts[0]?.operation.operationId).not.toBe(starts[1]?.operation.operationId);
    expect(order.indexOf('structural-checkpoint')).toBeLessThan(order.indexOf('provider-2'));
    await runtime.close();
  });

  test('does not invoke the provider when durable request admission fails', async () => {
    const events: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let providerCalls = 0;
    const store: AgentRuntimeStore = {
      ...durable,
      recordRunOperation(input) {
        if (input.operation.kind === 'model-request' && input.operation.phase === 'started') {
          throw new Error('operation storage unavailable');
        }
        return durable.recordRunOperation(input);
      },
    };
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      onRequest: () => {
        providerCalls += 1;
      },
      steps: [[]],
    });
    const runtime = createAgentRuntime(runtimeConfig(driver, events, store));

    // Admission failed in storage before the provider was ever contacted, so
    // the terminal record classifies it as `runtime_failure`, not `provider_failure`.
    expect((await submit(runtime).result).reason).toBe('runtime_failure');
    expect(providerCalls).toBe(0);
    expect(operations(events)).toEqual([]);
    await runtime.close();
  });

  test('records real compaction boundaries before the provider request', async () => {
    const events: AgentRuntimeEvent[] = [];
    const config = runtimeConfig(
      createScriptedModelDriver({
        provider: 'test',
        modelId: 'test-model',
        steps: [[{ type: 'finish', finishReason: 'stop', usage }]],
      }),
      events,
    );
    const store = config.store;
    const compactEntered = Promise.withResolvers<void>();
    const releaseCompact = Promise.withResolvers<void>();
    const runtime = createAgentRuntime({
      ...config,
      history: {
        async compact({ conversationId }): Promise<AgentCompactionResult> {
          compactEntered.resolve();
          await releaseCompact.promise;
          return {
            outcome: 'not_needed',
            attempts: 0,
            snapshot: await store.loadSnapshot(conversationId),
          };
        },
      },
    });
    const ticket = submit(runtime);
    await compactEntered.promise;
    const during = await store.loadSnapshot('conversation-1');
    expect(during.runs[0]?.lastOperation).toMatchObject({
      kind: 'compaction',
      phase: 'started',
    });
    expect(operations(events)[0]?.operation.kind).toBe('compaction');
    releaseCompact.resolve();
    await ticket.result;
    expect(
      operations(events).map((event) => [event.operation.kind, event.operation.phase]),
    ).toEqual([
      ['compaction', 'started'],
      ['compaction', 'completed'],
      ['model-request', 'started'],
      ['model-request', 'completed'],
    ]);
    await runtime.close();
  });

  test('batches live deltas while checkpointing every structural boundary', async () => {
    const deltaCount = 45;
    const deltas = Array.from(
      { length: deltaCount },
      (_, index): { type: 'text-delta'; id: string; delta: string } => ({
        type: 'text-delta',
        id: 'text-1',
        delta: String(index % 10),
      }),
    );
    const events: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let checkpointWrites = 0;
    const store: AgentRuntimeStore = {
      ...durable,
      checkpointRunAssistant(input) {
        checkpointWrites += 1;
        return durable.checkpointRunAssistant(input);
      },
    };
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'test-model',
      steps: [
        [
          { type: 'text-start', id: 'text-1' },
          ...deltas,
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
    const runtime = createAgentRuntime(runtimeConfig(driver, events, store));

    await submit(runtime).result;
    expect(events.filter((event) => event.type === 'assistant-delta')).toHaveLength(
      deltaCount,
    );
    // Initial assistant draft + two 20-part batches + the mandatory step boundary.
    expect(checkpointWrites).toBe(4);
    await runtime.close();
  });

  test('a reopened SQLite reader sees tool history before the next batch or terminal', async () => {
    const filename = join(tmpdir(), `stitchkit-operation-${crypto.randomUUID()}.sqlite`);
    const primary = createBunSqliteAgentRuntimeStore({ filename });
    const events: AgentRuntimeEvent[] = [];
    const secondRequestStarted = Promise.withResolvers<void>();
    let call = 0;
    const driver: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream(_request, signal) {
        call += 1;
        if (call === 1) {
          return {
            parts: {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: 'tool-call',
                  toolCallId: 'tool-1',
                  toolName: 'lookup',
                  input: '{}',
                };
                yield { type: 'finish', finishReason: 'tool-calls', usage };
              },
            },
          };
        }
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              secondRequestStarted.resolve();
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
            },
          },
        };
      },
    };
    const runtime = createAgentRuntime({
      ...runtimeConfig(driver, events, primary.store),
      tools: () => ({
        lookup: defineAgentTool({ input: z.object({}), execute: () => ({ answer: 42 }) }),
      }),
      loop: { maxSteps: 3, checkpointEveryEvents: 20 },
    });
    const ticket = submit(runtime);

    try {
      await secondRequestStarted.promise;
      const reopened = createBunSqliteAgentRuntimeStore({
        filename,
        initialize: false,
      });
      const snapshot = await reopened.store.loadSnapshot('conversation-1');
      expect(snapshot.messages.at(-1)?.parts.map((part) => part.type)).toEqual([
        'tool-call',
        'tool-result',
      ]);
      await reopened.close();
    } finally {
      await runtime.close({ gracePeriodMs: 1, forceTimeoutMs: 1_000 });
      await ticket.result.catch(() => undefined);
      await primary.close();
      await rm(filename, { force: true });
    }
  });

  test('closes cancellation and provider failure without exposing their raw errors', async () => {
    const compactionEvents: AgentRuntimeEvent[] = [];
    const compactionSecret = 'private-compaction-cause';
    const compactionRuntime = createAgentRuntime({
      ...runtimeConfig(createScriptedModelDriver({ steps: [] }), compactionEvents),
      history: {
        compact: () => Promise.reject(new Error(compactionSecret)),
      },
    });
    expect((await submit(compactionRuntime).result).reason).toBe('runtime_failure');
    expect(operations(compactionEvents).map((event) => event.operation.phase)).toEqual([
      'started',
      'failed',
    ]);
    expect(JSON.stringify(operations(compactionEvents))).not.toContain(compactionSecret);
    await compactionRuntime.close();

    const cancellationEvents: AgentRuntimeEvent[] = [];
    const requestStarted = Promise.withResolvers<void>();
    const blocked: AgentModelDriver = {
      provider: 'test',
      modelId: 'test-model',
      async stream(_request, signal) {
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              requestStarted.resolve();
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener('abort', () => resolve(), { once: true });
              });
            },
          },
        };
      },
    };
    const cancelledRuntime = createAgentRuntime(runtimeConfig(blocked, cancellationEvents));
    const cancelled = submit(cancelledRuntime);
    const admission = await cancelled.admission;
    await requestStarted.promise;
    expect(
      await cancelledRuntime.interrupt({
        conversationId: 'conversation-1',
        runId: admission.runId,
      }),
    ).toMatchObject({ outcome: 'applied' });
    expect((await cancelled.result).reason).toBe('interrupted');
    expect(operations(cancellationEvents).at(-1)?.operation).toMatchObject({
      kind: 'model-request',
      phase: 'cancelled',
    });
    expect(operations(cancellationEvents).at(-1)?.operation.firstOutputAt).toBeUndefined();
    await cancelledRuntime.close();

    const failureEvents: AgentRuntimeEvent[] = [];
    const secret = 'provider-secret-response';
    const failedRuntime = createAgentRuntime(
      runtimeConfig(
        createScriptedModelDriver({
          provider: 'test',
          modelId: 'test-model',
          steps: [
            [
              { type: 'error', error: new Error(secret) },
              { type: 'finish', finishReason: 'error', usage },
            ],
          ],
        }),
        failureEvents,
      ),
    );
    expect((await submit(failedRuntime).result).reason).toBe('provider_failure');
    const failed = operations(failureEvents).at(-1);
    expect(failed?.operation).toMatchObject({ phase: 'failed' });
    expect(failed?.operation.firstOutputAt).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain(secret);
    await failedRuntime.close();
  });

  /**
   * The shape a consumer reported against published 0.85.1: a store whose
   * mutations are genuinely asynchronous, and a checkpoint on every event. Both
   * owned writes read the run revision before their own `await`, so the second
   * one names a revision that the first has already spent — and the run failed
   * with `provider_failure` having never called the provider.
   */
  test('reaches the provider once when every owned mutation defers', async () => {
    const events: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    const mutations: { kind: string; outcome: string }[] = [];
    const deferred: AgentRuntimeStore = {
      ...durable,
      async checkpointRunAssistant(input) {
        await setImmediate();
        const result = await durable.checkpointRunAssistant(input);
        mutations.push({ kind: 'checkpoint', outcome: result.outcome });
        return result;
      },
      async recordRunOperation(input) {
        await setImmediate();
        const result = await durable.recordRunOperation(input);
        mutations.push({ kind: 'operation', outcome: result.outcome });
        return result;
      },
    };
    let calls = 0;
    const runtime = createAgentRuntime({
      ...runtimeConfig(
        createScriptedModelDriver({
          provider: 'test',
          modelId: 'test-model',
          onRequest: () => {
            calls += 1;
          },
          steps: [
            [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'done' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: 'stop', usage },
            ],
          ],
        }),
        events,
        deferred,
      ),
      loop: { checkpointEveryEvents: 1 },
    });

    const result = await submit(runtime).result;
    expect(result.reason).toBe('success');
    expect(calls).toBe(1);
    expect(result.message.parts).toEqual([{ type: 'text', text: 'done' }]);
    expect(mutations.filter((mutation) => mutation.outcome !== 'applied')).toEqual([]);
    expect(operations(events).at(-1)?.operation).toMatchObject({
      kind: 'model-request',
      phase: 'completed',
    });
    await runtime.close();
  });

  test('keeps concurrent runs on their own revisions when the store defers', async () => {
    const events: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    const conflicts: string[] = [];
    const deferred: AgentRuntimeStore = {
      ...durable,
      async checkpointRunAssistant(input) {
        await setImmediate();
        const result = await durable.checkpointRunAssistant(input);
        if (result.outcome === 'conflict') conflicts.push('checkpoint');
        return result;
      },
      async recordRunOperation(input) {
        await setImmediate();
        const result = await durable.recordRunOperation(input);
        if (result.outcome === 'conflict') conflicts.push('operation');
        return result;
      },
    };
    const runtime = createAgentRuntime({
      ...runtimeConfig(
        {
          provider: 'test',
          modelId: 'test-model',
          async stream() {
            return {
              parts: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'text-start', id: 'answer' };
                  yield { type: 'text-delta', id: 'answer', delta: 'done' };
                  yield { type: 'text-end', id: 'answer' };
                  yield { type: 'finish', finishReason: 'stop', usage };
                },
              },
            };
          },
        },
        events,
        deferred,
      ),
      loop: { checkpointEveryEvents: 1 },
    });

    // Independent conversations: each run owns its own revision, and the queue
    // is per run, so this says the fix did not serialize the whole runtime.
    const [first, second] = await Promise.all([
      runtime.submit({
        conversationId: 'conversation-a',
        idempotencyKey: 'input-a',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      }).result,
      runtime.submit({
        conversationId: 'conversation-b',
        idempotencyKey: 'input-b',
        context: {},
        parts: [{ type: 'text', text: 'hello' }],
        metadata: {},
      }).result,
    ]);
    expect([first.reason, second.reason]).toEqual(['success', 'success']);
    expect(conflicts).toEqual([]);
    await runtime.close();
  });

  /**
   * The three failures used to share one word. Each of these reaches the
   * terminal record by a different route, and each used to say the provider
   * failed — twice about a provider that was never called.
   */
  test('names what actually failed instead of blaming the provider', async () => {
    const conflictEvents: AgentRuntimeEvent[] = [];
    const durable = createMemoryAgentRuntimeStore();
    let checkpoints = 0;
    let calls = 0;
    const refusing: AgentRuntimeStore = {
      ...durable,
      async checkpointRunAssistant(input) {
        checkpoints += 1;
        // The second checkpoint loses its compare-and-set, the way a store
        // shared with another writer does.
        if (checkpoints === 2) return { outcome: 'conflict', actualVersion: 0 };
        return durable.checkpointRunAssistant(input);
      },
    };
    const conflicted = createAgentRuntime({
      ...runtimeConfig(
        createScriptedModelDriver({
          provider: 'test',
          modelId: 'test-model',
          onRequest: () => {
            calls += 1;
          },
          steps: [
            [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'done' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: 'stop', usage },
            ],
          ],
        }),
        conflictEvents,
        refusing,
      ),
      loop: { checkpointEveryEvents: 1 },
    });
    const conflictResult = await submit(conflicted).result;
    expect(conflictResult.reason).toBe('storage_conflict');
    expect(conflictResult.run.state).toBe('failed');
    // Zero: the losing checkpoint lands before the model call, which is the
    // shape a consumer reported. The run used to blame a provider it had not
    // spoken to.
    expect(calls).toBe(0);
    await conflicted.close();

    // The application's own acceptance refuses a finished answer. The provider
    // did its work; the reason must not say otherwise.
    const rejectedEvents: AgentRuntimeEvent[] = [];
    const rejecting = createAgentRuntime({
      ...runtimeConfig(
        createScriptedModelDriver({
          provider: 'test',
          modelId: 'test-model',
          steps: [
            [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'done' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: 'stop', usage },
            ],
          ],
        }),
        rejectedEvents,
      ),
      protocol: { ...protocol, acceptTerminal: () => false },
    });
    const rejectedResult = await submit(rejecting).result;
    expect(rejectedResult.reason).toBe('output_rejected');
    await rejecting.close();

    // And this runtime's own callback failing before any provider call.
    const runtimeEvents: AgentRuntimeEvent[] = [];
    const broken = createAgentRuntime({
      ...runtimeConfig(createScriptedModelDriver({ steps: [] }), runtimeEvents),
      prompt: () => {
        throw new Error('prompt fixture');
      },
    });
    expect((await submit(broken).result).reason).toBe('runtime_failure');
    await broken.close();
  });
});
