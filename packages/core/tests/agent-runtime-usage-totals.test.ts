import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { openRouterProvider } from '../src/agent-runtime/openrouter';
import { mergeModelTotals } from '../src/agent-runtime/runtime-internals';
import {
  type AgentRunEvent,
  type AgentUsage,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

/*
 * A turn's total must not know more than its steps did. The SDK's aggregate is
 * summed from normalized usage, where the OpenRouter adapter writes
 * `cached_tokens ?? 0`; a turn whose every request reported no cache figure
 * used to end as `{ value: 0, provenance: 'computed' }` — "cache 0" on the face
 * for a provider that said nothing about the cache.
 */

/** One turn through the real OpenRouter adapter over a fixture SSE response. */
async function runTurn(details?: number): Promise<AgentUsage | undefined> {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 4,
    total_tokens: 104,
    cost: 0.003,
    ...(details !== undefined && {
      prompt_tokens_details: { cached_tokens: details, cache_write_tokens: details },
      completion_tokens_details: { reasoning_tokens: details },
    }),
  };
  const chunks = [
    {
      id: 'fixture',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null },
      ],
    },
    { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ];
  const provider = openRouterProvider({
    apiKey: 'fixture',
    fetch: Object.assign(
      async () =>
        new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      {
        preconnect() {
          /* The fixture performs no network I/O. */
        },
      },
    ),
  });
  const observed: AgentRunEvent[] = [];
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store: createMemoryAgentRuntimeStore(),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'openrouter',
          modelId: 'fixture/model',
          contextWindow: 100_000,
          capabilities: [],
        },
        model: provider.create('fixture/model'),
        ...(provider.normalizeUsage && { normalizeUsage: provider.normalizeUsage }),
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({}),
    loop: { maxSteps: 2 },
    observe: createAgentObservability({ write: (event) => void observed.push(event) }),
  });
  await runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'go' }],
    metadata: {},
  }).result;
  await runtime.close();
  const terminal = observed.find((event) => event.type === 'run-terminal');
  return terminal?.type === 'run-terminal' ? terminal.usage : undefined;
}

describe('a turn total over steps that did not report a field', () => {
  test('a missing cached_tokens stays unavailable in the turn total', async () => {
    const usage = await runTurn();
    expect(usage?.cacheReadTokens).toEqual({ provenance: 'unavailable' });
    expect(usage?.cacheWriteTokens).toEqual({ provenance: 'unavailable' });
    expect(usage?.reasoningTokens).toEqual({ provenance: 'unavailable' });
    expect(usage?.inputTokens).toEqual({ value: 100, provenance: 'computed' });
    expect(usage?.outputTokens).toEqual({ value: 4, provenance: 'computed' });
  });

  test('an explicit zero and a positive count survive into the total', async () => {
    expect((await runTurn(0))?.cacheReadTokens).toEqual({ value: 0, provenance: 'computed' });
    const reported = await runTurn(80);
    expect(reported?.cacheReadTokens).toEqual({ value: 80, provenance: 'computed' });
    expect(reported?.cacheWriteTokens).toEqual({ value: 80, provenance: 'computed' });
    expect(reported?.reasoningTokens).toEqual({ value: 80, provenance: 'computed' });
  });

  test('steps that disagree give a computed total over the ones that reported', () => {
    const counted = { value: 80, provenance: 'computed' } as const;
    const sdkTotal: AgentUsage = {
      inputTokens: { value: 200, provenance: 'provider-reported' },
      outputTokens: { value: 8, provenance: 'provider-reported' },
      cacheReadTokens: { value: 80, provenance: 'provider-reported' },
      cacheWriteTokens: { value: 0, provenance: 'provider-reported' },
    };
    const total = mergeModelTotals(sdkTotal, {
      inputTokens: { value: 200, provenance: 'computed' },
      outputTokens: { value: 8, provenance: 'computed' },
      cacheReadTokens: counted,
      cacheWriteTokens: { provenance: 'unavailable' },
    });
    expect(total.cacheReadTokens).toEqual(counted);
    expect(total.cacheWriteTokens).toEqual({ provenance: 'unavailable' });
    // A field the step hook does not produce at all is still the SDK's to fill.
    expect(
      mergeModelTotals(sdkTotal, {
        inputTokens: { value: 200, provenance: 'computed' },
        outputTokens: { value: 8, provenance: 'computed' },
      }).cacheReadTokens,
    ).toEqual(counted);
  });
});
