import {
  createOpenRouter,
  type OpenRouterProviderSettings,
} from '@openrouter/ai-sdk-provider';
import type { LanguageModelUsage } from 'ai';
import { z } from 'zod';
import {
  type AgentLanguageModelProvider,
  type AgentModelCapability,
  type AgentModelCatalog,
  AgentModelCatalogSchema,
  type AgentModelMetric,
} from './agent-runtime/models';
import type { AgentUsage } from './agent-runtime/schemas';
import { isRecord } from './internal/typed';

export type { OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';

const OpenRouterModelSchema = z
  .object({
    id: z.string().min(1),
    canonical_slug: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    context_length: z.int().nonnegative(),
    architecture: z.object({ input_modalities: z.array(z.string()).default([]) }).loose(),
    pricing: z
      .object({ prompt: z.string().optional(), completion: z.string().optional() })
      .loose(),
    supported_parameters: z.array(z.string()).default([]),
  })
  .loose();

const OpenRouterModelsResponseSchema = z.object({ data: z.array(OpenRouterModelSchema) });
const OpenRouterBenchmarkMetaSchema = z
  .object({ as_of: z.iso.datetime({ offset: true }) })
  .loose();
const OpenRouterArtificialAnalysisRowSchema = z
  .object({
    source: z.literal('artificial-analysis'),
    model_permaslug: z.string().min(1),
    intelligence_index: z.number().nullish(),
    coding_index: z.number().nullish(),
    agentic_index: z.number().nullish(),
  })
  .loose();
const OpenRouterDesignArenaRowSchema = z
  .object({
    source: z.literal('design-arena'),
    model_permaslug: z.string().min(1),
    arena: z.string().min(1),
    category: z.string().min(1).optional(),
    elo: z.number().nullish(),
    win_rate: z.number().nullish(),
    avg_generation_time_ms: z.number().nullish(),
  })
  .loose();
const OpenRouterArtificialAnalysisResponseSchema = z.object({
  data: z.array(OpenRouterArtificialAnalysisRowSchema),
  meta: OpenRouterBenchmarkMetaSchema,
});
const OpenRouterDesignArenaResponseSchema = z.object({
  data: z.array(OpenRouterDesignArenaRowSchema),
  meta: OpenRouterBenchmarkMetaSchema,
});

export type OpenRouterCatalogFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export interface OpenRouterModelCatalogOptions {
  apiKey: string;
  fetcher?: OpenRouterCatalogFetch;
  timeoutMs?: number;
  now?: () => Date;
}

function catalogSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function catalogJson(
  fetcher: OpenRouterCatalogFetch,
  url: URL,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok)
    throw new Error(`OpenRouter catalog request failed with HTTP ${response.status}`);
  return response.json();
}

function capabilities(model: z.infer<typeof OpenRouterModelSchema>): AgentModelCapability[] {
  const values: AgentModelCapability[] = ['tools'];
  if (model.architecture.input_modalities.includes('image')) values.push('vision');
  if (model.architecture.input_modalities.includes('file')) values.push('files');
  if (model.supported_parameters.includes('reasoning')) values.push('reasoning');
  return values;
}

function artificialMetrics(
  row: z.infer<typeof OpenRouterArtificialAnalysisRowSchema>,
  observedAt: string,
): AgentModelMetric[] {
  return [
    ['intelligence', row.intelligence_index],
    ['coding', row.coding_index],
    ['agentic', row.agentic_index],
  ].flatMap(([metric, value]) =>
    typeof metric === 'string' && typeof value === 'number'
      ? [
          {
            metric,
            value,
            unit: 'index',
            source: row.source,
            observedAt,
          } satisfies AgentModelMetric,
        ]
      : [],
  );
}

function designMetrics(
  row: z.infer<typeof OpenRouterDesignArenaRowSchema>,
  observedAt: string,
): AgentModelMetric[] {
  const suffix = `${row.arena}${row.category ? `:${row.category}` : ''}`;
  const metrics: AgentModelMetric[] = [];
  if (typeof row.elo === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:elo`,
      value: row.elo,
      unit: 'elo',
      source: row.source,
      observedAt,
    });
  }
  if (typeof row.win_rate === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:win-rate`,
      value: row.win_rate,
      unit: 'percent',
      source: row.source,
      observedAt,
    });
  }
  if (typeof row.avg_generation_time_ms === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:generation-time`,
      value: row.avg_generation_time_ms,
      unit: 'milliseconds',
      source: row.source,
      observedAt,
    });
  }
  return metrics;
}

/** Complete tool-capable catalog plus independently sourced popularity and benchmark facts. */
export function openRouterModelCatalog(options: OpenRouterModelCatalogOptions): {
  load(input?: { signal?: AbortSignal }): Promise<AgentModelCatalog>;
} {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async load(input = {}) {
      const signal = catalogSignal(timeoutMs, input.signal);
      const modelsUrl = new URL('https://openrouter.ai/api/v1/models');
      modelsUrl.searchParams.set('supported_parameters', 'tools');
      modelsUrl.searchParams.set('output_modalities', 'text');
      modelsUrl.searchParams.set('sort', 'most-popular');
      const artificialUrl = new URL('https://openrouter.ai/api/v1/benchmarks');
      artificialUrl.searchParams.set('source', 'artificial-analysis');
      const designUrl = new URL('https://openrouter.ai/api/v1/benchmarks');
      designUrl.searchParams.set('source', 'design-arena');
      designUrl.searchParams.set('arena', 'agents');
      const [modelsRaw, artificialResult, designResult] = await Promise.all([
        catalogJson(fetcher, modelsUrl, options.apiKey, signal),
        catalogJson(fetcher, artificialUrl, options.apiKey, signal).then(
          (value) => ({ outcome: 'ok', value }) satisfies { outcome: 'ok'; value: unknown },
          (error: unknown) =>
            ({ outcome: 'error', error }) satisfies { outcome: 'error'; error: unknown },
        ),
        catalogJson(fetcher, designUrl, options.apiKey, signal).then(
          (value) => ({ outcome: 'ok', value }) satisfies { outcome: 'ok'; value: unknown },
          (error: unknown) =>
            ({ outcome: 'error', error }) satisfies { outcome: 'error'; error: unknown },
        ),
      ]);
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      const models = OpenRouterModelsResponseSchema.parse(modelsRaw).data;
      const metrics = new Map<string, AgentModelMetric[]>();
      const diagnostics: string[] = [];
      if (artificialResult.outcome === 'ok') {
        const parsed = OpenRouterArtificialAnalysisResponseSchema.safeParse(
          artificialResult.value,
        );
        if (parsed.success) {
          for (const row of parsed.data.data) {
            metrics.set(row.model_permaslug, artificialMetrics(row, parsed.data.meta.as_of));
          }
        } else {
          diagnostics.push('Artificial Analysis benchmark data is malformed');
        }
      } else diagnostics.push('Artificial Analysis benchmark data is unavailable');
      if (designResult.outcome === 'ok') {
        const parsed = OpenRouterDesignArenaResponseSchema.safeParse(designResult.value);
        if (parsed.success) {
          for (const row of parsed.data.data) {
            metrics.set(row.model_permaslug, [
              ...(metrics.get(row.model_permaslug) ?? []),
              ...designMetrics(row, parsed.data.meta.as_of),
            ]);
          }
        } else {
          diagnostics.push('Design Arena benchmark data is malformed');
        }
      } else diagnostics.push('Design Arena benchmark data is unavailable');
      const seen = new Set<string>();
      return AgentModelCatalogSchema.parse({
        schemaVersion: 1,
        source: 'openrouter',
        observedAt,
        completeness: diagnostics.length === 0 ? 'complete' : 'partial',
        diagnostics,
        models: models.flatMap((model, index) => {
          if (model.context_length === 0) return [];
          if (seen.has(model.id)) return [];
          seen.add(model.id);
          const canonical = model.canonical_slug ?? model.id;
          return [
            {
              id: model.id,
              name: model.name,
              descriptor: {
                provider: 'openrouter',
                modelId: model.id,
                contextWindow: model.context_length,
                capabilities: capabilities(model),
                observedAt,
                source: 'openrouter-models',
                availability: 'available',
              },
              ...(model.description && { description: model.description }),
              ...((model.pricing.prompt || model.pricing.completion) && {
                price: {
                  currency: 'USD',
                  ...(model.pricing.prompt && { inputPerToken: model.pricing.prompt }),
                  ...(model.pricing.completion && {
                    outputPerToken: model.pricing.completion,
                  }),
                },
              }),
              popularity: {
                rank: index + 1,
                window: 'week',
                source: 'openrouter-token-usage',
                observedAt,
              },
              metrics: metrics.get(canonical) ?? metrics.get(model.id) ?? [],
            },
          ];
        }),
      });
    },
  };
}

/** Isolated OpenRouter adapter; credentials stay inside the provider instance. */
export function openRouterProvider(
  settings: OpenRouterProviderSettings,
): AgentLanguageModelProvider {
  const provider = createOpenRouter(settings);
  return {
    create: (modelId) => provider.chat(modelId),
    normalizeUsage: ({ usage, providerMetadata }) =>
      normalizeOpenRouterUsage(usage, providerMetadata),
  };
}

/** Same rule as `normalizeSdkUsage`: a non-integer is not a token count. */
function reported(value: number | undefined): AgentUsage['inputTokens'] {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, provenance: 'provider-reported' };
}

function reportedUsd(value: number | undefined): AgentUsage['cost'] {
  return value === undefined
    ? { provenance: 'unavailable' }
    : { value, currency: 'USD', provenance: 'provider-reported' };
}

function readCost(metadata: unknown): number | undefined {
  if (!isRecord(metadata)) return undefined;
  const openrouter = metadata.openrouter;
  if (!isRecord(openrouter)) return undefined;
  if (typeof openrouter.cost === 'number' && openrouter.cost >= 0) return openrouter.cost;
  const usage = openrouter.usage;
  return isRecord(usage) && typeof usage.cost === 'number' && usage.cost >= 0
    ? usage.cost
    : undefined;
}

/**
 * Read OpenRouter's token counts and cost out of one SDK step, with provenance.
 *
 * Exported, and that is the point of it existing here at all. The same function
 * has always run inside `openRouterProvider`, which means it was reachable only
 * by building the whole agent runtime — durable store, execution protocol and
 * recovery included. An application that calls `generateText` directly, and only
 * wants an honest number for its own ledger, could not reach it and derived it
 * again; two of them did, and more than half of the two files agree line for
 * line.
 *
 * What is easy to get wrong when deriving it again is not the arithmetic but the
 * provenance: a number the provider reported, a number nobody reported and a
 * zero are three different facts, and a value invented for a missing field is
 * the one that reads as true and is not.
 */
export function normalizeOpenRouterUsage(
  usage: LanguageModelUsage,
  providerMetadata: unknown,
): AgentUsage {
  return {
    inputTokens: reported(usage.inputTokens),
    outputTokens: reported(usage.outputTokens),
    reasoningTokens: reported(usage.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(usage.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(usage.inputTokenDetails.cacheWriteTokens),
    cost: reportedUsd(readCost(providerMetadata)),
  };
}
