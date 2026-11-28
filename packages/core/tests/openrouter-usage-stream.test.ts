import { expect, test } from 'bun:test';
import {
  normalizeOpenRouterUsage,
  openRouterProvider,
} from '../src/entrypoints/agent-runtime/openrouter';

async function readStep(details?: number, omitUsage = false) {
  const wireUsage = {
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
      ...(omitUsage ? {} : { usage: wireUsage }),
    },
  ];
  const provider = openRouterProvider({
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
  const stream = await provider.create('fixture/model').stream(
    {
      instructions: [],
      messages: [{ role: 'user', content: 'test' }],
      tools: [],
      settings: {},
      correlation: { conversationId: 'conv', attemptId: 'att', step: 0 },
    },
    new AbortController().signal,
  );
  for await (const part of stream.parts) {
    if (part.type === 'finish') {
      return { finish: part, wireUsage: omitUsage ? undefined : wireUsage };
    }
  }
  throw new Error('SSE fixture did not produce a finish part');
}

for (const value of [undefined, 0, 3]) {
  test(`real SSE preserves counter provenance: ${value ?? 'missing'}`, async () => {
    const { finish, wireUsage } = await readStep(value);
    const direct = normalizeOpenRouterUsage(wireUsage);
    const runtime = finish.usage;
    const count: ReturnType<typeof normalizeOpenRouterUsage>['cacheReadTokens'] =
      value === undefined
        ? { provenance: 'unavailable' }
        : { value, provenance: 'provider-reported' };
    for (const normalized of [direct, runtime]) {
      expect(normalized.cacheReadTokens).toEqual(count);
      expect(normalized.cacheWriteTokens).toEqual(count);
      expect(normalized.reasoningTokens).toEqual(count);
      expect(normalized.inputTokens).toEqual({ value: 100, provenance: 'provider-reported' });
      expect(normalized.outputTokens).toEqual({ value: 4, provenance: 'provider-reported' });
      expect(normalized.cost).toEqual({ provenance: 'unavailable' });
    }
  });
}

test('SSE without usage and normalized-only records cannot manufacture measured totals', async () => {
  const { finish } = await readStep(undefined, true);
  for (const result of [
    finish.usage,
    normalizeOpenRouterUsage(undefined),
    normalizeOpenRouterUsage({ inputTokens: 100, outputTokens: 4, raw: undefined }),
  ]) {
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
