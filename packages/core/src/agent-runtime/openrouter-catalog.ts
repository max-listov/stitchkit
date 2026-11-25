import { z } from 'zod';
import { linkAbortSignals } from '../internal/abort-race';
import {
  type OpenRouterCatalogFetch,
  OpenRouterModelsResponseSchema,
  openRouterJson,
  usd,
  usdPerMillion,
  withOpenRouterTimeout,
} from './openrouter-models';

const Price = z.number().nonnegative().finite();

/** One upstream serving a model, as `/models/{author}/{slug}/endpoints` reports it. */
export const OpenRouterEndpointSchema = z.strictObject({
  provider: z.string().min(1),
  contextLength: z.int().nonnegative().optional(),
  /** Absent when OpenRouter did not state a real price (it writes `-1` for unknown). */
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  supportedParameters: z.array(z.string()),
  /** OpenRouter's status code for the endpoint; `0` is up. */
  status: z.int().optional(),
});
/** Upstream provider endpoint metadata inferred from `OpenRouterEndpointSchema`. */
export type OpenRouterEndpoint = z.infer<typeof OpenRouterEndpointSchema>;

/** A model in a stored snapshot: what admission needs, nothing derived. */
export const OpenRouterSnapshotModelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  canonicalSlug: z.string().min(1).optional(),
  /** `text`, `image`, `file`, `audio` — what a request may carry. */
  inputModalities: z.array(z.string().min(1)).default([]),
  contextLength: z.int().nonnegative(),
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  requestUsd: Price.optional(),
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

/** `author/slug` and nothing that could leave the path segment it is put in. */
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function endpointsUrl(modelId: string): URL {
  if (!MODEL_ID.test(modelId) || modelId.includes('..'))
    throw new TypeError(`Not an OpenRouter model id: ${modelId}`);
  const [author = '', slug = ''] = modelId.split('/');
  return new URL(
    `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
  );
}

const EndpointsResponseSchema = z.object({
  data: z
    .object({
      endpoints: z.array(
        z
          .object({
            provider_name: z.string().min(1),
            context_length: z.int().nonnegative().nullish(),
            pricing: z
              .object({ prompt: z.string().optional(), completion: z.string().optional() })
              .loose()
              .nullish(),
            supported_parameters: z.array(z.string()).nullish(),
            status: z.int().nullish(),
          })
          .loose(),
      ),
    })
    .loose(),
});

/** Options for loading an OpenRouter catalog snapshot and optional endpoint details. */
export interface OpenRouterSnapshotOptions {
  apiKey: string;
  fetcher?: OpenRouterCatalogFetch;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Largest response body read. Default 16 MiB. */
  maxResponseBytes?: number;
  /** Models whose endpoints are fetched too (one request each). */
  endpointsFor?: readonly string[];
  /** Endpoint requests in flight at once, 1–16. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Every upstream of one model; a refused id never reaches the network. */
export async function fetchOpenRouterModelEndpoints(
  modelId: string,
  options: Omit<OpenRouterSnapshotOptions, 'endpointsFor' | 'concurrency'>,
): Promise<OpenRouterEndpoint[]> {
  const url = endpointsUrl(modelId);
  const parsed = EndpointsResponseSchema.parse(
    await withOpenRouterTimeout(options.timeoutMs ?? 10_000, options.signal, (signal) =>
      openRouterJson({
        fetcher: options.fetcher ?? fetch,
        url,
        apiKey: options.apiKey,
        signal,
        ...(options.maxResponseBytes !== undefined && { maxBytes: options.maxResponseBytes }),
      }),
    ),
  );
  return parsed.data.endpoints.map((endpoint) => {
    const prompt = usdPerMillion(endpoint.pricing?.prompt);
    const completion = usdPerMillion(endpoint.pricing?.completion);
    return OpenRouterEndpointSchema.parse({
      provider: endpoint.provider_name,
      ...(endpoint.context_length != null && { contextLength: endpoint.context_length }),
      ...(prompt !== undefined && { promptUsdPerMillion: prompt }),
      ...(completion !== undefined && { completionUsdPerMillion: completion }),
      supportedParameters: endpoint.supported_parameters ?? [],
      ...(endpoint.status != null && { status: endpoint.status }),
    });
  });
}

/** Read `/models` (and, for `endpointsFor`, each model's upstreams) into a snapshot to store. */
export async function loadOpenRouterCatalogSnapshot(
  options: OpenRouterSnapshotOptions,
): Promise<OpenRouterCatalogSnapshot> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new RangeError('concurrency must be an integer from 1 to 16');
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const listing = OpenRouterModelsResponseSchema.parse(
    await withOpenRouterTimeout(options.timeoutMs ?? 10_000, options.signal, (signal) =>
      openRouterJson({
        fetcher: options.fetcher ?? fetch,
        url: new URL('https://openrouter.ai/api/v1/models'),
        apiKey: options.apiKey,
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
    models: listing.map((model) => {
      const prompt = usdPerMillion(model.pricing.prompt);
      const completion = usdPerMillion(model.pricing.completion);
      const request = usd(model.pricing.request);
      return {
        id: model.id,
        name: model.name,
        ...(model.canonical_slug && { canonicalSlug: model.canonical_slug }),
        inputModalities: model.architecture.input_modalities,
        contextLength: model.context_length,
        ...(prompt !== undefined && { promptUsdPerMillion: prompt }),
        ...(completion !== undefined && { completionUsdPerMillion: completion }),
        ...(request !== undefined && { requestUsd: request }),
        supportedParameters: model.supported_parameters,
        ...(endpoints.has(model.id) && { endpoints: endpoints.get(model.id) }),
      };
    }),
  });
}
