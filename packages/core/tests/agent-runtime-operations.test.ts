import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentCompactionResult,
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  type ComposedAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import {
  AgentControlDeliverySchema,
  createAgentControlView,
  reduceAgentControlEvent,
} from '../src/agent-runtime-browser';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';

const usage = {
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
  model: MockLanguageModelV4,
  events: AgentRuntimeEvent[],
  store: AgentRuntimeStore = createMemoryAgentRuntimeStore(),
) {
  return {
    protocol,
    store,
    models: { resolve: () => ({ descriptor, model }) },
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
    let stage = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          async pull(controller) {
            if (stage === 0) {
              stage = 1;
              controller.enqueue({ type: 'stream-start', warnings: [] });
              return;
            }
            if (stage === 1) {
              stage = 2;
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              return;
            }
            if (stage === 2) {
              await releaseDelta.promise;
              stage = 3;
              controller.enqueue({ type: 'text-delta', id: 'text-1', delta: 'hello' });
              return;
            }
            if (stage === 3) {
              await releaseFinish.promise;
              stage = 4;
              controller.enqueue({ type: 'text-end', id: 'text-1' });
              return;
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage,
            });
            controller.close();
          },
        }),
      }),
    });
    const config = runtimeConfig(model, events);
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
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: '{}' },
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
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: 'done' },
              { type: 'text-end', id: 'text-2' },
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
    const config = runtimeConfig(model, events);
    const store = config.store;
    const runtime = createAgentRuntime({
      ...config,
      tools: () => ({
        lookup: tool({ inputSchema: z.object({}), execute: () => ({ ok: true }) }),
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

  test('records real compaction boundaries before the provider request', async () => {
    const events: AgentRuntimeEvent[] = [];
    const config = runtimeConfig(
      new MockLanguageModelV4({
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
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            ...deltas,
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
    const runtime = createAgentRuntime(runtimeConfig(model, events, store));

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
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        call += 1;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: '{}' },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              secondRequestStarted.resolve();
              abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
        };
      },
    });
    const runtime = createAgentRuntime({
      ...runtimeConfig(model, events, primary.store),
      tools: () => ({
        lookup: tool({ inputSchema: z.object({}), execute: () => ({ answer: 42 }) }),
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
      ...runtimeConfig(new MockLanguageModelV4(), compactionEvents),
      history: {
        compact: () => Promise.reject(new Error(compactionSecret)),
      },
    });
    expect((await submit(compactionRuntime).result).reason).toBe('provider_failure');
    expect(operations(compactionEvents).map((event) => event.operation.phase)).toEqual([
      'started',
      'failed',
    ]);
    expect(JSON.stringify(operations(compactionEvents))).not.toContain(compactionSecret);
    await compactionRuntime.close();

    const cancellationEvents: AgentRuntimeEvent[] = [];
    const requestStarted = Promise.withResolvers<void>();
    const blocked = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            requestStarted.resolve();
            abortSignal?.addEventListener('abort', () => controller.close(), { once: true });
          },
        }),
      }),
    });
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
        new MockLanguageModelV4({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: 'error', error: new Error(secret) },
                {
                  type: 'finish',
                  finishReason: { unified: 'error', raw: undefined },
                  usage,
                },
              ],
            }),
          }),
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
});
