import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type AgentModelDriver,
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
function fixture(
  execute: (signal?: AbortSignal) => Promise<string>,
  prepare?: () => Promise<void>,
  override?: AgentModelDriver,
) {
  // This fixture measures preparation/tool waits. Its ready provider chunks must not
  // add timer scheduling delays that can exhaust the 20ms provider silence budget.
  const driver =
    override ??
    createScriptedModelDriver({
      provider: 'test',
      modelId: 'clocks',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'child', toolName: 'wait', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ],
        [
          { type: 'text-start', id: 'a' },
          { type: 'text-delta', id: 'a', delta: 'done' },
          { type: 'text-end', id: 'a' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      ],
    });
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'clocks',
          contextWindow: 4096,
          capabilities: [],
        },
        driver,
      }),
    },
    prompt: async () => {
      await prepare?.();
      return {
        instructions: 'Test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      };
    },
    tools: () => ({
      wait: defineAgentTool({
        input: z.object({}),
        execute: (_, options) => execute(options.abortSignal),
      }),
    }),
    loop: { idleTimeoutMs: 20, maxSteps: 2 },
  });
}
function submit(runtime: ReturnType<typeof fixture>) {
  return runtime.submit({
    conversationId: 'clock',
    idempotencyKey: 'one',
    context: {},
    parts: [{ type: 'text', text: 'wait for child' }],
    metadata: {},
  });
}

test('preparation and an active child wait do not consume provider silence budget', async () => {
  const started = Promise.withResolvers<void>();
  const child = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const runtime = fixture(
    async (current) => {
      signal = current;
      started.resolve();
      return child.promise;
    },
    () => Bun.sleep(80),
  );
  try {
    const run = submit(runtime);
    await started.promise;
    await Bun.sleep(80);
    expect(signal?.aborted).toBe(false);
    child.resolve('child completed');
    expect((await run.result).reason).toBe('success');
  } finally {
    child.resolve('cleanup');
    await runtime.close();
  }
});

test('provider silence before the stream is returned still times out', async () => {
  const driver: AgentModelDriver = {
    provider: 'test',
    modelId: 'clocks',
    stream: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('aborted by provider deadline')),
          { once: true },
        );
      }),
  };
  const runtime = fixture(async () => '', undefined, driver);
  try {
    expect((await submit(runtime).result).reason).toBe('timeout');
  } finally {
    await runtime.close();
  }
});

test('caller cancellation still reaches a waiting tool', async () => {
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const runtime = fixture(
    (signal) =>
      new Promise((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve('cancelled');
          },
          { once: true },
        );
        started.resolve();
      }),
  );
  try {
    const run = submit(runtime);
    await started.promise;
    expect(runtime.stop('clock')).toBe(true);
    await run.result;
    expect(aborted).toBe(true);
  } finally {
    await runtime.close();
  }
});

test('a tool uses its own timeout while the provider clock remains paused', async () => {
  let ownTimeout = false;
  let providerAborted = false;
  const runtime = fixture(async (signal) => {
    await Bun.sleep(80);
    ownTimeout = true;
    providerAborted = signal?.aborted ?? false;
    throw new Error('tool deadline');
  });
  try {
    await submit(runtime).result;
    expect({ ownTimeout, providerAborted }).toEqual({
      ownTimeout: true,
      providerAborted: false,
    });
  } finally {
    await runtime.close();
  }
});
