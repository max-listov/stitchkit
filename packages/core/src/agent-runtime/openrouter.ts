import {
  createOpenRouter,
  type OpenRouterProviderSettings,
} from '@openrouter/ai-sdk-provider';
import type { LanguageModelUsage } from 'ai';
import { z } from 'zod';
import { assertTimerMs } from '../internal/deadline';
import { isRecord } from '../internal/typed';
import { currentModelInvocationAttempt } from './invocation-attempt';
import {
  type AgentLanguageModelProvider,
  type AgentModelCapability,
  type AgentModelCatalog,
  AgentModelCatalogSchema,
  type AgentModelMetric,
} from './models';
import {
  type OpenRouterCatalogFetch,
  type OpenRouterModelSchema,
  OpenRouterModelsResponseSchema,
  openRouterJson,
  usd,
  withOpenRouterTimeout,
} from './openrouter-models';
import {
  buildOpenRouterChatSettings,
  type OpenRouterRequestPolicy,
  rewriteOpenRouterBodyFetch,
  withOpenRouterLooseTools,
} from './openrouter-options';
import { openRouterSessionKey } from './openrouter-route';
import type { AgentUsage } from './schemas';

export type { OpenRouterProviderSettings } from '@openrouter/ai-sdk-provider';
export type { OpenRouterCatalogFetch } from './openrouter-models';

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

export interface OpenRouterModelCatalogOptions {
  apiKey: string;
  fetcher?: OpenRouterCatalogFetch;
  timeoutMs?: number;
  now?: () => Date;
}

function catalogJson(
  fetcher: OpenRouterCatalogFetch,
  url: URL,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown> {
  return openRouterJson({ fetcher, url, apiKey, signal });
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
  assertTimerMs('timeoutMs', timeoutMs);
  return {
    async load(input = {}) {
      const modelsUrl = new URL('https://openrouter.ai/api/v1/models');
      modelsUrl.searchParams.set('supported_parameters', 'tools');
      modelsUrl.searchParams.set('output_modalities', 'text');
      modelsUrl.searchParams.set('sort', 'most-popular');
      const artificialUrl = new URL('https://openrouter.ai/api/v1/benchmarks');
      artificialUrl.searchParams.set('source', 'artificial-analysis');
      const designUrl = new URL('https://openrouter.ai/api/v1/benchmarks');
      designUrl.searchParams.set('source', 'design-arena');
      designUrl.searchParams.set('arena', 'agents');
      const [modelsRaw, artificialResult, designResult] = await withOpenRouterTimeout(
        timeoutMs,
        input.signal,
        (signal) =>
          Promise.all([
            catalogJson(fetcher, modelsUrl, options.apiKey, signal),
            catalogJson(fetcher, artificialUrl, options.apiKey, signal).then(
              (value) =>
                ({ outcome: 'ok', value }) satisfies { outcome: 'ok'; value: unknown },
              (error: unknown) =>
                ({ outcome: 'error', error }) satisfies { outcome: 'error'; error: unknown },
            ),
            catalogJson(fetcher, designUrl, options.apiKey, signal).then(
              (value) =>
                ({ outcome: 'ok', value }) satisfies { outcome: 'ok'; value: unknown },
              (error: unknown) =>
                ({ outcome: 'error', error }) satisfies { outcome: 'error'; error: unknown },
            ),
          ]),
      );
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
              // Only real prices: OpenRouter's "-1" (unknown) is left out, not passed on.
              ...((usd(model.pricing.prompt) !== undefined ||
                usd(model.pricing.completion) !== undefined) && {
                price: {
                  currency: 'USD',
                  ...(usd(model.pricing.prompt) !== undefined && {
                    inputPerToken: model.pricing.prompt,
                  }),
                  ...(usd(model.pricing.completion) !== undefined && {
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

/**
 * How every request of an `openRouterProvider` is shaped; see {@link OpenRouterRequestPolicy}.
 * The provider is the one place a policy is applied: `looseTools` and the session can only be
 * delivered on the wire, which the provider owns.
 */
export interface OpenRouterProviderAccess {
  /** The policy of a model `resolvePolicy` says nothing about. */
  defaultPolicy?: OpenRouterRequestPolicy;
  /** The policy of one model, from the application's own model table. */
  resolvePolicy?(modelId: string): OpenRouterRequestPolicy | undefined;
  /**
   * Keep each conversation on one upstream: every request made inside an agent
   * runtime model attempt carries `session_id` = that attempt's conversation
   * (hashed when longer than 256 characters), unless its policy pins
   * `provider.order`. Requires the runtime to be configured with `invocations`
   * (which tracks the active attempt).
   */
  sessionPerConversation?: boolean;
}

/** Request keys the policy owns; a provider-level `extraBody` would overwrite them silently. */
const POLICY_KEYS = ['provider', 'reasoning', 'session_id', 'usage'] as const;

/** Isolated OpenRouter adapter; credentials stay inside the provider instance. */
export function openRouterProvider(
  settings: OpenRouterProviderSettings,
  access: OpenRouterProviderAccess = {},
): AgentLanguageModelProvider {
  const clash = POLICY_KEYS.filter((key) => settings.extraBody?.[key] !== undefined);
  if (clash.length > 0)
    throw new TypeError(
      `openRouterProvider: extraBody sets ${clash.join(', ')}, which the request policy owns; put it in the policy`,
    );
  const policyOf = (modelId: string): OpenRouterRequestPolicy =>
    access.resolvePolicy?.(modelId) ?? access.defaultPolicy ?? {};
  // On the wire, per request: the model's own policy decides loose tools, and the
  // current conversation (when asked) becomes the session.
  const rewrite = (body: unknown): unknown => {
    if (!isRecord(body)) return body;
    const policy = typeof body.model === 'string' ? policyOf(body.model) : {};
    const loosened = policy.looseTools ? withOpenRouterLooseTools(body) : body;
    const conversation = currentModelInvocationAttempt()?.conversationId;
    const pinned = isRecord(body.provider) && Array.isArray(body.provider.order);
    return access.sessionPerConversation &&
      conversation !== undefined &&
      isRecord(loosened) &&
      loosened.session_id === undefined &&
      !pinned
      ? { ...loosened, session_id: openRouterSessionKey(conversation) }
      : loosened;
  };
  const needsWire =
    access.sessionPerConversation ||
    access.resolvePolicy !== undefined ||
    access.defaultPolicy?.looseTools;
  const provider = createOpenRouter({
    ...settings,
    ...(needsWire && { fetch: rewriteOpenRouterBodyFetch(settings.fetch ?? fetch, rewrite) }),
  });
  return {
    create: (modelId) =>
      provider.chat(modelId, buildOpenRouterChatSettings(policyOf(modelId))),
    normalizeUsage: ({ usage, providerMetadata }) =>
      normalizeOpenRouterUsage(usage, providerMetadata),
    resolveResponseProvider: ({ providerMetadata }) => readUpstreamProvider(providerMetadata),
  };
}

/**
 * Which upstream OpenRouter routed this step to.
 *
 * `@openrouter/ai-sdk-provider` puts it in `providerMetadata.openrouter.provider`.
 * A missing or empty value is absent, never an empty string: a response
 * identity that carries `provider: ''` would say the gateway answered the
 * question and named nobody.
 */
function readUpstreamProvider(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const openrouter = metadata.openrouter;
  if (!isRecord(openrouter)) return undefined;
  const name = openrouter.provider;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Same rule as `normalizeSdkUsage`: a non-integer is not a token count. */
function reported(value: unknown): AgentUsage['inputTokens'] {
  return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, provenance: 'provider-reported' };
}

function reportedUsd(value: number | undefined): AgentUsage['cost'] {
  return value === undefined || !Number.isFinite(value) || value < 0
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
 * Raw step usage is authoritative: the SDK adapter substitutes zero for some
 * absent counters. Normalized counters (including aggregate usage without raw)
 * therefore cannot establish provider-reported provenance. Use each SDK step.
 */
export function normalizeOpenRouterUsage(
  usage: LanguageModelUsage,
  providerMetadata: unknown,
): AgentUsage {
  const raw = isRecord(usage.raw) ? usage.raw : {};
  const prompt = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
  const completion = isRecord(raw.completion_tokens_details)
    ? raw.completion_tokens_details
    : {};
  return {
    inputTokens: reported(raw.prompt_tokens),
    outputTokens: reported(raw.completion_tokens),
    reasoningTokens: reported(completion.reasoning_tokens),
    cacheReadTokens: reported(prompt.cached_tokens),
    cacheWriteTokens: reported(prompt.cache_write_tokens),
    cost: reportedUsd(readCost(providerMetadata)),
  };
}
