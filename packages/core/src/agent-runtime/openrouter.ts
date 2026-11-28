import { assertTimerMs } from '../internal/deadline';
import { isRecord } from '../internal/typed';
import { type AgentModelCatalog, AgentModelCatalogSchema } from './models';
import type {
  AgentModelDriver,
  AgentModelDriverFactory,
  AgentModelRequest,
} from './models-driver';
import {
  collectOpenRouterBenchmarks,
  type OpenRouterBenchmarkFetchOutcome,
  openRouterCapabilities,
} from './openrouter-benchmarks';
import {
  assertValidStaticOpenRouterApiKey,
  nonEmptyTrimmed,
  type OpenRouterCatalogFetch,
  OpenRouterModelsResponseSchema,
  openRouterJson,
  usd,
  withOpenRouterTimeout,
} from './openrouter-models';
import {
  mergeOpenRouterStepPolicy,
  OPENROUTER_POLICY_KEYS,
  type OpenRouterRequestPolicy,
  type OpenRouterWirePolicy,
  resolveOpenRouterWirePolicy,
} from './openrouter-options';
import { normalizeOpenRouterUsageDetails, parseOpenRouterError } from './openrouter-response';
import { openRouterSessionKey } from './openrouter-route';
import { openRouterAllowsInlineCacheControl } from './provider-cache';
import {
  assertNoExtraBodyClash,
  joinProviderUrl,
  postProviderStream,
  resolveProviderApiKey,
} from './provider-http';
import { buildOpenAiChatRequestBody } from './provider-openai-chat';
import {
  decodeOpenAiChatJsonResponse,
  decodeOpenAiChatSseStream,
} from './provider-openai-chat-sse';

export type { OpenRouterCatalogFetch } from './openrouter-models';

const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const EMPTY_WIRE_POLICY: OpenRouterWirePolicy = { looseTools: false };

export interface OpenRouterModelCatalogOptions {
  apiKey?: string | (() => string | Promise<string>);
  fetcher?: OpenRouterCatalogFetch;
  timeoutMs?: number;
  now?: () => Date;
}

function catalogJson(
  fetcher: OpenRouterCatalogFetch,
  url: URL,
  apiKey: OpenRouterModelCatalogOptions['apiKey'],
  signal: AbortSignal,
): Promise<unknown> {
  return openRouterJson({
    fetcher,
    url,
    ...(apiKey !== undefined && { apiKey }),
    signal,
  });
}

function benchmarkOutcome(
  fetcher: OpenRouterCatalogFetch,
  url: URL,
  apiKey: OpenRouterModelCatalogOptions['apiKey'],
  signal: AbortSignal,
): Promise<OpenRouterBenchmarkFetchOutcome> {
  return catalogJson(fetcher, url, apiKey, signal).then(
    (value): OpenRouterBenchmarkFetchOutcome => ({ outcome: 'ok', value }),
    (error: unknown): OpenRouterBenchmarkFetchOutcome => ({ outcome: 'error', error }),
  );
}

/** Complete tool-capable catalog plus independently sourced popularity and benchmark facts. */
export function openRouterModelCatalog(options: OpenRouterModelCatalogOptions = {}): {
  load(input?: { signal?: AbortSignal }): Promise<AgentModelCatalog>;
} {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertTimerMs('timeoutMs', timeoutMs);
  assertValidStaticOpenRouterApiKey(options.apiKey);
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
            benchmarkOutcome(fetcher, artificialUrl, options.apiKey, signal),
            benchmarkOutcome(fetcher, designUrl, options.apiKey, signal),
          ]),
      );
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      const models = OpenRouterModelsResponseSchema.parse(modelsRaw).data;
      const { metrics, diagnostics } = collectOpenRouterBenchmarks(
        artificialResult,
        designResult,
      );
      return AgentModelCatalogSchema.parse({
        schemaVersion: 1,
        source: 'openrouter',
        observedAt,
        completeness: diagnostics.length === 0 ? 'complete' : 'partial',
        diagnostics,
        models: models.flatMap((model, index) => {
          const contextWindow =
            model.context_length != null && model.context_length > 0
              ? model.context_length
              : model.top_provider?.context_length != null &&
                  model.top_provider.context_length > 0
                ? model.top_provider.context_length
                : undefined;
          if (contextWindow === undefined) return [];
          const canonical = model.canonical_slug ?? model.id;
          const name = nonEmptyTrimmed(model.name) ?? model.id;
          const promptPrice =
            typeof model.pricing?.prompt === 'string' &&
            usd(model.pricing.prompt) !== undefined
              ? model.pricing.prompt
              : undefined;
          const completionPrice =
            typeof model.pricing?.completion === 'string' &&
            usd(model.pricing.completion) !== undefined
              ? model.pricing.completion
              : undefined;
          return [
            {
              id: model.id,
              name,
              descriptor: {
                provider: 'openrouter',
                modelId: model.id,
                contextWindow,
                capabilities: openRouterCapabilities(model),
                observedAt,
                source: 'openrouter-models',
                availability: 'available',
              },
              ...(model.description && { description: model.description }),
              ...((promptPrice !== undefined || completionPrice !== undefined) && {
                price: {
                  currency: 'USD',
                  ...(promptPrice !== undefined && { inputPerToken: promptPrice }),
                  ...(completionPrice !== undefined && { outputPerToken: completionPrice }),
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

/** Configuration for the native OpenRouter model driver factory. → ADR 0336. */
export interface OpenRouterProviderSettings {
  readonly apiKey: string | (() => string | Promise<string>);
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly appName?: string;
  readonly appUrl?: string;
  readonly providerApiKeys?: Readonly<Record<string, string>>;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/**
 * How every request of an `openRouterProvider` is shaped; see {@link OpenRouterRequestPolicy}.
 * Applied directly when constructing the OpenRouter wire payload.
 */
export interface OpenRouterProviderAccess {
  /** The policy of a model `resolvePolicy` says nothing about. */
  defaultPolicy?: OpenRouterRequestPolicy;
  /** The policy of one model, from the application's own model table. */
  resolvePolicy?(modelId: string): OpenRouterRequestPolicy | undefined;
  /**
   * Keep each conversation on one upstream: every request carries `session_id`
   * derived from `request.correlation.conversationId` (hashed when longer than
   * 256 characters), unless its policy pins `provider.order`.
   */
  sessionPerConversation?: boolean;
}

function buildBaseHeaders(
  settings: OpenRouterProviderSettings,
  apiKey: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(settings.appUrl !== undefined && { 'HTTP-Referer': settings.appUrl }),
    ...(settings.appName !== undefined && { 'X-OpenRouter-Title': settings.appName }),
    ...(settings.providerApiKeys !== undefined && {
      'X-Provider-API-Keys': JSON.stringify(settings.providerApiKeys),
    }),
  };
}

function buildOpenRouterRequestBody(input: {
  readonly modelId: string;
  readonly request: AgentModelRequest;
  readonly policy: OpenRouterWirePolicy;
  readonly sessionPerConversation: boolean;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const { modelId, request, policy, sessionPerConversation, extraBody } = input;
  const merged = mergeOpenRouterStepPolicy(policy, request.providerOptions);
  const pinnedOrder =
    isRecord(merged.provider) &&
    Array.isArray(merged.provider.order) &&
    merged.provider.order.length > 0;

  const effectiveSessionId = pinnedOrder
    ? undefined
    : merged.stepSessionId !== undefined
      ? openRouterSessionKey(merged.stepSessionId)
      : merged.baseSessionId !== undefined
        ? merged.baseSessionId
        : sessionPerConversation
          ? openRouterSessionKey(request.correlation.conversationId)
          : undefined;

  const autoTopLevelCacheControl = request.cacheControl ?? merged.baseCacheControl;
  const extraFields: Record<string, unknown> = { ...(merged.stepExtraBody ?? {}) };
  if (merged.provider !== undefined) extraFields.provider = merged.provider;
  if (merged.reasoning !== undefined) extraFields.reasoning = merged.reasoning;
  if (effectiveSessionId !== undefined) extraFields.session_id = effectiveSessionId;

  return buildOpenAiChatRequestBody({
    modelId,
    request,
    hooks: {
      providerKey: 'openrouter',
      looseTools: merged.looseTools,
      supportsInlineCacheControl: true,
      supportsAnthropicCacheControlOnMessages: openRouterAllowsInlineCacheControl,
      normalizeJsonSchema: true,
      ...(merged.explicitCacheControl !== undefined && {
        explicitTopLevelCacheControl: merged.explicitCacheControl,
      }),
      ...(autoTopLevelCacheControl !== undefined && { autoTopLevelCacheControl }),
      usageInclusion: 'openrouter',
      maxTokensField: 'max_tokens',
      supportsTopK: true,
      supportsReasoningDetails: true,
      supportsToolExtraContent: true,
      ...(extraBody !== undefined && { extraBody }),
      ...(Object.keys(extraFields).length > 0 && { extraFields }),
    },
  });
}

/** Native peer-free OpenRouter driver factory over `fetch` and Chat Completions SSE. → ADR 0336. */
export function openRouterProvider(
  settings: OpenRouterProviderSettings,
  access: OpenRouterProviderAccess = {},
): AgentModelDriverFactory {
  assertNoExtraBodyClash('openRouterProvider', settings.extraBody, OPENROUTER_POLICY_KEYS);
  const defaultPolicy =
    access.defaultPolicy !== undefined
      ? resolveOpenRouterWirePolicy(access.defaultPolicy)
      : EMPTY_WIRE_POLICY;
  const endpoint = joinProviderUrl(
    settings.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL,
    '/chat/completions',
  );
  const policyOf = (modelId: string): OpenRouterWirePolicy => {
    const resolved = access.resolvePolicy?.(modelId);
    return resolved !== undefined ? resolveOpenRouterWirePolicy(resolved) : defaultPolicy;
  };

  return {
    create(modelId: string): AgentModelDriver {
      return {
        provider: 'openrouter',
        modelId,
        async stream(request, signal) {
          const policy = policyOf(modelId);
          const body = buildOpenRouterRequestBody({
            modelId,
            request,
            policy,
            sessionPerConversation: access.sessionPerConversation === true,
            ...(settings.extraBody !== undefined && { extraBody: settings.extraBody }),
          });
          const apiKey = await resolveProviderApiKey(settings.apiKey);
          const response = await postProviderStream({
            provider: 'openrouter',
            url: endpoint,
            headers: buildBaseHeaders(settings, apiKey),
            ...(settings.headers !== undefined && { extraHeaders: settings.headers }),
            ...(request.headers !== undefined && { requestHeaders: request.headers }),
            body,
            signal,
            ...(settings.fetch !== undefined && { fetcher: settings.fetch }),
            parseError: parseOpenRouterError,
          });
          const decodeOptions = {
            provider: 'openrouter',
            signal,
            parseError: (payload: unknown) => parseOpenRouterError(payload),
            normalizeUsage: normalizeOpenRouterUsageDetails,
          };
          return {
            parts:
              response.kind === 'json'
                ? decodeOpenAiChatJsonResponse(response.json, decodeOptions)
                : decodeOpenAiChatSseStream(response.body, decodeOptions),
          };
        },
      };
    },
  };
}
