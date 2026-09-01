/**
 * Guard: the runtime tells a step how full the context is.
 *
 * The runtime is the only party that can. The consumer counts what it composes
 * and the provider reports what it received; neither sees both. In the run that
 * prompted this, a model reached a hard context overflow without changing its
 * behaviour on a single step before it — nothing had told it a limit was
 * approaching, so nothing could.
 *
 * Two properties, and the second is the one that is easy to get wrong: the
 * number is the **last step's prompt size**, not the run's cumulative input
 * tokens. Cumulative counts every step's prompt again and is a multiple of the
 * real fill; substituting it reports a model as overflowing while it has room.
 */
import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentContextUsage,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

/** A model whose steps report growing prompts, the way a real conversation does. */
function growingModel(promptTokens: readonly number[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const index = call;
      call += 1;
      const last = call >= promptTokens.length;
      const body = last
        ? [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'done' },
            { type: 'text-end', id: 't' },
          ]
        : [{ type: 'tool-call', toolCallId: `c-${call}`, toolName: 'wait', input: '{}' }];
      return {
        stream: simulateReadableStream({
          chunks: [
            ...body,
            {
              type: 'finish',
              finishReason: { unified: last ? 'stop' : 'tool-calls', raw: undefined },
              usage: {
                inputTokens: {
                  total: promptTokens[index],
                  noCache: promptTokens[index],
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            },
          ],
        } as never),
      };
    },
  });
}

function runtimeReporting(
  promptTokens: readonly number[],
  seen: (AgentContextUsage | undefined)[],
) {
  return createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'test-model',
          contextWindow: 100_000,
          capabilities: [],
        },
        model: growingModel(promptTokens),
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      wait: tool({
        description: 'w',
        inputSchema: z.object({}),
        execute: async () => 'waited',
      }),
    }),
    loop: {
      maxSteps: 5,
      prepareStep: (step) => {
        seen.push(step.contextUsage);
        return {};
      },
    },
    runs: { inputPolicy: 'queue' },
  });
}

/** Submit and wait for the run to actually finish, not merely to be admitted. */
const submit = (runtime: ReturnType<typeof createAgentRuntime>) =>
  runtime.submit({
    conversationId: 'c1',
    idempotencyKey: 'k1',
    context: {},
    parts: [{ type: 'text', text: 'go' }],
    metadata: {},
  });

describe('a step is told how full the context is', () => {
  test('the first step has no provider number, and says so instead of saying zero', async () => {
    const seen: (AgentContextUsage | undefined)[] = [];
    const runtime = runtimeReporting([40_000], seen);
    await submit(runtime).result;

    const first = seen[0];
    expect(first?.contextWindow).toBe(100_000);
    // `unavailable` is a different fact from zero: nothing has been sent yet, so
    // there is no measurement — and a zero would read as "the window is empty".
    expect(first?.usedTokens).toEqual({ provenance: 'unavailable' });
  });

  test('each later step carries the previous step’s prompt size, not the running total', async () => {
    const seen: (AgentContextUsage | undefined)[] = [];
    // Three steps whose prompts grow. Cumulative input tokens would be
    // 40k, then 90k, then 160k — the third already past a 100k window while the
    // real fill is 70k.
    const runtime = runtimeReporting([40_000, 50_000, 70_000], seen);
    await submit(runtime).result;

    expect(seen.map((entry) => entry?.usedTokens.value)).toEqual([undefined, 40_000, 50_000]);
    expect(seen.at(-1)?.usedTokens.provenance).toBe('provider-reported');
    expect(seen.every((entry) => entry?.contextWindow === 100_000)).toBe(true);
  });

  test('the number a consumer would render is the fill, and it stays inside the window', async () => {
    const seen: (AgentContextUsage | undefined)[] = [];
    const runtime = runtimeReporting([40_000, 50_000, 70_000], seen);
    await submit(runtime).result;

    // Dividing is the consumer's line — this is that line, and it must produce a
    // fraction that behaves like one.
    const fractions = seen
      .map((entry) => entry?.usedTokens.value)
      .filter((value): value is number => value !== undefined)
      .map((value) => value / 100_000);
    expect(fractions).toEqual([0.4, 0.5]);
    expect(fractions.every((fraction) => fraction > 0 && fraction < 1)).toBe(true);
  });
});
