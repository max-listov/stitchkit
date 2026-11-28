import { z } from 'zod';
import { linkAbortSignals } from '../internal/abort-race';
import {
  assertValidOpenRouterEndpointsFor,
  assertValidStaticOpenRouterApiKey,
  nonEmptyStrings,
  nonEmptyTrimmed,
  nonNegativeFinite,
  type OpenRouterCatalogFetch,
  OpenRouterEndpointsResponseSchema,
  type OpenRouterModelSchema,
  OpenRouterModelsResponseSchema,
  openRouterEndpointsUrl,
  openRouterJson,
  parseOpenRouterWirePricing,
  parseUnixSecondsIso,
  percentageMetric,
  usdPerMillion,
  withOpenRouterTimeout,
} from './openrouter-models';

const Price = z.number().nonnegative();
const NonNegativeMetric = z.number().nonnegative();
const Percentage = z.number().min(0).max(100);
const UnknownPricingFieldSchema = z.enum([
  'prompt',
  'completion',
  'request',
  'image',
  'cacheRead',
  'cacheWrite',
  'cacheWrite1h',
]);

const ConditionalPricingCeilingSchema = z.strictObject({
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  cacheReadUsdPerMillion: Price.optional(),
  cacheWriteUsdPerMillion: Price.optional(),
  cacheWrite1hUsdPerMillion: Price.optional(),
  requestUsd: Price.optional(),
  imageUsd: Price.optional(),
});

/** One conditional prompt-volume pricing tier reported in OpenRouter's `pricing.overrides`. */
export const OpenRouterPricingTierSchema = z.strictObject({
  minPromptTokens: z.int().positive(),
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  cacheReadUsdPerMillion: Price.optional(),
  cacheWriteUsdPerMillion: Price.optional(),
  cacheWrite1hUsdPerMillion: Price.optional(),
  requestUsd: Price.optional(),
  imageUsd: Price.optional(),
  /** Pricing keys explicitly present with unknown (`null`, `"-1"`, or invalid) values in this tier. */
  unknownPricingFields: z.array(UnknownPricingFieldSchema).min(1).optional(),
});
/** Conditional pricing tier inferred from `OpenRouterPricingTierSchema`. */
export type OpenRouterPricingTier = z.infer<typeof OpenRouterPricingTierSchema>;

/** Upstream target model referenced by an OpenRouter alias entry. */
export const OpenRouterModelAliasTargetSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
});
/** Alias target metadata inferred from `OpenRouterModelAliasTargetSchema`. */
export type OpenRouterModelAliasTarget = z.infer<typeof OpenRouterModelAliasTargetSchema>;

/** Reasoning effort metadata advertised by OpenRouter for a model. */
export const OpenRouterModelReasoningMetaSchema = z.strictObject({
  supportedEfforts: z.array(z.string().min(1)),
  defaultEffort: z.string().min(1).optional(),
});
/** Reasoning metadata inferred from `OpenRouterModelReasoningMetaSchema`. */
export type OpenRouterModelReasoningMeta = z.infer<typeof OpenRouterModelReasoningMetaSchema>;

/** One upstream serving a model, as `/models/{author}/{slug}/endpoints` reports it. */
export const OpenRouterEndpointSchema = z.strictObject({
  provider: z.string().min(1),
  contextLength: z.int().nonnegative().optional(),
  maxCompletionTokens: z.int().nonnegative().optional(),
  /** Absent when OpenRouter did not state a real price (it writes `-1` for unknown). */
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  cacheReadUsdPerMillion: Price.optional(),
  cacheWriteUsdPerMillion: Price.optional(),
  cacheWrite1hUsdPerMillion: Price.optional(),
  supportedParameters: z.array(z.string()),
  /** OpenRouter's status code for the endpoint; `0` is up. */
  status: z.int().optional(),
  /** Observed 30-minute P50 latency in milliseconds, when reported. */
  latencyP50Ms: NonNegativeMetric.optional(),
  /** Observed 30-minute P50 throughput (tokens/sec), when reported. */
  throughputP50: NonNegativeMetric.optional(),
  /** Observed 1-day uptime percentage (0–100), when reported. */
  uptime1d: Percentage.optional(),
  /** OpenRouter endpoint tag, when reported. */
  tag: z.string().min(1).optional(),
});
/** Upstream provider endpoint metadata inferred from `OpenRouterEndpointSchema`. */
export type OpenRouterEndpoint = z.infer<typeof OpenRouterEndpointSchema>;

/** A model in a stored snapshot: what admission, routing and discovery need. */
export const OpenRouterSnapshotModelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  canonicalSlug: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  aliasTarget: OpenRouterModelAliasTargetSchema.optional(),
  /** `text`, `image`, `file`, `audio` — what a request may carry. */
  inputModalities: z.array(z.string().min(1)).default([]),
  outputModalities: z.array(z.string().min(1)).optional(),
  tokenizer: z.string().min(1).optional(),
  contextLength: z.int().nonnegative().optional(),
  topProviderContextLength: z.int().nonnegative().optional(),
  maxCompletionTokens: z.int().nonnegative().optional(),
  reasoning: OpenRouterModelReasoningMetaSchema.optional(),
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  requestUsd: Price.optional(),
  imageUsd: Price.optional(),
  cacheReadUsdPerMillion: Price.optional(),
  cacheWriteUsdPerMillion: Price.optional(),
  cacheWrite1hUsdPerMillion: Price.optional(),
  pricingTiers: z.array(OpenRouterPricingTierSchema).optional(),
  hasConditionalPricing: z.boolean().optional(),
  /** Pricing keys explicitly present with unknown (`null`, `"-1"`, or invalid) values on base pricing or non-token overrides. */
  unknownPricingFields: z.array(UnknownPricingFieldSchema).min(1).optional(),
  /** Worst-case rates from recognized non-token conditional overrides (such as UTC time-window schedules). */
  conditionalPricingCeiling: ConditionalPricingCeilingSchema.optional(),
  /** True when `pricing.overrides` included an unrecognized or malformed rule whose ceiling cannot be verified. */
  hasUnverifiedPricingOverrides: z.boolean().optional(),
  supportedParameters: z.array(z.string()),
  /** Set by the application when it knows the id stands for another model. */
  aliasOf: z.string().min(1).optional(),
  endpoints: z.array(OpenRouterEndpointSchema).optional(),
});
/** Snapshot model record inferred from `OpenRouterSnapshotModelSchema`. */
export type OpenRouterSnapshotModel = z.infer<typeof OpenRouterSnapshotModelSchema>;

/** A stored, timestamped picture of OpenRouter's catalog: admission decides from it, not from a live call. */
export const OpenRouterCatalogSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observedAt: z.iso.datetime({ offset: true }),
  models: z.array(OpenRouterSnapshotModelSchema),
});
/** Timestamped OpenRouter catalog snapshot inferred from `OpenRouterCatalogSnapshotSchema`. */
export type OpenRouterCatalogSnapshot = z.infer<typeof OpenRouterCatalogSnapshotSchema>;

/** Options for loading an OpenRouter catalog snapshot and optional endpoint details. */
export interface OpenRouterSnapshotOptions {
  /** Static API key or per-request resolver; omit to fetch the public catalog without `Authorization`. */
  readonly apiKey?: string | (() => string | Promise<string>);
  readonly fetcher?: OpenRouterCatalogFetch;
  /** Per request. Default 10 s. */
  readonly timeoutMs?: number;
  /** Largest response body read. Default 16 MiB. */
  readonly maxResponseBytes?: number;
  /** Models whose endpoints are fetched too (one request each). */
  readonly endpointsFor?: readonly string[];
  /** Endpoint requests in flight at once, 1–16. Default 4. */
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

function mapSnapshotModel(
  model: z.infer<typeof OpenRouterModelSchema>,
  endpoints: readonly OpenRouterEndpoint[] | undefined,
): OpenRouterSnapshotModel {
  const pricing = parseOpenRouterWirePricing(model.pricing);
  const createdAt = parseUnixSecondsIso(model.created);
  const name = model.name != null && model.name.trim().length > 0 ? model.name : model.id;
  const description =
    model.description != null && model.description.trim().length > 0
      ? model.description
      : undefined;
  const canonicalSlug = nonEmptyTrimmed(model.canonical_slug);
  const aliasTargetName = nonEmptyTrimmed(model.alias_target?.name);
  const aliasTarget = model.alias_target
    ? { id: model.alias_target.slug, ...(aliasTargetName && { name: aliasTargetName }) }
    : undefined;
  const outputModalities =
    model.architecture.output_modalities != null
      ? nonEmptyStrings(model.architecture.output_modalities)
      : undefined;
  const tokenizer = nonEmptyTrimmed(model.architecture.tokenizer);
  const supportedEfforts = nonEmptyStrings(model.reasoning?.supported_efforts);
  const defaultEffort = nonEmptyTrimmed(model.reasoning?.default_effort);
  const reasoning =
    supportedEfforts.length > 0 || defaultEffort !== undefined
      ? { supportedEfforts, ...(defaultEffort && { defaultEffort }) }
      : undefined;

  return {
    id: model.id,
    name,
    ...(canonicalSlug && { canonicalSlug }),
    ...(description && { description }),
    ...(createdAt && { createdAt }),
    ...(aliasTarget && { aliasTarget }),
    inputModalities: nonEmptyStrings(model.architecture.input_modalities),
    ...(outputModalities !== undefined && { outputModalities }),
    ...(tokenizer && { tokenizer }),
    ...(model.context_length != null && { contextLength: model.context_length }),
    ...(model.top_provider?.context_length != null && {
      topProviderContextLength: model.top_provider.context_length,
    }),
    ...(model.top_provider?.max_completion_tokens != null && {
      maxCompletionTokens: model.top_provider.max_completion_tokens,
    }),
    ...(reasoning && { reasoning }),
    ...pricing.base,
    ...(pricing.pricingTiers && { pricingTiers: pricing.pricingTiers }),
    ...(pricing.hasConditionalPricing && { hasConditionalPricing: true }),
    ...(pricing.unknownPricingFields.length > 0 && {
      unknownPricingFields: pricing.unknownPricingFields,
    }),
    ...(pricing.conditionalPricingCeiling !== undefined && {
      conditionalPricingCeiling: pricing.conditionalPricingCeiling,
    }),
    ...(pricing.hasUnverifiedPricingOverrides && { hasUnverifiedPricingOverrides: true }),
    supportedParameters: model.supported_parameters,
    ...(endpoints !== undefined && { endpoints: [...endpoints] }),
  };
}

/** Every upstream of one model; a refused id or empty static key never reaches the network. */
export async function fetchOpenRouterModelEndpoints(
  modelId: string,
  options: Omit<OpenRouterSnapshotOptions, 'endpointsFor' | 'concurrency'> = {},
): Promise<OpenRouterEndpoint[]> {
  assertValidStaticOpenRouterApiKey(options.apiKey);
  const url = openRouterEndpointsUrl(modelId);
  const parsed = OpenRouterEndpointsResponseSchema.parse(
    await withOpenRouterTimeout(options.timeoutMs ?? 10_000, options.signal, (signal) =>
      openRouterJson({
        fetcher: options.fetcher ?? fetch,
        url,
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
        signal,
        ...(options.maxResponseBytes !== undefined && { maxBytes: options.maxResponseBytes }),
      }),
    ),
  );
  return parsed.data.endpoints.map((endpoint) => {
    const prompt = usdPerMillion(endpoint.pricing?.prompt);
    const completion = usdPerMillion(endpoint.pricing?.completion);
    const cacheRead = usdPerMillion(endpoint.pricing?.input_cache_read);
    const cacheWrite = usdPerMillion(endpoint.pricing?.input_cache_write);
    const cacheWrite1h = usdPerMillion(endpoint.pricing?.input_cache_write_1h);
    const latencyP50Ms = nonNegativeFinite(endpoint.latency_last_30m?.p50);
    const throughputP50 = nonNegativeFinite(endpoint.throughput_last_30m?.p50);
    const uptime1d = percentageMetric(endpoint.uptime_last_1d);
    const tag = nonEmptyTrimmed(endpoint.tag);
    return OpenRouterEndpointSchema.parse({
      provider: endpoint.provider_name,
      ...(endpoint.context_length != null && { contextLength: endpoint.context_length }),
      ...(endpoint.max_completion_tokens != null && {
        maxCompletionTokens: endpoint.max_completion_tokens,
      }),
      ...(prompt !== undefined && { promptUsdPerMillion: prompt }),
      ...(completion !== undefined && { completionUsdPerMillion: completion }),
      ...(cacheRead !== undefined && { cacheReadUsdPerMillion: cacheRead }),
      ...(cacheWrite !== undefined && { cacheWriteUsdPerMillion: cacheWrite }),
      ...(cacheWrite1h !== undefined && { cacheWrite1hUsdPerMillion: cacheWrite1h }),
      supportedParameters: endpoint.supported_parameters ?? [],
      ...(endpoint.status != null && { status: endpoint.status }),
      ...(latencyP50Ms !== undefined && { latencyP50Ms }),
      ...(throughputP50 !== undefined && { throughputP50 }),
      ...(uptime1d !== undefined && { uptime1d }),
      ...(tag && { tag }),
    });
  });
}

/** Read `/models` (and, for `endpointsFor`, each model's upstreams) into a snapshot to store. */
export async function loadOpenRouterCatalogSnapshot(
  options: OpenRouterSnapshotOptions = {},
): Promise<OpenRouterCatalogSnapshot> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError('concurrency must be an integer from 1 to 16');
  assertValidStaticOpenRouterApiKey(options.apiKey);
  assertValidOpenRouterEndpointsFor(options.endpointsFor);
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const listing = OpenRouterModelsResponseSchema.parse(
    await withOpenRouterTimeout(options.timeoutMs ?? 10_000, options.signal, (signal) =>
      openRouterJson({
        fetcher: options.fetcher ?? fetch,
        url: new URL('https://openrouter.ai/api/v1/models'),
        ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
        signal,
        ...(options.maxResponseBytes !== undefined && { maxBytes: options.maxResponseBytes }),
      }),
    ),
  ).data;
  const wanted = [...new Set(options.endpointsFor ?? [])];
  const endpoints = new Map<string, OpenRouterEndpoint[]>();
  // The first failure fails the snapshot and stops the rest: no further request
  // goes out with the key once the answer is already "no snapshot".
  const stop = new AbortController();
  const { signal, release } = linkAbortSignals(options.signal, stop.signal);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length && !stop.signal.aborted) {
      const modelId = wanted[next];
      next += 1;
      if (modelId === undefined) continue;
      try {
        endpoints.set(
          modelId,
          await fetchOpenRouterModelEndpoints(modelId, { ...options, signal }),
        );
      } catch (error) {
        stop.abort(error);
        throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  } finally {
    release();
  }
  return OpenRouterCatalogSnapshotSchema.parse({
    schemaVersion: 1,
    observedAt,
    models: listing.map((model) => mapSnapshotModel(model, endpoints.get(model.id))),
  });
}
