import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentProviderStreamCutError,
  type AgentRuntimeEvent,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  recordAgentRetryDecision,
} from '../src/entrypoints/agent-runtime';
import {
  createAgentControlView,
  reduceAgentControlEvent,
} from '../src/entrypoints/agent-runtime/browser';

const usage = (total: number) => ({
  inputTokens: { total, noCache: total, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
});

describe('a retry on the transport', () => {
  test('withdraws the failed attempt for subscribers and keeps its spend', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        const chunks: Record<string, unknown>[] =
          calls === 1
            ? [
                {
                  type: 'response-metadata',
                  id: 'failed-generation',
                  modelId: 'fault',
                  timestamp: new Date(0),
                },
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
                // The provider still reports what the cut attempt cost.
                {
                  type: 'finish',
                  finishReason: { unified: 'error', raw: undefined },
                  usage: usage(7),
                  providerMetadata: { openrouter: { provider: 'FirstProvider' } },
                },
              ]
            : [
                {
                  type: 'response-metadata',
                  id: 'recovered-generation',
                  modelId: 'fault',
                  timestamp: new Date(1),
                },
                { type: 'text-start', id: 'b' },
                { type: 'text-delta', id: 'b', delta: 'recovered' },
                { type: 'text-end', id: 'b' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: usage(3),
                  providerMetadata: { openrouter: { provider: 'SecondProvider' } },
                },
              ];
        return { stream: simulateReadableStream({ chunks } as never) };
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fault',
            modelId: 'fault',
            contextWindow: 8_000,
            capabilities: [],
          },
          // A retry answered by a different upstream is the point of this
          // assertion, and the upstream name is the adapter's to read.
          resolveResponseProvider: ({ providerMetadata }) => {
            const metadata = providerMetadata as
              | { openrouter?: { provider?: unknown } }
              | undefined;
            const name = metadata?.openrouter?.provider;
            return typeof name === 'string' ? name : undefined;
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'retry',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { retry: { maxAttempts: 2, delayMs: () => 0 } },
      publish: (event) => {
        events.push(event);
      },
    });
    const result = await runtime.submit({
      conversationId: 'r',
      idempotencyKey: 'r-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    expect(result.reason).toBe('success');

    // What a subscriber assembles: the reset lands between the two attempts,
    // and the reduced view carries only the recovered text.
    const kinds = events.map((event) => event.type);
    const reset = kinds.indexOf('attempt-reset');
    expect(reset).toBeGreaterThan(kinds.indexOf('assistant-delta'));
    expect(reset).toBeLessThan(kinds.lastIndexOf('assistant-delta'));
    let view = createAgentControlView();
    for (const event of events) {
      if (event.type === 'terminal') break;
      view = reduceAgentControlEvent(view, event);
    }
    expect(view.conversations.r?.transientByRun[result.run.id]?.text).toBe('recovered');

    // The cut attempt's tokens are part of this run's spend.
    expect(result.metrics?.usage.inputTokens.value).toBe(10);
    const responses = (
      await store.readEvents({ conversationId: 'r', limit: 100 })
    ).items.filter((event) => event.kind === 'provider/response');
    expect(responses.map((event) => event.payload)).toEqual([
      {
        runId: result.run.id,
        attempt: 1,
        stepNumber: 0,
        response: { id: 'failed-generation', provider: 'FirstProvider' },
        usage: {
          inputTokens: { value: 7, provenance: 'provider-reported' },
          outputTokens: { value: 1, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { provenance: 'unavailable' },
        },
      },
      {
        runId: result.run.id,
        attempt: 2,
        stepNumber: 0,
        response: { id: 'recovered-generation', provider: 'SecondProvider' },
        usage: {
          inputTokens: { value: 3, provenance: 'provider-reported' },
          outputTokens: { value: 1, provenance: 'provider-reported' },
          reasoningTokens: { provenance: 'unavailable' },
          cacheReadTokens: { provenance: 'unavailable' },
          cacheWriteTokens: { provenance: 'unavailable' },
          cost: { provenance: 'unavailable' },
        },
      },
    ]);
    await runtime.close();
  });
});

describe('the retry count', () => {
  const unbounded = [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 1.5];

  test('createAgentRuntime refuses a maxAttempts that is not a positive safe integer', () => {
    const runtime = (maxAttempts: number) =>
      createAgentRuntime({
        protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => {
            throw new Error('not resolved at construction');
          },
        },
        prompt: () => ({
          instructions: 'retry',
          sections: [],
          instructionTokens: { provenance: 'unavailable' },
          contextDecision: 'unavailable',
        }),
        tools: () => ({}),
        loop: { retry: { maxAttempts, delayMs: () => 0 } },
      });
    for (const maxAttempts of unbounded) {
      expect(() => runtime(maxAttempts)).toThrow(
        `loop.retry.maxAttempts must be a positive safe integer, received ${maxAttempts}`,
      );
    }
    expect(() => runtime(3)).not.toThrow();
  });

  test('recordAgentRetryDecision refuses such a policy before it decides or records', async () => {
    const appended: unknown[] = [];
    const store = {
      ...createMemoryAgentRuntimeStore(),
      appendEvent: async (event: unknown) => {
        appended.push(event);
        throw new Error('not recorded');
      },
    };
    for (const maxAttempts of unbounded) {
      await expect(
        recordAgentRetryDecision({
          store,
          conversationId: 'c',
          attempt: 1_000_000,
          failure: { retryable: true, reason: 'rate_limited' } as never,
          policy: { maxAttempts, delayMs: () => 0 },
        }),
      ).rejects.toThrow('maxAttempts must be a positive safe integer');
    }
    expect(appended).toEqual([]);
  });
});
