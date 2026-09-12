import { expect, test } from 'bun:test';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText } from 'ai';
import { normalizeOpenRouterUsage, openRouterProvider } from '../src/agent-runtime-openrouter';

async function readStep(details?: number, omitUsage = false) {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 4,
    total_tokens: 104,
    ...(details === undefined
      ? {}
      : {
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
    {
      id: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(omitUsage ? {} : { usage }),
    },
  ];
  const provider = createOpenRouter({
    apiKey: 'fixture',
    fetch: Object.assign(
      async () =>
        new Response(
          chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      {
        preconnect() {
          /* The fixture performs no network I/O. */
        },
      },
    ),
  });
  const result = streamText({
    model: provider.chat('fixture/model'),
    prompt: 'test',
    maxRetries: 0,
  });
  await result.consumeStream();
  const step = (await result.steps)[0];
  if (!step) throw new Error('SSE fixture did not produce a step');
  return step;
}

for (const value of [undefined, 0, 3]) {
  test(`real SSE preserves counter provenance: ${value ?? 'missing'}`, async () => {
    const step = await readStep(value);
    // The real adapter synthesizes zero even when the provider said nothing.
    expect(step.usage.inputTokenDetails.cacheReadTokens).toBe(value ?? 0);
    const direct = normalizeOpenRouterUsage(step.usage, step.providerMetadata);
    const runtime = openRouterProvider({ apiKey: 'fixture' }).normalizeUsage?.({
      usage: step.usage,
      providerMetadata: step.providerMetadata,
    });
    const count: ReturnType<typeof normalizeOpenRouterUsage>['cacheReadTokens'] =
      value === undefined
        ? { provenance: 'unavailable' }
        : { value, provenance: 'provider-reported' };
    for (const normalized of [direct, runtime]) {
      expect(normalized?.cacheReadTokens).toEqual(count);
      expect(normalized?.cacheWriteTokens).toEqual(count);
      expect(normalized?.reasoningTokens).toEqual(count);
      expect(normalized?.inputTokens).toEqual({ value: 100, provenance: 'provider-reported' });
      expect(normalized?.outputTokens).toEqual({ value: 4, provenance: 'provider-reported' });
      expect(normalized?.cost).toEqual({ provenance: 'unavailable' });
    }
  });
}

test('SSE without usage and normalized-only records cannot manufacture measured totals', async () => {
  const step = await readStep(undefined, true);
  expect(step.usage.inputTokens).toBeUndefined();
  for (const usage of [
    step.usage,
    { ...step.usage, inputTokens: 100, outputTokens: 4, raw: undefined },
  ]) {
    const result = normalizeOpenRouterUsage(usage, step.providerMetadata);
    for (const field of [
      result.inputTokens,
      result.outputTokens,
      result.reasoningTokens,
      result.cacheReadTokens,
      result.cacheWriteTokens,
      result.cost,
    ]) {
      expect(field).toEqual({ provenance: 'unavailable' });
    }
  }
});
