import { expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeEvent,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

test('a backward wall-clock jump cannot fail operation telemetry or the run', async () => {
  const events: AgentRuntimeEvent[] = [];
  let instant = Date.UTC(2026, 8, 7, 15, 0, 0);
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'answer' },
          { type: 'text-end', id: 'text-1' },
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
    }),
  });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
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
    publish: (event) => {
      events.push(event);
    },
    now: () => {
      const observed = new Date(instant);
      instant -= 1_000;
      return observed;
    },
  });

  const result = await runtime.submit({
    conversationId: 'clock-jump',
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'hello' }],
    metadata: {},
  }).result;
  expect(result.reason).toBe('success');
  const terminalOperation = events
    .flatMap((event) => (event.type === 'run-operation' ? [event.operation] : []))
    .at(-1);
  expect(terminalOperation?.phase).toBe('completed');
  expect(Date.parse(terminalOperation?.finishedAt ?? '')).toBeLessThan(
    Date.parse(terminalOperation?.startedAt ?? ''),
  );
  await runtime.close();
});

test('non-empty streaming tool arguments are first output before the complete call', async () => {
  const events: AgentRuntimeEvent[] = [];
  const releaseArgument = Promise.withResolvers<void>();
  const releaseCall = Promise.withResolvers<void>();
  const firstOutput = Promise.withResolvers<void>();
  let call = 0;
  let stage = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      if (call > 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-2' },
              { type: 'text-delta', id: 'text-2', delta: 'done' },
              { type: 'text-end', id: 'text-2' },
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
      }
      return {
        stream: new ReadableStream({
          async pull(controller) {
            if (stage === 0) {
              stage = 1;
              controller.enqueue({ type: 'stream-start', warnings: [] });
              return;
            }
            if (stage === 1) {
              stage = 2;
              controller.enqueue({
                type: 'tool-input-start',
                id: 'tool-1',
                toolName: 'lookup',
              });
              return;
            }
            if (stage === 2) {
              await releaseArgument.promise;
              stage = 3;
              controller.enqueue({ type: 'tool-input-delta', id: 'tool-1', delta: '{"q":' });
              return;
            }
            if (stage === 3) {
              await releaseCall.promise;
              stage = 4;
              controller.enqueue({
                type: 'tool-input-delta',
                id: 'tool-1',
                delta: '"value"}',
              });
              return;
            }
            if (stage === 4) {
              stage = 5;
              controller.enqueue({ type: 'tool-input-end', id: 'tool-1' });
              return;
            }
            if (stage === 5) {
              stage = 6;
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'tool-1',
                toolName: 'lookup',
                input: '{"q":"value"}',
              });
              return;
            }
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            });
            controller.close();
          },
        }),
      };
    },
  });
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
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
    tools: () => ({
      lookup: tool({
        inputSchema: z.object({ q: z.string() }),
        execute: ({ q }) => ({ q }),
      }),
    }),
    loop: { maxSteps: 3 },
    publish: (event) => {
      events.push(event);
      if (event.type === 'run-operation' && event.operation.phase === 'first-output') {
        firstOutput.resolve();
      }
    },
  });
  const ticket = runtime.submit({
    conversationId: 'tool-arguments',
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'use the tool' }],
    metadata: {},
  });

  await ticket.accepted;
  releaseArgument.resolve();
  await firstOutput.promise;
  expect(
    events.some((event) => event.type === 'tool-status' && event.status === 'started'),
  ).toBeFalse();
  expect(
    events.find(
      (event) => event.type === 'run-operation' && event.operation.phase === 'first-output',
    ),
  ).toBeDefined();
  releaseCall.resolve();
  expect((await ticket.result).reason).toBe('success');
  await runtime.close();
});
