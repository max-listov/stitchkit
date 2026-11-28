import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type AgentModelDriver,
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

test('a backward wall-clock jump cannot fail operation telemetry or the run', async () => {
  const events: AgentRuntimeEvent[] = [];
  let instant = Date.UTC(2026, 8, 7, 15, 0, 0);
  const driver = createScriptedModelDriver({
    provider: 'test',
    modelId: 'test-model',
    steps: [
      [
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'answer' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: 'stop', usage },
      ],
    ],
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
        driver,
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
  const driver: AgentModelDriver = {
    provider: 'test',
    modelId: 'test-model',
    async stream() {
      call += 1;
      if (call > 1) {
        return {
          parts: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-start', id: 'text-2' };
              yield { type: 'text-delta', id: 'text-2', delta: 'done' };
              yield { type: 'text-end', id: 'text-2' };
              yield { type: 'finish', finishReason: 'stop', usage };
            },
          },
        };
      }
      return {
        parts: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'tool-input-start', toolCallId: 'tool-1', toolName: 'lookup' };
            await releaseArgument.promise;
            yield { type: 'tool-input-delta', toolCallId: 'tool-1', delta: '{"q":' };
            await releaseCall.promise;
            yield { type: 'tool-input-delta', toolCallId: 'tool-1', delta: '"value"}' };
            yield { type: 'tool-input-end', toolCallId: 'tool-1' };
            yield {
              type: 'tool-call',
              toolCallId: 'tool-1',
              toolName: 'lookup',
              input: '{"q":"value"}',
            };
            yield { type: 'finish', finishReason: 'tool-calls', usage };
          },
        },
      };
    },
  };
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
        driver,
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      lookup: defineAgentTool({
        input: z.object({ q: z.string() }),
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
