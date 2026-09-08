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
} from '../src/agent-runtime';
import { createAgentControlView, reduceAgentControlEvent } from '../src/agent-runtime-browser';

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
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'partial' },
                { type: 'error', error: new AgentProviderStreamCutError() },
                // The provider still reports what the cut attempt cost.
                {
                  type: 'finish',
                  finishReason: { unified: 'error', raw: undefined },
                  usage: usage(7),
                },
              ]
            : [
                { type: 'text-start', id: 'b' },
                { type: 'text-delta', id: 'b', delta: 'recovered' },
                { type: 'text-end', id: 'b' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: usage(3),
                },
              ];
        return { stream: simulateReadableStream({ chunks } as never) };
      },
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fault',
            modelId: 'fault',
            contextWindow: 8_000,
            capabilities: [],
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
    await runtime.close();
  });
});
