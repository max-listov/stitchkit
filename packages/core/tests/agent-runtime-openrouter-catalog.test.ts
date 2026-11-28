import { describe, expect, spyOn, test } from 'bun:test';
import { AgentModelProviderOptionsSchema } from '../src/agent-parts/model';
import { searchAgentModelCatalog } from '../src/agent-runtime/models';
import { openRouterModelCatalog } from '../src/agent-runtime/openrouter';
import {
  fetchOpenRouterModelEndpoints,
  loadOpenRouterCatalogSnapshot,
} from '../src/agent-runtime/openrouter-catalog';
import {
  openRouterEndpointsUrl,
  parseUnixSecondsIso,
  usd,
  usdPerMillion,
  withOpenRouterTimeout,
} from '../src/agent-runtime/openrouter-models';
import * as openRouterEntrypoint from '../src/entrypoints/agent-runtime/openrouter';
import {
  createOpenRouterCatalogCache,
  evaluateOpenRouterModelAdmission,
  findOpenRouterModel,
  listOpenRouterModels,
  type OpenRouterCatalogCacheReadResult,
  type OpenRouterCatalogSnapshot,
  OpenRouterCatalogSnapshotSchema,
  type OpenRouterCatalogStore,
  type OpenRouterEndpoint,
  OpenRouterEndpointSummarySchema,
  OpenRouterModelAdmissionSchema,
  OpenRouterModelPricingCeilingSchema,
  type OpenRouterSnapshotModel,
  resolveOpenRouterModelCeiling,
  summarizeOpenRouterEndpoints,
} from '../src/entrypoints/agent-runtime/openrouter';
import { MAX_TIMER_MS } from '../src/internal/timers';

const observedAt = '2026-08-30T12:00:00.000Z';
const requests = async (): Promise<void> => undefined;

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function models() {
  return {
    data: [
      {
        id: 'vendor/model-a',
        canonical_slug: 'vendor/model-a-20260830',
        name: 'Model A',
        description: 'A tool model',
        context_length: 128_000,
        architecture: { input_modalities: ['text', 'image'] },
        pricing: { prompt: '0.000001', completion: '0.000002' },
        supported_parameters: ['tools', 'reasoning'],
      },
      {
        id: 'vendor/model-b',
        name: 'Model B',
        context_length: 64_000,
        architecture: { input_modalities: ['text'] },
        pricing: {},
        supported_parameters: ['tools'],
      },
    ],
  };
}

describe('OpenRouter agent model catalog', () => {
  test('searches the complete catalog with an explicit result bound', () => {
    const result = searchAgentModelCatalog(
      {
        schemaVersion: 1,
        source: 'fixture',
        observedAt,
        completeness: 'complete',
        diagnostics: [],
        models: [
          {
            id: 'one/code',
            name: 'Code One',
            description: 'agentic',
            descriptor: {
              provider: 'fixture',
              modelId: 'one/code',
              contextWindow: 1,
              capabilities: ['tools'],
            },
            metrics: [],
          },
          {
            id: 'two/code',
            name: 'Code Two',
            description: 'agentic',
            descriptor: {
              provider: 'fixture',
              modelId: 'two/code',
              contextWindow: 1,
              capabilities: ['tools'],
            },
            metrics: [],
          },
        ],
      },
      { query: 'code agentic', limit: 1 },
    );
    expect(result).toMatchObject({ total: 2, truncated: true });
    expect(result.models).toHaveLength(1);
  });
  test('keeps the complete popularity order and joins sourced benchmark facts', async () => {
    const fetcher = async (url: URL): Promise<Response> => {
      if (url.pathname.endsWith('/models')) return response(models());
      if (url.searchParams.get('source') === 'artificial-analysis') {
        return response({
          data: [
            {
              source: 'artificial-analysis',
              model_permaslug: 'vendor/model-a-20260830',
              display_name: 'Model A',
              intelligence_index: 70,
              coding_index: 80,
              agentic_index: 75,
            },
          ],
          meta: { as_of: observedAt },
        });
      }
      return response({
        data: [
          {
            source: 'design-arena',
            model_permaslug: 'vendor/model-a-20260830',
            display_name: 'Model A',
            arena: 'agents',
            category: 'coding',
            elo: 1240,
            win_rate: 61.5,
            avg_generation_time_ms: 950,
          },
        ],
        meta: { as_of: observedAt },
      });
    };
    const catalog = await openRouterModelCatalog({
      apiKey: 'secret',
      fetcher,
      now: () => new Date(observedAt),
    }).load();

    expect(catalog.observedAt).toBe(observedAt);
    expect(catalog.completeness).toBe('complete');
    expect(catalog.models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({
      id: 'vendor/model-a',
      popularity: { rank: 1, window: 'week' },
      descriptor: { capabilities: ['tools', 'vision', 'reasoning'] },
      price: { currency: 'USD', inputPerToken: '0.000001' },
    });
    expect(catalog.models[0]?.metrics.map(({ metric }) => metric)).toEqual([
      'intelligence',
      'coding',
      'agentic',
      'design-arena:agents:coding:elo',
      'design-arena:agents:coding:win-rate',
      'design-arena:agents:coding:generation-time',
    ]);
    expect(catalog.models[1]).toMatchObject({
      id: 'vendor/model-b',
      popularity: { rank: 2 },
      metrics: [],
    });
  });

  test('openRouterModelCatalog maps include_reasoning to reasoning capability and leaves non-reasoning models without it', async () => {
    const fetcher = async (url: URL): Promise<Response> =>
      url.pathname.endsWith('/models')
        ? response({
            data: [
              {
                id: 'vendor/include-reasoning',
                name: 'Include Reasoning',
                context_length: 64_000,
                architecture: { input_modalities: ['text'] },
                pricing: { prompt: '0.000001', completion: '0.000002' },
                supported_parameters: ['tools', 'include_reasoning'],
              },
              {
                id: 'vendor/plain-tools',
                name: 'Plain Tools',
                context_length: 64_000,
                architecture: { input_modalities: ['text'] },
                pricing: { prompt: '0.000001', completion: '0.000002' },
                supported_parameters: ['tools'],
              },
            ],
          })
        : response({ data: [] });

    const catalog = await openRouterModelCatalog({
      fetcher,
      now: () => new Date(observedAt),
    }).load();
    expect(catalog.observedAt).toBe(observedAt);
    expect(catalog.models[0]?.descriptor.capabilities).toEqual(['tools', 'reasoning']);
    expect(catalog.models[1]?.descriptor.capabilities).toEqual(['tools']);
  });

  test('keeps models usable with explicit partial diagnostics when benchmarks fail', async () => {
    const fetcher = async (url: URL): Promise<Response> =>
      url.pathname.endsWith('/models') ? response(models()) : response({}, 503);
    const catalog = await openRouterModelCatalog({
      apiKey: 'secret',
      fetcher,
      now: () => new Date(observedAt),
    }).load();

    expect(catalog.completeness).toBe('partial');
    expect(catalog.models).toHaveLength(2);
    expect(catalog.diagnostics).toHaveLength(2);
  });

  test('isolates successful benchmark responses whose schema drifted', async () => {
    const fetcher = async (url: URL): Promise<Response> =>
      url.pathname.endsWith('/models') ? response(models()) : response({ data: 'changed' });
    const catalog = await openRouterModelCatalog({
      apiKey: 'secret',
      fetcher,
      now: () => new Date(observedAt),
    }).load();

    expect(catalog.completeness).toBe('partial');
    expect(catalog.models).toHaveLength(2);
    expect(catalog.diagnostics).toEqual([
      'Artificial Analysis benchmark data is malformed',
      'Design Arena benchmark data is malformed',
    ]);
  });

  test('fails the catalog when the canonical models request fails', async () => {
    const fetcher = async (): Promise<Response> => response({}, 503);
    await expect(openRouterModelCatalog({ apiKey: 'secret', fetcher }).load()).rejects.toThrow(
      'OpenRouter request /api/v1/models failed with HTTP 503',
    );
  });

  test('bounds the whole catalog fan-out with one timeout signal', async () => {
    const fetcher = (_url: URL, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    await expect(
      openRouterModelCatalog({ apiKey: 'secret', fetcher, timeoutMs: 1 }).load(),
    ).rejects.toBeDefined();
  });

  test('refuses non-positive, non-integer, and over-MAX_TIMER_MS timeoutMs before any fetch', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return response(models());
    };
    for (const invalid of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_TIMER_MS + 1,
    ]) {
      // The catalog refuses when it is created, not on its first load.
      expect(() =>
        openRouterModelCatalog({ apiKey: 'secret', fetcher, timeoutMs: invalid }),
      ).toThrow(RangeError);
      await expect(
        loadOpenRouterCatalogSnapshot({ apiKey: 'secret', fetcher, timeoutMs: invalid }),
      ).rejects.toThrow(RangeError);
      await expect(
        fetchOpenRouterModelEndpoints('vendor/model-a', {
          apiKey: 'secret',
          fetcher,
          timeoutMs: invalid,
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(calls).toBe(0);
    expect(() => withOpenRouterTimeout(0, undefined, requests)).toThrow(RangeError);
    expect(() => withOpenRouterTimeout(MAX_TIMER_MS + 1, undefined, requests)).toThrow(
      RangeError,
    );
    // The caller's signal reaches the requests while they run, and is let go once they end.
    const cancelled = new AbortController();
    await withOpenRouterTimeout(MAX_TIMER_MS, cancelled.signal, async (combined) => {
      expect(combined.aborted).toBe(false);
      cancelled.abort(new Error('caller cancelled'));
      expect(combined.aborted).toBe(true);
    });
    const finished = new AbortController();
    const released = await withOpenRouterTimeout(
      MAX_TIMER_MS,
      finished.signal,
      async (s) => s,
    );
    finished.abort(new Error('caller cancelled after the requests'));
    expect(released.aborted).toBe(false);
    expect('withOpenRouterTimeout' in openRouterEntrypoint).toBe(false);
    expect('assertOpenRouterTimeoutMs' in openRouterEntrypoint).toBe(false);
  });

  test('createOpenRouterSpendReconciler validates timeoutMs eagerly without allocating a timer on construction', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Response> => {
      calls += 1;
      return response({ data: { total_cost: 0.01 } });
    };
    const timeoutSpy = spyOn(AbortSignal, 'timeout');
    try {
      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          openRouterEntrypoint.createOpenRouterSpendReconciler({
            apiKey: 'secret',
            fetcher,
            timeoutMs: invalid,
          }),
        ).toThrow(RangeError);
      }
      expect(() =>
        openRouterEntrypoint.createOpenRouterSpendReconciler({
          apiKey: 'secret',
          fetcher,
          timeoutMs: JSON.parse('"100"'),
        }),
      ).toThrow(TypeError);
      expect(() =>
        openRouterEntrypoint.createOpenRouterSpendReconciler({
          apiKey: 'secret',
          fetcher,
          timeoutMs: MAX_TIMER_MS + 1,
        }),
      ).toThrow(RangeError);
      expect(() => withOpenRouterTimeout(JSON.parse('null'), undefined, requests)).toThrow(
        TypeError,
      );
      expect(() => withOpenRouterTimeout(JSON.parse('"50"'), undefined, requests)).toThrow(
        TypeError,
      );
      expect(() =>
        Reflect.apply(withOpenRouterTimeout, undefined, [undefined, undefined, requests]),
      ).toThrow(TypeError);
      expect(() => withOpenRouterTimeout(MAX_TIMER_MS + 1, undefined, requests)).toThrow(
        RangeError,
      );
      expect(calls).toBe(0);

      openRouterEntrypoint.createOpenRouterSpendReconciler({
        apiKey: 'secret',
        fetcher,
      });
      const reconcile = openRouterEntrypoint.createOpenRouterSpendReconciler({
        apiKey: 'secret',
        fetcher,
        timeoutMs: 50,
      });
      expect(timeoutSpy).toHaveBeenCalledTimes(0);
      expect(calls).toBe(0);

      // Positive control: reconciliation allocates a per-request timeout signal only when called.
      const settled = await reconcile({
        attempt: {
          attemptId: 'attempt-1',
          gateway: 'openrouter',
          startedAt: observedAt,
          attribution: { purpose: 'test' },
          request: { method: 'POST', origin: 'https://openrouter.ai', path: '/' },
        },
        receipt: {
          attemptId: 'attempt-1',
          rank: 1,
          at: observedAt,
          outcome: 'succeeded',
          facts: { costStatus: 'pending', providerRequestId: 'gen-1' },
        },
      });
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutSpy).toHaveBeenCalledWith(50);
      expect(calls).toBe(1);
      expect(settled).toMatchObject({ costStatus: 'reported', costUsd: 0.01 });
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe('OpenRouter snapshot metadata, endpoints, completeness and authentication', () => {
  test('extracts full model and endpoint metadata while keeping unknown or invalid values undefined', async () => {
    const fetcher = async (url: URL): Promise<Response> => {
      if (url.pathname.endsWith('/endpoints')) {
        return response({
          data: {
            endpoints: [
              {
                provider_name: 'Primary',
                context_length: 200_000,
                max_completion_tokens: 64_000,
                pricing: {
                  prompt: '0.000002',
                  completion: '0.000010',
                  input_cache_read: '0.0000002',
                  input_cache_write: '0.0000025',
                },
                supported_parameters: ['tools', 'reasoning'],
                status: 0,
                latency_last_30m: { p50: 420.5 },
                throughput_last_30m: { p50: 88.2 },
                uptime_last_1d: 99.8,
                tag: 'primary/default',
              },
              {
                provider_name: 'UnknownMetrics',
                pricing: {
                  prompt: '-1',
                  completion: '',
                  input_cache_read: '-1',
                  input_cache_write: 'not-a-number',
                },
                latency_last_30m: { p50: -1 },
                throughput_last_30m: { p50: -5 },
                uptime_last_1d: 105,
                tag: '   ',
              },
              {
                provider_name: 'ZeroMetrics',
                pricing: { prompt: '0', completion: '0' },
                latency_last_30m: { p50: 0 },
                throughput_last_30m: { p50: 0 },
                uptime_last_1d: 0,
              },
            ],
          },
        });
      }
      return response({
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            canonical_slug: 'anthropic/claude-sonnet-4-20260501',
            name: 'Claude Sonnet 4',
            description: 'Flagship coding model',
            created: 1_756_555_200,
            alias_target: {
              slug: 'anthropic/claude-sonnet-4-20260501',
              name: 'Claude Sonnet 4 Dated',
            },
            context_length: 1_000_000,
            architecture: {
              input_modalities: ['text', 'image', 'file'],
              output_modalities: ['text'],
              tokenizer: 'Claude',
            },
            top_provider: {
              context_length: 200_000,
              max_completion_tokens: 64_000,
            },
            reasoning: {
              supported_efforts: ['low', 'medium', 'high'],
              default_effort: 'medium',
            },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              request: '0.001',
              image: '0.005',
              input_cache_read: '0.0000003',
              input_cache_write: '0.00000375',
              overrides: [
                {
                  min_prompt_tokens: 200_000,
                  prompt: '0.000006',
                  completion: '0.0000225',
                  input_cache_read: '0.0000006',
                  input_cache_write: '0.0000075',
                  request: '0.002',
                },
                {
                  min_prompt_tokens: 128_000,
                  pricing: {
                    prompt: '0.000004',
                    completion: '0.000018',
                  },
                },
              ],
            },
            supported_parameters: ['tools', 'reasoning'],
          },
          {
            id: 'vendor/unknown-values',
            name: 'Unknown Values',
            description: '   ',
            created: null,
            alias_target: null,
            context_length: 32_000,
            architecture: {
              input_modalities: ['text'],
              output_modalities: null,
              tokenizer: '  ',
            },
            top_provider: null,
            reasoning: { supported_efforts: [], default_effort: null },
            pricing: {
              prompt: '-1',
              completion: null,
              image: '-1',
              input_cache_read: '-1',
              input_cache_write: '',
              overrides: [{ condition: 'non-token-rule', prompt: '0.000099' }],
            },
            supported_parameters: [],
          },
        ],
        links: { next: null },
      });
    };

    const snapshot = await loadOpenRouterCatalogSnapshot({
      fetcher,
      endpointsFor: ['anthropic/claude-sonnet-4'],
      now: () => new Date(observedAt),
    });

    const rich = snapshot.models[0];
    expect(rich).toEqual({
      id: 'anthropic/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      canonicalSlug: 'anthropic/claude-sonnet-4-20260501',
      description: 'Flagship coding model',
      createdAt: '2025-08-30T12:00:00.000Z',
      aliasTarget: {
        id: 'anthropic/claude-sonnet-4-20260501',
        name: 'Claude Sonnet 4 Dated',
      },
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      tokenizer: 'Claude',
      contextLength: 1_000_000,
      topProviderContextLength: 200_000,
      maxCompletionTokens: 64_000,
      reasoning: {
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      promptUsdPerMillion: 3,
      completionUsdPerMillion: 15,
      requestUsd: 0.001,
      imageUsd: 0.005,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      hasConditionalPricing: true,
      pricingTiers: [
        {
          minPromptTokens: 128_000,
          promptUsdPerMillion: 4,
          completionUsdPerMillion: 18,
        },
        {
          minPromptTokens: 200_000,
          promptUsdPerMillion: 6,
          completionUsdPerMillion: 22.5,
          cacheReadUsdPerMillion: 0.6,
          cacheWriteUsdPerMillion: 7.5,
          requestUsd: 0.002,
        },
      ],
      supportedParameters: ['tools', 'reasoning'],
      endpoints: [
        {
          provider: 'Primary',
          contextLength: 200_000,
          maxCompletionTokens: 64_000,
          promptUsdPerMillion: 2,
          completionUsdPerMillion: 10,
          cacheReadUsdPerMillion: 0.2,
          cacheWriteUsdPerMillion: 2.5,
          supportedParameters: ['tools', 'reasoning'],
          status: 0,
          latencyP50Ms: 420.5,
          throughputP50: 88.2,
          uptime1d: 99.8,
          tag: 'primary/default',
        },
        {
          provider: 'UnknownMetrics',
          supportedParameters: [],
        },
        {
          provider: 'ZeroMetrics',
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          supportedParameters: [],
          latencyP50Ms: 0,
          throughputP50: 0,
          uptime1d: 0,
        },
      ],
    });

    const sparse = snapshot.models[1];
    expect(sparse).toEqual({
      id: 'vendor/unknown-values',
      name: 'Unknown Values',
      inputModalities: ['text'],
      contextLength: 32_000,
      requestUsd: 0,
      hasConditionalPricing: true,
      unknownPricingFields: ['prompt', 'completion', 'image', 'cacheRead', 'cacheWrite'],
      hasUnverifiedPricingOverrides: true,
      supportedParameters: [],
    });
    expect(sparse?.promptUsdPerMillion).toBeUndefined();
    expect(sparse?.imageUsd).toBeUndefined();
    expect(sparse?.cacheReadUsdPerMillion).toBeUndefined();
    expect(sparse?.cacheWriteUsdPerMillion).toBeUndefined();
    expect(sparse?.pricingTiers).toBeUndefined();

    // Backwards compatibility: minimal v1 snapshot without new optional fields still parses.
    expect(
      OpenRouterCatalogSnapshotSchema.parse({
        schemaVersion: 1,
        observedAt,
        models: [
          {
            id: 'legacy/model',
            inputModalities: ['text'],
            contextLength: 8_192,
            supportedParameters: ['tools'],
          },
        ],
      }).models[0]?.id,
    ).toBe('legacy/model');
  });

  test('rejects paginated truncation (links.next) and duplicate model ids', async () => {
    const truncatedFetcher = async () =>
      response({
        ...models(),
        links: { next: 'https://openrouter.ai/api/v1/models?cursor=page-2' },
      });
    await expect(loadOpenRouterCatalogSnapshot({ fetcher: truncatedFetcher })).rejects.toThrow(
      'Incomplete OpenRouter catalog response (paginated next link present)',
    );

    const duplicateFetcher = async () =>
      response({
        data: [
          {
            id: 'vendor/dup',
            name: 'Dup 1',
            context_length: 8_000,
            architecture: { input_modalities: ['text'] },
            pricing: {},
          },
          {
            id: 'vendor/dup',
            name: 'Dup 2',
            context_length: 16_000,
            architecture: { input_modalities: ['text'] },
            pricing: {},
          },
        ],
      });
    await expect(loadOpenRouterCatalogSnapshot({ fetcher: duplicateFetcher })).rejects.toThrow(
      'Duplicate OpenRouter model id: vendor/dup',
    );
  });

  test('supports unauthenticated catalog reads and async dynamic apiKey while refusing empty keys', async () => {
    const seenHeaders: Array<{
      url: string;
      auth: string | null;
      redirect?: RequestRedirect;
    }> = [];
    const fetcher = async (url: URL, init?: RequestInit): Promise<Response> => {
      seenHeaders.push({
        url: url.pathname,
        auth: new Headers(init?.headers).get('authorization'),
        ...(init?.redirect && { redirect: init.redirect }),
      });
      if (url.pathname.endsWith('/endpoints')) {
        return response({ data: { endpoints: [{ provider_name: 'Up' }] } });
      }
      return response(models());
    };

    // Unauthenticated: Authorization header is completely absent.
    await loadOpenRouterCatalogSnapshot({
      fetcher,
      endpointsFor: ['vendor/model-a'],
    });
    expect(seenHeaders).toEqual([
      { url: '/api/v1/models', auth: null, redirect: 'error' },
      { url: '/api/v1/models/vendor/model-a/endpoints', auth: null, redirect: 'error' },
    ]);

    // Dynamic async apiKey: resolved per call and trimmed.
    seenHeaders.length = 0;
    let calls = 0;
    await loadOpenRouterCatalogSnapshot({
      apiKey: async () => {
        calls += 1;
        return `  rotated-key-${calls}  `;
      },
      fetcher,
      endpointsFor: ['vendor/model-a'],
    });
    expect(seenHeaders).toEqual([
      { url: '/api/v1/models', auth: 'Bearer rotated-key-1', redirect: 'error' },
      {
        url: '/api/v1/models/vendor/model-a/endpoints',
        auth: 'Bearer rotated-key-2',
        redirect: 'error',
      },
    ]);

    // Negative controls: explicit empty or whitespace-only apiKey is refused before any fetch.
    seenHeaders.length = 0;
    await expect(loadOpenRouterCatalogSnapshot({ apiKey: '', fetcher })).rejects.toThrow(
      TypeError,
    );
    await expect(loadOpenRouterCatalogSnapshot({ apiKey: '   ', fetcher })).rejects.toThrow(
      TypeError,
    );
    await expect(
      fetchOpenRouterModelEndpoints('vendor/model-a', {
        apiKey: async () => '  ',
        fetcher,
      }),
    ).rejects.toThrow(TypeError);
    expect(seenHeaders).toHaveLength(0);
  });
});

describe('OpenRouter pricing ceiling, endpoint summary and catalog queries', () => {
  const baseModel = (
    overrides: Partial<OpenRouterSnapshotModel> = {},
  ): OpenRouterSnapshotModel => ({
    id: 'openai/gpt-5',
    name: 'GPT-5',
    inputModalities: ['text'],
    contextLength: 200_000,
    supportedParameters: ['tools'],
    ...overrides,
  });

  test('resolveOpenRouterModelCeiling returns worst-case rates and refuses to understate unknown tiers', () => {
    // Base-only with cacheWrite higher than base prompt.
    expect(
      OpenRouterModelPricingCeilingSchema.parse(
        resolveOpenRouterModelCeiling(
          baseModel({
            promptUsdPerMillion: 2,
            cacheWriteUsdPerMillion: 2.5,
            completionUsdPerMillion: 8,
            requestUsd: 0.002,
          }),
        ),
      ),
    ).toEqual({
      promptUsdPerMillion: 2.5,
      completionUsdPerMillion: 8,
      requestUsd: 0.002,
    });

    // Multi-tier conditional pricing: picks max across base + all tiers including cacheWrite.
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({
          promptUsdPerMillion: 2,
          completionUsdPerMillion: 8,
          requestUsd: 0.001,
          hasConditionalPricing: true,
          pricingTiers: [
            {
              minPromptTokens: 128_000,
              promptUsdPerMillion: 4,
              completionUsdPerMillion: 12,
              cacheWriteUsdPerMillion: 5.5,
            },
            {
              minPromptTokens: 200_000,
              promptUsdPerMillion: 5,
              completionUsdPerMillion: 20,
              requestUsd: 0.004,
            },
          ],
        }),
      ),
    ).toEqual({
      promptUsdPerMillion: 5.5,
      completionUsdPerMillion: 20,
      requestUsd: 0.004,
    });

    // Measured zero stays 0 (not omitted).
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({ promptUsdPerMillion: 0, completionUsdPerMillion: 0 }),
      ),
    ).toEqual({ promptUsdPerMillion: 0, completionUsdPerMillion: 0 });

    // Negative controls: unknown base prompt never falls back to cacheWrite; missing tier prompt returns undefined.
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({ cacheWriteUsdPerMillion: 3, completionUsdPerMillion: 8 }),
      ),
    ).toEqual({ completionUsdPerMillion: 8 });

    // Partial override omitting prompt inherits base prompt rather than wiping it out.
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({
          promptUsdPerMillion: 2,
          completionUsdPerMillion: 8,
          hasConditionalPricing: true,
          pricingTiers: [{ minPromptTokens: 200_000, completionUsdPerMillion: 16 }],
        }),
      ),
    ).toEqual({ promptUsdPerMillion: 2, completionUsdPerMillion: 16 });

    // Explicitly unknown prompt in a tier refuses prompt ceiling instead of falling back to base.
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({
          promptUsdPerMillion: 2,
          completionUsdPerMillion: 8,
          hasConditionalPricing: true,
          pricingTiers: [
            {
              minPromptTokens: 200_000,
              completionUsdPerMillion: 16,
              unknownPricingFields: ['prompt'],
            },
          ],
        }),
      ),
    ).toEqual({ completionUsdPerMillion: 16 });

    // Conditional pricing with unparseable/omitted tiers returns {} rather than understating.
    expect(
      resolveOpenRouterModelCeiling(
        baseModel({
          promptUsdPerMillion: 2,
          completionUsdPerMillion: 8,
          requestUsd: 0.001,
          hasConditionalPricing: true,
        }),
      ),
    ).toEqual({});
  });

  test('summarizeOpenRouterEndpoints aggregates distinct providers and omits unknown metrics', () => {
    expect(OpenRouterEndpointSummarySchema.parse(summarizeOpenRouterEndpoints([]))).toEqual({
      providers: 0,
    });

    const missingTelemetry: OpenRouterEndpoint[] = [
      { provider: 'A', supportedParameters: [] },
      { provider: 'B', supportedParameters: [] },
    ];
    const missingSummary = summarizeOpenRouterEndpoints(missingTelemetry);
    expect(missingSummary).toEqual({ providers: 2 });
    expect(missingSummary.latencyP50Ms).toBeUndefined();
    expect(missingSummary.throughputP50).toBeUndefined();
    expect(missingSummary.uptime1d).toBeUndefined();

    const mixed: OpenRouterEndpoint[] = [
      {
        provider: 'Google',
        supportedParameters: [],
        latencyP50Ms: 510,
        throughputP50: 70,
        uptime1d: 99.1,
        tag: 'google/us',
      },
      {
        provider: 'Google',
        supportedParameters: [],
        latencyP50Ms: 320,
        uptime1d: 99.9,
        tag: 'google/eu',
      },
      {
        provider: 'Anthropic',
        supportedParameters: [],
        throughputP50: 112.5,
      },
    ];
    expect(OpenRouterEndpointSummarySchema.parse(summarizeOpenRouterEndpoints(mixed))).toEqual(
      {
        providers: 2,
        latencyP50Ms: 320,
        throughputP50: 112.5,
        uptime1d: 99.9,
      },
    );

    // Explicit measured 0 is preserved, not omitted.
    expect(
      summarizeOpenRouterEndpoints([
        { provider: 'Local', supportedParameters: [], latencyP50Ms: 0, uptime1d: 0 },
      ]),
    ).toEqual({ providers: 1, latencyP50Ms: 0, uptime1d: 0 });
  });

  test('findOpenRouterModel and listOpenRouterModels support every lookup and filter criterion', () => {
    const snapshot: OpenRouterCatalogSnapshot = {
      schemaVersion: 1,
      observedAt,
      models: [
        baseModel({
          id: 'anthropic/claude-sonnet',
          canonicalSlug: 'anthropic/claude-sonnet-202605',
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          contextLength: 1_000_000,
          topProviderContextLength: 150_000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 15,
          supportedParameters: ['tools', 'reasoning'],
        }),
        baseModel({
          id: 'openai/gpt-free',
          canonicalSlug: 'openai/gpt-free-2026',
          inputModalities: ['text'],
          outputModalities: ['text', 'image'],
          contextLength: 64_000,
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'low' },
          supportedParameters: ['tools'],
        }),
        baseModel({
          id: 'openai-community/zero-with-fee',
          inputModalities: ['text'],
          outputModalities: ['text'],
          contextLength: 64_000,
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          requestUsd: 0.01,
          supportedParameters: [],
        }),
        baseModel({
          id: 'vendor/unpriced',
          canonicalSlug: 'anthropic/claude-sonnet',
          inputModalities: ['text'],
          contextLength: 256_000,
          supportedParameters: [],
        }),
      ],
    };

    // Exact id match wins over an earlier or later canonicalSlug collision.
    expect(findOpenRouterModel(snapshot, 'anthropic/claude-sonnet')?.id).toBe(
      'anthropic/claude-sonnet',
    );
    expect(findOpenRouterModel(snapshot, 'anthropic/claude-sonnet-202605')?.id).toBe(
      'anthropic/claude-sonnet',
    );
    expect(findOpenRouterModel(snapshot, 'nonexistent/model')).toBeUndefined();

    // Unfiltered list returns a shallow copy.
    const all = listOpenRouterModels(snapshot);
    expect(all).toHaveLength(4);
    expect(all).not.toBe(snapshot.models);

    // tools filter
    expect(listOpenRouterModels(snapshot, { tools: true }).map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-free',
    ]);
    expect(listOpenRouterModels(snapshot, { tools: false }).map((m) => m.id)).toEqual([
      'openai-community/zero-with-fee',
      'vendor/unpriced',
    ]);

    // reasoning filter matches both supportedParameters and reasoning metadata
    expect(listOpenRouterModels(snapshot, { reasoning: true }).map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-free',
    ]);
    expect(listOpenRouterModels(snapshot, { reasoning: false }).map((m) => m.id)).toEqual([
      'openai-community/zero-with-fee',
      'vendor/unpriced',
    ]);

    // inputModalities & outputModalities
    expect(
      listOpenRouterModels(snapshot, { inputModalities: ['text', 'image'] }).map((m) => m.id),
    ).toEqual(['anthropic/claude-sonnet']);
    expect(
      listOpenRouterModels(snapshot, { outputModalities: ['image'] }).map((m) => m.id),
    ).toEqual(['openai/gpt-free']);

    // minContextLength uses min(contextLength, topProviderContextLength) when both positive
    expect(
      listOpenRouterModels(snapshot, { minContextLength: 200_000 }).map((m) => m.id),
    ).toEqual(['vendor/unpriced']);
    expect(
      listOpenRouterModels(snapshot, { minContextLength: 150_000 }).map((m) => m.id),
    ).toEqual(['anthropic/claude-sonnet', 'vendor/unpriced']);

    // Price ceilings exclude unpriced models (unknown is never <= limit)
    expect(
      listOpenRouterModels(snapshot, { maxPromptUsdPerMillion: 3 }).map((m) => m.id),
    ).toEqual([
      'anthropic/claude-sonnet',
      'openai/gpt-free',
      'openai-community/zero-with-fee',
    ]);
    expect(
      listOpenRouterModels(snapshot, { maxCompletionUsdPerMillion: 10 }).map((m) => m.id),
    ).toEqual(['openai/gpt-free', 'openai-community/zero-with-fee']);

    // freeOnly excludes paid, unpriced, and $0-token models that still charge per-request fees
    expect(listOpenRouterModels(snapshot, { freeOnly: true }).map((m) => m.id)).toEqual([
      'openai/gpt-free',
    ]);
    expect(listOpenRouterModels(snapshot, { freeOnly: false })).toHaveLength(4);

    // author is an exact case-insensitive prefix before `/`
    expect(listOpenRouterModels(snapshot, { author: 'OpenAI' }).map((m) => m.id)).toEqual([
      'openai/gpt-free',
    ]);
  });
});

describe('OpenRouter catalog cache', () => {
  test('validates timer, concurrency and maxResponseBytes options eagerly before any fetch or store read', () => {
    let fetches = 0;
    let reads = 0;
    const fetcher = async () => {
      fetches += 1;
      return response(models());
    };
    const store: OpenRouterCatalogStore = {
      read: () => {
        reads += 1;
        return null;
      },
      write: () => undefined,
    };

    for (const option of ['timeoutMs', 'freshMs', 'retryBackoffMs'] as const) {
      for (const invalid of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        MAX_TIMER_MS + 1,
      ]) {
        expect(() =>
          createOpenRouterCatalogCache({ fetcher, store, [option]: invalid }),
        ).toThrow(RangeError);
      }
      expect(() =>
        createOpenRouterCatalogCache({ fetcher, store, [option]: JSON.parse('"1000"') }),
      ).toThrow(TypeError);
    }

    for (const badConcurrency of [0, -1, 1.5, 17]) {
      expect(() =>
        createOpenRouterCatalogCache({ fetcher, store, concurrency: badConcurrency }),
      ).toThrow(RangeError);
    }
    for (const badBytes of [0, -10, 1.5, Number.NaN]) {
      expect(() =>
        createOpenRouterCatalogCache({ fetcher, store, maxResponseBytes: badBytes }),
      ).toThrow(RangeError);
    }
    expect(fetches).toBe(0);
    expect(reads).toBe(0);
  });

  test('coalesces concurrent reads, honours freshMs TTL, and isolates per-caller AbortSignals', async () => {
    let nowMs = Date.parse(observedAt);
    let fetchCount = 0;
    let releaseFirstFetch: (() => void) | undefined;
    let markFirstFetchStarted: (() => void) | undefined;
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const abortedSignals: boolean[] = [];

    const fetcher = (_url: URL, init?: RequestInit): Promise<Response> => {
      fetchCount += 1;
      const callNumber = fetchCount;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          abortedSignals.push(true);
          reject(init?.signal?.reason);
        };
        init?.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = () => {
          init?.signal?.removeEventListener('abort', onAbort);
          resolve(response(models()));
        };
        if (callNumber === 1) {
          releaseFirstFetch = finish;
          markFirstFetchStarted?.();
        } else {
          finish();
        }
      });
    };

    const cache = createOpenRouterCatalogCache({
      fetcher,
      freshMs: 60_000,
      retryBackoffMs: 10_000,
      now: () => new Date(nowMs),
    });

    // Single-flight coalescing: Caller A aborts, Caller B & C share the one in-flight fetch.
    const abortA = new AbortController();
    const readA = cache.read({ signal: abortA.signal });
    const readB = cache.read();
    const readC = cache.read();
    await firstFetchStarted;
    expect(fetchCount).toBe(1);

    abortA.abort(new Error('caller-a-cancelled'));
    await expect(readA).rejects.toThrow('caller-a-cancelled');
    expect(abortedSignals).toEqual([]);

    releaseFirstFetch?.();
    const [resultB, resultC] = await Promise.all([readB, readC]);
    expect(fetchCount).toBe(1);
    expect(resultB.status).toBe('current');
    expect(resultC.status).toBe('current');
    expect(resultB.models).toHaveLength(2);
    expect((await cache.getModel('vendor/model-a-20260830'))?.id).toBe('vendor/model-a');
    expect((await cache.listModels({ reasoning: true })).map((m) => m.id)).toEqual([
      'vendor/model-a',
    ]);

    // Still within freshMs: zero additional fetches.
    nowMs += 59_999;
    expect((await cache.read()).status).toBe('current');
    expect(fetchCount).toBe(1);

    // Past freshMs: refreshes once.
    nowMs += 1;
    expect((await cache.read()).status).toBe('current');
    expect(fetchCount).toBe(2);

    // Pre-aborted signal rejects without fetching.
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('already-aborted'));
    await expect(cache.refresh({ signal: alreadyAborted.signal })).rejects.toThrow(
      'already-aborted',
    );
    expect(fetchCount).toBe(2);
  });

  test('sole-caller abort cancels the underlying request without triggering retry backoff', async () => {
    let fetchCount = 0;
    let upstreamAborted = false;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const errors: unknown[] = [];

    const fetcher = (_url: URL, init?: RequestInit): Promise<Response> => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              upstreamAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
          markFetchStarted?.();
        });
      }
      return Promise.resolve(response(models()));
    };

    const cache = createOpenRouterCatalogCache({
      fetcher,
      retryBackoffMs: 60_000,
      onError: (error) => errors.push(error),
    });

    const controller = new AbortController();
    const pending = cache.read({ signal: controller.signal });
    await fetchStarted;
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    expect(upstreamAborted).toBe(true);
    expect(errors).toEqual([]);

    // Next caller fetches immediately with zero backoff penalty.
    const recovered = await cache.read();
    expect(fetchCount).toBe(2);
    expect(recovered.status).toBe('current');
  });

  test('falls back to unavailable and stale on upstream failure, obeys retryBackoffMs, and recovers on forceRefresh or backoff expiry', async () => {
    let nowMs = Date.parse(observedAt);
    let failUpstream = true;
    let fetchCount = 0;
    const errors: unknown[] = [];

    const fetcher = async (): Promise<Response> => {
      fetchCount += 1;
      if (failUpstream) return response({}, 503);
      return response(models());
    };

    const cache = createOpenRouterCatalogCache({
      fetcher,
      freshMs: 10_000,
      retryBackoffMs: 30_000,
      onError: (error) => errors.push(error),
      now: () => new Date(nowMs),
    });

    // Cold failure -> unavailable.
    const cold = await cache.read();
    expect(cold.status).toBe('unavailable');
    expect(cold.observedAt).toBeNull();
    expect(cold.snapshot).toBeNull();
    expect(cold.models).toEqual([]);
    expect(cold.lastError).toBeInstanceOf(Error);
    expect(fetchCount).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await cache.getModel('vendor/model-a')).toBeUndefined();
    expect(await cache.listModels()).toEqual([]);
    // Backoff suppressed fetches during getModel/listModels.
    expect(fetchCount).toBe(1);

    // forceRefresh bypasses retryBackoffMs and recovers when upstream is healthy.
    failUpstream = false;
    const forced = await cache.refresh();
    expect(fetchCount).toBe(2);
    expect(forced.status).toBe('current');
    expect(forced.lastError).toBeUndefined();
    expect(forced.models).toHaveLength(2);

    // Snapshot expires and upstream fails again -> falls back to stale snapshot.
    nowMs += 15_000;
    failUpstream = true;
    const stale = await cache.read();
    expect(fetchCount).toBe(3);
    expect(stale.status).toBe('stale');
    expect(stale.observedAt).toBe(observedAt);
    expect(stale.models).toHaveLength(2);
    expect(stale.lastError).toBeInstanceOf(Error);

    // Within retryBackoffMs -> no upstream call.
    nowMs += 29_999;
    expect((await cache.read()).status).toBe('stale');
    expect(fetchCount).toBe(3);

    // Backoff expires -> retries automatically and recovers to current.
    nowMs += 1;
    failUpstream = false;
    const current = await cache.read();
    expect(fetchCount).toBe(4);
    expect(current.status).toBe('current');
    expect(current.lastError).toBeUndefined();
  });

  test('hydrates from pluggable store, tolerates corrupted/failing store reads and writes, and passes snapshot options through', async () => {
    let nowMs = Date.parse(observedAt);
    const storedSnapshot: OpenRouterCatalogSnapshot = {
      schemaVersion: 1,
      observedAt,
      models: [
        {
          id: 'stored/model',
          name: 'Stored Model',
          inputModalities: ['text'],
          contextLength: 16_000,
          supportedParameters: ['tools'],
        },
      ],
    };

    // 1. Fresh store snapshot satisfies concurrent initial reads with zero network calls and one store.read().
    let storeReads = 0;
    let fetches = 0;
    const freshCache = createOpenRouterCatalogCache({
      fetcher: async () => {
        fetches += 1;
        return response(models());
      },
      freshMs: 60_000,
      now: () => new Date(nowMs),
      store: {
        read: async () => {
          storeReads += 1;
          return storedSnapshot;
        },
        write: () => undefined,
      },
    });
    const [r1, r2] = await Promise.all([freshCache.read(), freshCache.read()]);
    expect(storeReads).toBe(1);
    expect(fetches).toBe(0);
    expect(r1.status).toBe('current');
    expect(r2.models[0]?.id).toBe('stored/model');

    // 2. Stale store snapshot triggers refresh and falls back to stale on network outage.
    nowMs += 120_000;
    const staleHydrated = createOpenRouterCatalogCache({
      fetcher: async () => response({}, 502),
      freshMs: 60_000,
      now: () => new Date(nowMs),
      store: {
        read: () => storedSnapshot,
        write: () => undefined,
      },
    });
    const staleResult = await staleHydrated.read();
    expect(staleResult.status).toBe('stale');
    expect(staleResult.models[0]?.id).toBe('stored/model');
    expect(staleResult.lastError).toBeInstanceOf(Error);

    // 2b. Future-dated store snapshot is never trusted as fresh (triggers refresh).
    let futureFetches = 0;
    const futureStoreCache = createOpenRouterCatalogCache({
      fetcher: async () => {
        futureFetches += 1;
        return response(models());
      },
      freshMs: 60_000,
      now: () => new Date(Date.parse(observedAt) - 5_000),
      store: {
        read: () => storedSnapshot,
        write: () => undefined,
      },
    });
    const refreshedFromFuture = await futureStoreCache.read();
    expect(futureFetches).toBe(1);
    expect(refreshedFromFuture.status).toBe('current');
    expect(refreshedFromFuture.models[0]?.id).toBe('vendor/model-a');

    // 3. Corrupted store payload + throwing store.write + throwing onError still deliver current snapshot.
    const recordedErrors: unknown[] = [];
    const seenAuth: Array<string | null> = [];
    const seenUrls: string[] = [];
    const resilient = createOpenRouterCatalogCache({
      apiKey: async () => 'cache-key',
      endpointsFor: ['vendor/model-a'],
      concurrency: 2,
      maxResponseBytes: 1_048_576,
      fetcher: async (url, init) => {
        seenUrls.push(url.pathname);
        seenAuth.push(new Headers(init?.headers).get('authorization'));
        if (url.pathname.endsWith('/endpoints')) {
          return response({ data: { endpoints: [{ provider_name: 'CachedUp' }] } });
        }
        return response(models());
      },
      store: {
        read: () => JSON.parse('{"schemaVersion":999,"broken":true}'),
        write: async () => {
          throw new Error('disk full');
        },
      },
      onError: (error) => {
        recordedErrors.push(error);
        throw new Error('observer crashed');
      },
      now: () => new Date(nowMs),
    });

    const recovered = await resilient.read();
    expect(recovered.status).toBe('current');
    expect(recovered.models[0]?.endpoints?.[0]?.provider).toBe('CachedUp');
    expect(seenUrls).toEqual(['/api/v1/models', '/api/v1/models/vendor/model-a/endpoints']);
    expect(seenAuth).toEqual(['Bearer cache-key', 'Bearer cache-key']);
    // Both the corrupted store read and the failing store write were reported to onError.
    expect(recordedErrors).toHaveLength(2);
  });

  test('openRouterModelCatalog accepts optional and dynamic apiKey factories and AgentModelProviderOptionsSchema handles optional undefined fields', async () => {
    const authHeaders: Array<string | null> = [];
    const fetcher = async (url: URL, init?: RequestInit): Promise<Response> => {
      authHeaders.push(new Headers(init?.headers).get('authorization'));
      return url.pathname.endsWith('/models') ? response(models()) : response({ data: [] });
    };

    // Omitted apiKey sends no Authorization header.
    const anon = await openRouterModelCatalog({
      fetcher,
      now: () => new Date(observedAt),
    }).load();
    expect(anon.models).toHaveLength(2);
    expect(authHeaders).toEqual([null, null, null]);

    // Dynamic async apiKey resolves cleanly on load.
    authHeaders.length = 0;
    const dynamic = await openRouterModelCatalog({
      apiKey: async () => 'dynamic-catalog-token',
      fetcher,
      now: () => new Date(observedAt),
    }).load();
    expect(dynamic.models).toHaveLength(2);
    expect(authHeaders).toEqual([
      'Bearer dynamic-catalog-token',
      'Bearer dynamic-catalog-token',
      'Bearer dynamic-catalog-token',
    ]);

    // Negative control: empty dynamic apiKey fails loudly before fetch.
    let called = false;
    await expect(
      openRouterModelCatalog({
        apiKey: () => '   ',
        fetcher: async () => {
          called = true;
          return response(models());
        },
      }).load(),
    ).rejects.toThrow(TypeError);
    expect(called).toBe(false);

    // AgentModelProviderOptionsSchema accepts undefined optional fields (exactOptionalPropertyTypes) and rejects non-JSON values.
    expect(
      AgentModelProviderOptionsSchema.safeParse({
        openrouter: {
          sessionId: 's1',
          looseTools: undefined,
          provider: { order: ['a'], zdr: undefined },
        },
        openai: undefined,
        anthropic: { effort: 'high', betas: ['beta-1'] },
      }).success,
    ).toBe(true);
    expect(
      AgentModelProviderOptionsSchema.safeParse({
        openrouter: { bad: () => 'nope' },
      }).success,
    ).toBe(false);
    expect(
      AgentModelProviderOptionsSchema.safeParse({
        openrouter: { bad: [undefined] },
      }).success,
    ).toBe(false);
  });
});

describe('OpenRouter pricing ceilings, overrides, nullish rows, admission sync and cache ordering', () => {
  test('parses input_cache_write_1h across models, tiers and endpoints and distinguishes omitted vs unknown pricing keys', async () => {
    const fetcher = async (url: URL): Promise<Response> => {
      if (url.pathname.endsWith('/endpoints')) {
        return response({
          data: {
            endpoints: [
              {
                provider_name: 'Anthropic',
                pricing: {
                  prompt: '0.000003',
                  completion: '0.000015',
                  input_cache_read: '0.0000003',
                  input_cache_write: '0.00000375',
                  input_cache_write_1h: '0.000006',
                },
                status: 0,
              },
            ],
          },
        });
      }
      return response({
        data: [
          {
            id: 'anthropic/claude-1h',
            name: 'Claude 1h Cache',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              input_cache_read: '0.0000003',
              input_cache_write: '0.00000375',
              input_cache_write_1h: '0.000006',
              overrides: [
                {
                  min_prompt_tokens: 200_000,
                  prompt: '0.000006',
                  completion: '0.0000225',
                  input_cache_write: '0.0000075',
                  input_cache_write_1h: '0.000012',
                },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/explicit-unknown-request',
            name: 'Unknown Request Fee',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
              request: '-1',
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/null-request',
            name: 'Null Request Fee',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
              request: null,
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/unknown-cache-write',
            name: 'Unknown Cache Write',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              input_cache_write: '-1',
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/unknown-cache-write-1h',
            name: 'Unknown 1h Cache Write',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              input_cache_write_1h: null,
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/missing-pricing',
            name: 'Missing Pricing',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: null,
            supported_parameters: ['tools'],
          },
        ],
      });
    };

    const snapshot = await loadOpenRouterCatalogSnapshot({
      fetcher,
      endpointsFor: ['anthropic/claude-1h'],
      now: () => new Date(observedAt),
    });

    // Round-trip through JSON to verify persistence compatibility.
    const roundTripped = OpenRouterCatalogSnapshotSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );

    const claude = findOpenRouterModel(roundTripped, 'anthropic/claude-1h');
    expect(claude?.cacheWrite1hUsdPerMillion).toBe(6);
    expect(claude?.requestUsd).toBe(0);
    expect(claude?.pricingTiers?.[0]?.cacheWrite1hUsdPerMillion).toBe(12);
    expect(claude?.endpoints?.[0]?.cacheWrite1hUsdPerMillion).toBe(6);
    expect(claude ? resolveOpenRouterModelCeiling(claude) : undefined).toEqual({
      promptUsdPerMillion: 12,
      completionUsdPerMillion: 22.5,
      requestUsd: 0,
    });

    // Explicit request: "-1" and request: null leave requestUsd undefined (never 0).
    const unknownReq = findOpenRouterModel(roundTripped, 'vendor/explicit-unknown-request');
    expect(unknownReq?.requestUsd).toBeUndefined();
    expect(unknownReq ? resolveOpenRouterModelCeiling(unknownReq) : undefined).toEqual({
      promptUsdPerMillion: 1,
      completionUsdPerMillion: 2,
    });
    const nullReq = findOpenRouterModel(roundTripped, 'vendor/null-request');
    expect(nullReq?.requestUsd).toBeUndefined();
    expect(nullReq ? resolveOpenRouterModelCeiling(nullReq) : undefined).toEqual({
      promptUsdPerMillion: 1,
      completionUsdPerMillion: 2,
    });

    // Explicit input_cache_write: "-1" or input_cache_write_1h: null refuses prompt ceiling instead of substituting base prompt.
    const unknownCw = findOpenRouterModel(roundTripped, 'vendor/unknown-cache-write');
    expect(unknownCw ? resolveOpenRouterModelCeiling(unknownCw) : undefined).toEqual({
      completionUsdPerMillion: 15,
      requestUsd: 0,
    });
    const unknownCw1h = findOpenRouterModel(roundTripped, 'vendor/unknown-cache-write-1h');
    expect(unknownCw1h ? resolveOpenRouterModelCeiling(unknownCw1h) : undefined).toEqual({
      completionUsdPerMillion: 15,
      requestUsd: 0,
    });

    // Missing pricing object does not synthesize requestUsd: 0.
    const missingPricing = findOpenRouterModel(roundTripped, 'vendor/missing-pricing');
    expect(missingPricing?.requestUsd).toBeUndefined();
    expect(missingPricing ? resolveOpenRouterModelCeiling(missingPricing) : undefined).toEqual(
      {},
    );
  });

  test('handles partial overrides, explicit unknown override keys, UTC overrides, sibling preservation, and strict isFreeModel checks', async () => {
    const fetcher = async (): Promise<Response> =>
      response({
        data: [
          {
            id: 'vendor/partial-override',
            name: 'Partial Override',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              overrides: [{ min_prompt_tokens: 200_000, prompt: '0.000006' }],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/override-unknown-completion',
            name: 'Override Unknown Completion',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              overrides: [
                {
                  min_prompt_tokens: 200_000,
                  prompt: '0.000006',
                  completion: '-1',
                },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/override-unknown-cw-and-req',
            name: 'Override Unknown CW and Req',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000003',
              completion: '0.000015',
              overrides: [
                {
                  min_prompt_tokens: 200_000,
                  prompt: '0.000006',
                  input_cache_write: '-1',
                  request: null,
                },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/utc-peak',
            name: 'UTC Peak Schedule',
            context_length: 128_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.00000015',
              completion: '0.0000006',
              input_cache_read: '0.000000003',
              overrides: [
                {
                  utc_days: ['saturday', 'sunday'],
                  prompt: '0.00000015',
                  completion: '0.0000006',
                  input_cache_read: '0.000000003',
                },
                {
                  utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
                  utc_start: 100,
                  utc_end: 400,
                  prompt: '0.0000003',
                  completion: '0.0000012',
                  input_cache_read: '0.000000006',
                },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/mixed-token-and-utc',
            name: 'Token Plus UTC',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000002',
              completion: '0.000010',
              overrides: [
                { min_prompt_tokens: 128_000, prompt: '0.000004', completion: '0.000018' },
                { utc_start: 100, utc_end: 500, prompt: '0.000005', completion: '0.000014' },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/mixed-token-and-opaque',
            name: 'Token Plus Opaque',
            context_length: 200_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0.000002',
              completion: '0.000010',
              overrides: [
                { min_prompt_tokens: 128_000, prompt: '0.000004', completion: '0.000018' },
                { condition: 'custom-region', prompt: '0.000050' },
              ],
            },
            supported_parameters: ['tools'],
          },
          {
            id: 'vendor/free-with-utc-cache-fee',
            name: 'Free Base Paid UTC Cache',
            context_length: 64_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0',
              completion: '0',
              overrides: [
                {
                  utc_start: 0,
                  utc_end: 1200,
                  prompt: '0',
                  completion: '0',
                  input_cache_read: '0.000001',
                },
              ],
            },
            supported_parameters: [],
          },
          {
            id: 'vendor/free-with-unknown-req',
            name: 'Free Base Unknown Request',
            context_length: 64_000,
            architecture: { input_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0', request: '-1' },
            supported_parameters: [],
          },
          {
            id: 'vendor/genuinely-free-utc',
            name: 'Genuinely Free UTC',
            context_length: 64_000,
            architecture: { input_modalities: ['text'] },
            pricing: {
              prompt: '0',
              completion: '0',
              overrides: [{ utc_start: 0, utc_end: 2400, prompt: '0', completion: '0' }],
            },
            supported_parameters: [],
          },
        ],
      });

    const snapshot = await loadOpenRouterCatalogSnapshot({
      fetcher,
      now: () => new Date(observedAt),
    });

    const partial = findOpenRouterModel(snapshot, 'vendor/partial-override');
    expect(partial ? resolveOpenRouterModelCeiling(partial) : undefined).toEqual({
      promptUsdPerMillion: 6,
      completionUsdPerMillion: 15,
      requestUsd: 0,
    });

    const unknownComp = findOpenRouterModel(snapshot, 'vendor/override-unknown-completion');
    expect(unknownComp ? resolveOpenRouterModelCeiling(unknownComp) : undefined).toEqual({
      promptUsdPerMillion: 6,
      requestUsd: 0,
    });

    const unknownCwReq = findOpenRouterModel(snapshot, 'vendor/override-unknown-cw-and-req');
    expect(unknownCwReq ? resolveOpenRouterModelCeiling(unknownCwReq) : undefined).toEqual({
      completionUsdPerMillion: 15,
    });

    const utc = findOpenRouterModel(snapshot, 'vendor/utc-peak');
    expect(utc?.hasConditionalPricing).toBe(true);
    expect(utc ? resolveOpenRouterModelCeiling(utc) : undefined).toEqual({
      promptUsdPerMillion: 0.3,
      completionUsdPerMillion: 1.2,
      requestUsd: 0,
    });

    // Sibling token tier + UTC override preserves pricingTiers AND computes combined max ceiling.
    const mixedUtc = findOpenRouterModel(snapshot, 'vendor/mixed-token-and-utc');
    expect(mixedUtc?.pricingTiers).toHaveLength(1);
    expect(mixedUtc?.pricingTiers?.[0]?.minPromptTokens).toBe(128_000);
    expect(mixedUtc ? resolveOpenRouterModelCeiling(mixedUtc) : undefined).toEqual({
      promptUsdPerMillion: 5,
      completionUsdPerMillion: 18,
      requestUsd: 0,
    });

    // Sibling token tier + unrecognized override preserves pricingTiers while refusing ceiling.
    const mixedOpaque = findOpenRouterModel(snapshot, 'vendor/mixed-token-and-opaque');
    expect(mixedOpaque?.hasConditionalPricing).toBe(true);
    expect(mixedOpaque?.pricingTiers).toHaveLength(1);
    expect(mixedOpaque?.hasUnverifiedPricingOverrides).toBe(true);
    expect(mixedOpaque ? resolveOpenRouterModelCeiling(mixedOpaque) : undefined).toEqual({});

    // Free checks across UTC overrides and unknown request fees.
    expect(listOpenRouterModels(snapshot, { freeOnly: true }).map((m) => m.id)).toEqual([
      'vendor/genuinely-free-utc',
    ]);

    // Hand-constructed snapshot checks for paid tiers without hasConditionalPricing and paid cache/1h rates.
    const handSnapshot: OpenRouterCatalogSnapshot = {
      schemaVersion: 1,
      observedAt,
      models: [
        {
          id: 'free/paid-tier-no-flag',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          pricingTiers: [{ minPromptTokens: 100_000, promptUsdPerMillion: 1 }],
          supportedParameters: [],
        },
        {
          id: 'free/paid-tier-cache-read',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          hasConditionalPricing: true,
          pricingTiers: [{ minPromptTokens: 100_000, cacheReadUsdPerMillion: 0.1 }],
          supportedParameters: [],
        },
        {
          id: 'free/paid-tier-cache-1h',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          hasConditionalPricing: true,
          pricingTiers: [{ minPromptTokens: 100_000, cacheWrite1hUsdPerMillion: 0.5 }],
          supportedParameters: [],
        },
        {
          id: 'free/base-cache-1h',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          cacheWrite1hUsdPerMillion: 0.25,
          supportedParameters: [],
        },
        {
          id: 'free/unrepresented-conditional',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          hasConditionalPricing: true,
          supportedParameters: [],
        },
        {
          id: 'free/ok-with-zero-tier',
          inputModalities: ['text'],
          promptUsdPerMillion: 0,
          completionUsdPerMillion: 0,
          requestUsd: 0,
          hasConditionalPricing: true,
          pricingTiers: [
            {
              minPromptTokens: 100_000,
              promptUsdPerMillion: 0,
              completionUsdPerMillion: 0,
              cacheReadUsdPerMillion: 0,
              cacheWriteUsdPerMillion: 0,
              cacheWrite1hUsdPerMillion: 0,
              requestUsd: 0,
            },
          ],
          supportedParameters: [],
        },
      ],
    };
    expect(listOpenRouterModels(handSnapshot, { freeOnly: true }).map((m) => m.id)).toEqual([
      'free/ok-with-zero-tier',
    ]);
  });

  test('parses nullish /models rows, tilde router ids, positive exponent decimals, created <= 0, include_reasoning, and filter bounds', async () => {
    const fetcher = async (url: URL): Promise<Response> => {
      if (url.pathname.endsWith('/benchmarks')) return response({ data: [] });
      if (url.pathname.endsWith('/endpoints')) {
        return response({ data: { endpoints: [{ provider_name: 'RouterUp', status: 0 }] } });
      }
      return response({
        data: [
          {
            id: '~anthropic/claude-sonnet-latest',
            name: null,
            created: 0,
            context_length: null,
            top_provider: { context_length: 200_000 },
            architecture: null,
            pricing: null,
            supported_parameters: null,
          },
          {
            id: 'vendor/sparse-no-context',
            name: '   ',
            created: -10,
            context_length: null,
            architecture: { input_modalities: null },
            pricing: { prompt: '1e+1', completion: '2e-6' },
            supported_parameters: ['include_reasoning'],
          },
        ],
      });
    };

    const snapshot = await loadOpenRouterCatalogSnapshot({
      fetcher,
      endpointsFor: ['~anthropic/claude-sonnet-latest'],
      now: () => new Date(observedAt),
    });

    const router = findOpenRouterModel(snapshot, '~anthropic/claude-sonnet-latest');
    expect(router).toMatchObject({
      id: '~anthropic/claude-sonnet-latest',
      name: '~anthropic/claude-sonnet-latest',
      inputModalities: [],
      topProviderContextLength: 200_000,
      supportedParameters: [],
      endpoints: [{ provider: 'RouterUp', status: 0, supportedParameters: [] }],
    });
    expect(router?.contextLength).toBeUndefined();
    expect(router?.createdAt).toBeUndefined();
    expect(router?.requestUsd).toBeUndefined();

    const sparse = findOpenRouterModel(snapshot, 'vendor/sparse-no-context');
    expect(sparse?.name).toBe('vendor/sparse-no-context');
    expect(sparse?.createdAt).toBeUndefined();
    expect(sparse?.promptUsdPerMillion).toBe(10_000_000);
    expect(sparse?.completionUsdPerMillion).toBe(2);

    // openRouterModelCatalog also tolerates nullish rows cleanly.
    const modelCatalog = await openRouterModelCatalog({
      fetcher,
      now: () => new Date(observedAt),
    }).load();
    expect(modelCatalog.models.map((m) => m.id)).toEqual(['~anthropic/claude-sonnet-latest']);
    expect(modelCatalog.models[0]?.descriptor.contextWindow).toBe(200_000);

    // effectiveContextLength uses topProviderContextLength fallback and excludes unknown context.
    expect(
      listOpenRouterModels(snapshot, { minContextLength: 200_000 }).map((m) => m.id),
    ).toEqual(['~anthropic/claude-sonnet-latest']);
    expect(listOpenRouterModels(snapshot, { minContextLength: 0 }).map((m) => m.id)).toEqual([
      '~anthropic/claude-sonnet-latest',
    ]);

    // reasoning: true matches include_reasoning as well as reasoning.
    expect(listOpenRouterModels(snapshot, { reasoning: true }).map((m) => m.id)).toEqual([
      'vendor/sparse-no-context',
    ]);
    expect(listOpenRouterModels(snapshot, { reasoning: false }).map((m) => m.id)).toEqual([
      '~anthropic/claude-sonnet-latest',
    ]);

    // openRouterEndpointsUrl accepts ~author/slug and refuses malformed/traversal variants.
    expect(openRouterEndpointsUrl('~anthropic/claude-sonnet-latest').pathname).toBe(
      '/api/v1/models/~anthropic/claude-sonnet-latest/endpoints',
    );
    for (const badId of ['~~a/b', '~/b', '~../b', '~a/../b', '~a/b?x=1', 'a/~b']) {
      expect(() => openRouterEndpointsUrl(badId)).toThrow(TypeError);
    }

    // parseUnixSecondsIso rejects <= 0 and accepts positive timestamps.
    expect(parseUnixSecondsIso(0)).toBeUndefined();
    expect(parseUnixSecondsIso(-1)).toBeUndefined();
    expect(parseUnixSecondsIso(1)).toBe('1970-01-01T00:00:01.000Z');

    // DECIMAL regex accepts + exponent and refuses signed/malformed forms.
    expect(usd('1e+2')).toBe(100);
    expect(usdPerMillion('2e+1')).toBe(20_000_000);
    for (const badDecimal of ['-1e+2', '+1', '1e+', '1e-', '1e+-2']) {
      expect(usd(badDecimal)).toBeUndefined();
      expect(usdPerMillion(badDecimal)).toBeUndefined();
    }

    // Numeric filter threshold validation rejects NaN, negative, and non-finite inputs.
    for (const key of [
      'minContextLength',
      'maxPromptUsdPerMillion',
      'maxCompletionUsdPerMillion',
    ] as const) {
      for (const bad of [
        Number.NaN,
        -1,
        -0.01,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(() => listOpenRouterModels(snapshot, { [key]: bad })).toThrow(RangeError);
      }
    }
  });

  test('synchronizes evaluateOpenRouterModelAdmission with aliasTarget, effectiveContextLength, and pricing ceilings', () => {
    const snapshot: OpenRouterCatalogSnapshot = {
      schemaVersion: 1,
      observedAt,
      models: [
        {
          id: 'vendor/aliased',
          aliasTarget: { id: 'vendor/aliased-20260501', name: 'Dated' },
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 1,
          completionUsdPerMillion: 2,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/top-capped',
          inputModalities: ['text'],
          contextLength: 1_000_000,
          topProviderContextLength: 128_000,
          promptUsdPerMillion: 1,
          completionUsdPerMillion: 2,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/top-only-context',
          inputModalities: ['text'],
          topProviderContextLength: 200_000,
          promptUsdPerMillion: 1,
          completionUsdPerMillion: 2,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/no-context',
          inputModalities: ['text'],
          promptUsdPerMillion: 1,
          completionUsdPerMillion: 2,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/tiered-over-budget',
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 10,
          pricingTiers: [{ minPromptTokens: 200_000, promptUsdPerMillion: 6 }],
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/cache1h-over-budget',
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 3,
          cacheWrite1hUsdPerMillion: 6,
          completionUsdPerMillion: 10,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/unverified-conditional',
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 10,
          hasConditionalPricing: true,
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/unknown-cw-base',
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 10,
          unknownPricingFields: ['cacheWrite'],
          supportedParameters: ['tools'],
        },
        {
          id: 'vendor/tiered-within-budget',
          inputModalities: ['text'],
          contextLength: 200_000,
          promptUsdPerMillion: 3,
          completionUsdPerMillion: 10,
          hasConditionalPricing: true,
          pricingTiers: [{ minPromptTokens: 200_000, promptUsdPerMillion: 4.5 }],
          supportedParameters: ['tools'],
        },
      ],
    };

    const decide = (modelId: string, policy: Record<string, unknown> = {}) =>
      OpenRouterModelAdmissionSchema.parse(
        evaluateOpenRouterModelAdmission({
          snapshot,
          modelId,
          policy: { maxSnapshotAgeMs: 60_000, ...policy },
          now: () => new Date(Date.parse(observedAt) + 1_000),
        }),
      );

    expect(decide('vendor/aliased')).toMatchObject({
      state: 'rejected',
      reason: 'floating-alias',
    });

    // effectiveContextLength honors topProviderContextLength cap and fallback, and emits context-unknown when absent.
    expect(decide('vendor/top-capped', { minContextLength: 200_000 })).toMatchObject({
      state: 'rejected',
      reason: 'context-too-small',
    });
    expect(decide('vendor/top-only-context', { minContextLength: 128_000 })).toEqual({
      state: 'admitted',
    });
    expect(decide('vendor/no-context', { minContextLength: 1_000 })).toMatchObject({
      state: 'unverified',
      reason: 'context-unknown',
    });
    expect(decide('vendor/no-context')).toEqual({ state: 'admitted' });

    // Price checks enforce worst-case ceilings (tiers, 1h cache writes, unknown conditional rules).
    expect(decide('vendor/tiered-over-budget', { maxPromptUsdPerMillion: 5 })).toMatchObject({
      state: 'rejected',
      reason: 'over-price',
    });
    expect(decide('vendor/cache1h-over-budget', { maxPromptUsdPerMillion: 5 })).toMatchObject({
      state: 'rejected',
      reason: 'over-price',
    });
    expect(
      decide('vendor/unverified-conditional', { maxPromptUsdPerMillion: 5 }),
    ).toMatchObject({
      state: 'unverified',
      reason: 'price-unknown',
    });
    // Base price already above limit still rejects even when overrides are unverified.
    expect(
      decide('vendor/unverified-conditional', { maxPromptUsdPerMillion: 2 }),
    ).toMatchObject({
      state: 'rejected',
      reason: 'over-price',
    });
    expect(decide('vendor/unknown-cw-base', { maxPromptUsdPerMillion: 5 })).toMatchObject({
      state: 'unverified',
      reason: 'price-unknown',
    });
    expect(decide('vendor/tiered-within-budget', { maxPromptUsdPerMillion: 5 })).toEqual({
      state: 'admitted',
    });
  });

  test('narrowing OpenRouterCatalogCacheReadResult, eager apiKey/endpointsFor validation, and serialized generation-ordered store.write', async () => {
    let fetchCount = 0;
    let storeReads = 0;
    const noopFetcher = async () => {
      fetchCount += 1;
      return response(models());
    };
    const spyStore: OpenRouterCatalogStore = {
      read: () => {
        storeReads += 1;
        return null;
      },
      write: () => undefined,
    };

    // Eager validation in createOpenRouterCatalogCache before any fetch or store read.
    for (const badKey of ['', '   ']) {
      expect(() =>
        createOpenRouterCatalogCache({
          apiKey: badKey,
          fetcher: noopFetcher,
          store: spyStore,
        }),
      ).toThrow(TypeError);
      expect(() => openRouterModelCatalog({ apiKey: badKey, fetcher: noopFetcher })).toThrow(
        TypeError,
      );
    }
    for (const badEndpoints of [['bad/../id'], ['nope'], ['a/b?q=1']]) {
      expect(() =>
        createOpenRouterCatalogCache({
          endpointsFor: badEndpoints,
          fetcher: noopFetcher,
          store: spyStore,
        }),
      ).toThrow(TypeError);
      await expect(
        loadOpenRouterCatalogSnapshot({ endpointsFor: badEndpoints, fetcher: noopFetcher }),
      ).rejects.toThrow(TypeError);
    }
    const filterCache = createOpenRouterCatalogCache({
      fetcher: noopFetcher,
      store: spyStore,
    });
    await expect(filterCache.listModels({ minContextLength: -1 })).rejects.toThrow(RangeError);
    await expect(
      filterCache.listModels({ maxPromptUsdPerMillion: Number.NaN }),
    ).rejects.toThrow(RangeError);
    expect(fetchCount).toBe(0);
    expect(storeReads).toBe(0);

    // Discriminated union narrowing check (compile-time and runtime).
    const checkNarrowing = (res: OpenRouterCatalogCacheReadResult): string | null => {
      if (res.status === 'unavailable') {
        const empty: readonly [] = res.models;
        const noSnap: null = res.snapshot;
        expect(empty).toEqual([]);
        expect(noSnap).toBeNull();
        return res.observedAt;
      }
      const snap: OpenRouterCatalogSnapshot = res.snapshot;
      const obs: string = res.observedAt;
      expect(snap.observedAt).toBe(obs);
      return obs;
    };

    const failCache = createOpenRouterCatalogCache({
      fetcher: async () => response({}, 503),
    });
    expect(checkNarrowing(await failCache.read())).toBeNull();

    // Race 1: Delayed late-resolving fetch v1 after sole-caller abort never overwrites v2 in memory or store.
    let releaseV1Fetch: (() => void) | undefined;
    let v1FetchStarted: (() => void) | undefined;
    const waitV1Start = new Promise<void>((resolve) => {
      v1FetchStarted = resolve;
    });
    let callIdx = 0;
    const persistedIds: string[] = [];
    const raceFetcher = (): Promise<Response> => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Promise<Response>((resolve) => {
          releaseV1Fetch = () =>
            resolve(
              response({
                data: [
                  {
                    id: 'vendor/v1',
                    name: 'V1',
                    context_length: 8_000,
                    architecture: { input_modalities: ['text'] },
                    pricing: {},
                  },
                ],
              }),
            );
          v1FetchStarted?.();
        });
      }
      return Promise.resolve(
        response({
          data: [
            {
              id: 'vendor/v2',
              name: 'V2',
              context_length: 16_000,
              architecture: { input_modalities: ['text'] },
              pricing: {},
            },
          ],
        }),
      );
    };

    const raceCache1 = createOpenRouterCatalogCache({
      fetcher: raceFetcher,
      store: {
        read: () => null,
        write: (snap) => {
          persistedIds.push(snap.models[0]?.id ?? 'none');
        },
      },
      now: () => new Date(observedAt),
    });
    const abortV1 = new AbortController();
    const readV1 = raceCache1.read({ signal: abortV1.signal });
    await waitV1Start;
    abortV1.abort(new Error('cancel-v1'));
    await expect(readV1).rejects.toThrow('cancel-v1');

    const resV2 = await raceCache1.read();
    expect(checkNarrowing(resV2)).toBe(observedAt);
    expect(resV2.models[0]?.id).toBe('vendor/v2');

    // Now let v1 resolve late after abort & v2 commit.
    releaseV1Fetch?.();
    await Bun.sleep(10);
    expect((await raceCache1.read()).models[0]?.id).toBe('vendor/v2');
    expect(persistedIds).toEqual(['vendor/v2']);

    // Race 2: Slow in-flight store.write(v1) is serialized strictly before store.write(v2) so disk always ends with v2.
    let releaseV1Write: (() => void) | undefined;
    let markV1WriteStarted: (() => void) | undefined;
    const waitV1Write = new Promise<void>((resolve) => {
      markV1WriteStarted = resolve;
    });
    let seq = 0;
    const writeLog: string[] = [];
    const persistedSnapshots: OpenRouterCatalogSnapshot[] = [];
    const raceCache2 = createOpenRouterCatalogCache({
      fetcher: async () => {
        seq += 1;
        const label = `vendor/gen-${seq}`;
        return response({
          data: [
            {
              id: label,
              name: label,
              context_length: 8_000,
              architecture: { input_modalities: ['text'] },
              pricing: {},
            },
          ],
        });
      },
      store: {
        read: () => null,
        write: async (snap) => {
          const id = snap.models[0]?.id ?? 'none';
          writeLog.push(`start:${id}`);
          if (id === 'vendor/gen-1') {
            await new Promise<void>((resolve) => {
              releaseV1Write = resolve;
              markV1WriteStarted?.();
            });
          }
          persistedSnapshots.push(snap);
          writeLog.push(`end:${id}`);
        },
      },
      now: () => new Date(observedAt),
    });

    const abortDuringWrite = new AbortController();
    const pendingGen1 = raceCache2.read({ signal: abortDuringWrite.signal });
    await waitV1Write;
    abortDuringWrite.abort(new Error('abort-during-write'));
    await expect(pendingGen1).rejects.toThrow('abort-during-write');

    const pendingGen2 = raceCache2.refresh();
    await Bun.sleep(10);
    // Gen 2 write must wait for Gen 1 write to finish (serialized writeChain).
    expect(writeLog).toEqual(['start:vendor/gen-1']);
    releaseV1Write?.();
    const gen2Result = await pendingGen2;
    expect(gen2Result.status).toBe('current');
    expect(writeLog).toEqual([
      'start:vendor/gen-1',
      'end:vendor/gen-1',
      'start:vendor/gen-2',
      'end:vendor/gen-2',
    ]);
    expect(persistedSnapshots.at(-1)?.models[0]?.id).toBe('vendor/gen-2');
  });
});
