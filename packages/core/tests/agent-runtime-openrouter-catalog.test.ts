import { describe, expect, test } from 'bun:test';
import { searchAgentModelCatalog } from '../src/agent-runtime/models';
import { openRouterModelCatalog } from '../src/agent-runtime-openrouter';

const observedAt = '2026-08-30T12:00:00.000Z';

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
      'OpenRouter catalog request failed with HTTP 503',
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
});
