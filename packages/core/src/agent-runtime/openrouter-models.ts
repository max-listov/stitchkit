import { z } from 'zod';
import { withLinkedAbortSignals } from '../internal/abort-race';
import { readBoundedBody } from '../internal/bounded-body';
import { assertTimerMs } from '../internal/deadline';
import { isPositiveSafeInteger } from '../internal/positive-integer';
import { isRecord } from '../internal/typed';

/** OpenRouter's `/models` row: the one parser the catalog and the snapshot share. */
export const OpenRouterModelSchema = z
  .object({
    id: z.string().min(1),
    canonical_slug: z.string().min(1).nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    created: z.number().nullish(),
    alias_target: z
      .object({
        slug: z.string().min(1),
        name: z.string().nullish(),
      })
      .loose()
      .nullish(),
    context_length: z.int().nonnegative().nullish(),
    architecture: z
      .object({
        input_modalities: z
          .array(z.string())
          .nullish()
          .transform((value) => value ?? []),
        output_modalities: z.array(z.string()).nullish(),
        tokenizer: z.string().nullish(),
      })
      .loose()
      .nullish()
      .transform((value) => value ?? { input_modalities: [] }),
    top_provider: z
      .object({
        context_length: z.int().nonnegative().nullish(),
        max_completion_tokens: z.int().nonnegative().nullish(),
      })
      .loose()
      .nullish(),
    reasoning: z
      .object({
        supported_efforts: z.array(z.string()).nullish(),
        default_effort: z.string().nullish(),
      })
      .loose()
      .nullish(),
    pricing: z
      .object({
        prompt: z.string().nullish(),
        completion: z.string().nullish(),
        request: z.string().nullish(),
        image: z.string().nullish(),
        input_cache_read: z.string().nullish(),
        input_cache_write: z.string().nullish(),
        input_cache_write_1h: z.string().nullish(),
        overrides: z.array(z.unknown()).nullish(),
      })
      .loose()
      .nullish(),
    supported_parameters: z
      .array(z.string())
      .nullish()
      .transform((value) => value ?? []),
  })
  .loose();

/** OpenRouter's `/models` envelope, rejecting paginated truncation and duplicate model ids. */
export const OpenRouterModelsResponseSchema = z
  .object({
    data: z.array(OpenRouterModelSchema),
    links: z
      .object({
        next: z.string().nullable().optional(),
      })
      .loose()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (typeof value.links?.next === 'string' && value.links.next.trim().length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['links', 'next'],
        message: 'Incomplete OpenRouter catalog response (paginated next link present)',
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < value.data.length; index += 1) {
      const id = value.data[index]?.id;
      if (id === undefined) continue;
      if (seen.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data', index, 'id'],
          message: `Duplicate OpenRouter model id: ${id}`,
        });
      } else {
        seen.add(id);
      }
    }
  });

/** How the leaf reaches OpenRouter; `fetch` by default. */
export type OpenRouterCatalogFetch = (input: URL, init?: RequestInit) => Promise<Response>;

/**
 * Run OpenRouter requests under a timeout shared by catalog and endpoint reads, linked to a
 * caller signal only while they run. `timeoutMs` is refused before any timer exists.
 */
export function withOpenRouterTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  requests: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertTimerMs('timeoutMs', timeoutMs, { absent: 'refused' });
  return withLinkedAbortSignals(signal, AbortSignal.timeout(timeoutMs), requests);
}

/** Validate a static `apiKey` eagerly before any network call; functions are validated when resolved. */
export function assertValidStaticOpenRouterApiKey(
  apiKey: string | (() => string | Promise<string>) | undefined,
): void {
  if (apiKey === undefined || typeof apiKey === 'function') return;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new TypeError('OpenRouter apiKey must be a non-empty string when provided');
  }
}

async function resolveOptionalOpenRouterApiKey(
  apiKey: string | (() => string | Promise<string>) | undefined,
): Promise<string | undefined> {
  if (apiKey === undefined) return undefined;
  const resolved = typeof apiKey === 'function' ? await apiKey() : apiKey;
  if (typeof resolved !== 'string') {
    throw new TypeError('OpenRouter apiKey must resolve to a non-empty string');
  }
  const trimmed = resolved.trim();
  if (trimmed.length === 0) {
    throw new TypeError('OpenRouter apiKey must be a non-empty string when provided');
  }
  return trimmed;
}

/**
 * One JSON read from OpenRouter: redirects refused (an API key goes to openrouter.ai and
 * nowhere else), the body bounded, a non-2xx status thrown, and `Authorization` omitted when
 * no key is provided.
 */
export async function openRouterJson(input: {
  fetcher: OpenRouterCatalogFetch;
  url: URL;
  apiKey?: string | (() => string | Promise<string>);
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<unknown> {
  input.signal.throwIfAborted();
  const apiKey =
    input.apiKey !== undefined
      ? await resolveOptionalOpenRouterApiKey(input.apiKey)
      : undefined;
  input.signal.throwIfAborted();
  const response = await input.fetcher(input.url, {
    ...(apiKey !== undefined && { headers: { Authorization: `Bearer ${apiKey}` } }),
    redirect: 'error',
    signal: input.signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpenRouterHttpError(response.status, input.url.pathname);
  }
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024;
  const bytes = await readBoundedBody(response.body, {
    maxBytes,
    signal: input.signal,
    limitError: () => new RangeError(`OpenRouter response exceeds ${maxBytes} bytes`),
  });
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** A non-2xx answer from OpenRouter; `status` lets a caller tell "not yet" (404) from a failure. */
export class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`OpenRouter request ${path} failed with HTTP ${status}`);
    this.name = 'OpenRouterHttpError';
  }
}

/** A plain non-negative decimal (`0.000002`, `2e-6`, `1e+2`); `""`, `-1`, `0x10` and words are not prices. */
const DECIMAL = /^(\d+(?:\.\d+)?)(?:e([+-]?\d+))?$/i;

/** USD per token as OpenRouter writes it (a decimal string) → USD per million, or `undefined` when not a real price. */
export function usdPerMillion(perToken: string | null | undefined): number | undefined {
  // Shift the decimal exponent by +6 before converting to IEEE-754 so values like "0.0000002"
  // become 0.2 directly without double-rounding noise (0.19999999999999998).
  if (perToken === undefined || perToken === null) return undefined;
  const match = DECIMAL.exec(perToken.trim());
  if (!match) return undefined;
  const mantissa = match[1];
  const exponent = match[2] !== undefined ? Number(match[2]) : 0;
  if (mantissa === undefined || !Number.isSafeInteger(exponent)) return undefined;
  const parsed = Number(`${mantissa}e${exponent + 6}`);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** USD as written (a decimal string) → a number, or `undefined` when not a real price. */
export function usd(value: string | null | undefined): number | undefined {
  // OpenRouter writes "-1" for a price it does not know; that is no price, never zero.
  if (value === undefined || value === null || !DECIMAL.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** `author/slug` (or `~author/slug` router id) and nothing that could leave its path segment. */
const MODEL_ID = /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** Build the validated OpenRouter `/models/{author}/{slug}/endpoints` URL. */
export function openRouterEndpointsUrl(modelId: string): URL {
  if (!MODEL_ID.test(modelId) || modelId.includes('..')) {
    throw new TypeError(`Not an OpenRouter model id: ${modelId}`);
  }
  const [author = '', slug = ''] = modelId.split('/');
  return new URL(
    `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
  );
}

/** Validate every model id in `endpointsFor` eagerly before any network request. */
export function assertValidOpenRouterEndpointsFor(
  endpointsFor: readonly string[] | undefined,
): void {
  if (endpointsFor === undefined) return;
  for (const modelId of endpointsFor) {
    openRouterEndpointsUrl(modelId);
  }
}

const PercentileMetricSchema = z.object({ p50: z.number().nullish() }).loose().nullish();

/** OpenRouter's `/models/{author}/{slug}/endpoints` wire response envelope. */
export const OpenRouterEndpointsResponseSchema = z.object({
  data: z
    .object({
      endpoints: z.array(
        z
          .object({
            provider_name: z.string().min(1),
            context_length: z.int().nonnegative().nullish(),
            max_completion_tokens: z.int().nonnegative().nullish(),
            pricing: z
              .object({
                prompt: z.string().nullish(),
                completion: z.string().nullish(),
                input_cache_read: z.string().nullish(),
                input_cache_write: z.string().nullish(),
                input_cache_write_1h: z.string().nullish(),
              })
              .loose()
              .nullish(),
            supported_parameters: z.array(z.string()).nullish(),
            status: z.int().nullish(),
            latency_last_30m: PercentileMetricSchema,
            throughput_last_30m: PercentileMetricSchema,
            uptime_last_1d: z.number().nullish(),
            tag: z.string().nullish(),
          })
          .loose(),
      ),
    })
    .loose(),
});

/** Return `value` when it is a finite non-negative number, else `undefined` (never `0`). */
export function nonNegativeFinite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Return `value` when it is a finite percentage in `[0, 100]`, else `undefined`. */
export function percentageMetric(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

/** Return trimmed `value` when non-empty, else `undefined`. */
export function nonEmptyTrimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Keep trimmed non-empty strings from an optional list. */
export function nonEmptyStrings(values: readonly string[] | null | undefined): string[] {
  if (!values) return [];
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0) result.push(trimmed);
  }
  return result;
}

/** Convert a positive Unix timestamp in seconds to an ISO-8601 UTC datetime string. */
export function parseUnixSecondsIso(created: number | null | undefined): string | undefined {
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0)
    return undefined;
  const date = new Date(created * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export type OpenRouterWireUnknownPricingField =
  | 'prompt'
  | 'completion'
  | 'request'
  | 'image'
  | 'cacheRead'
  | 'cacheWrite'
  | 'cacheWrite1h';

export interface OpenRouterWirePriceRates {
  readonly promptUsdPerMillion?: number;
  readonly completionUsdPerMillion?: number;
  readonly requestUsd?: number;
  readonly imageUsd?: number;
  readonly cacheReadUsdPerMillion?: number;
  readonly cacheWriteUsdPerMillion?: number;
  readonly cacheWrite1hUsdPerMillion?: number;
}

export interface OpenRouterWirePricingTier extends OpenRouterWirePriceRates {
  readonly minPromptTokens: number;
  readonly unknownPricingFields?: OpenRouterWireUnknownPricingField[];
}

const KNOWN_CONDITION_KEYS = new Set([
  'min_prompt_tokens',
  'utc_start',
  'utc_end',
  'utc_days',
]);
const WIRE_PRICE_SPECS: readonly (readonly [
  string,
  keyof OpenRouterWirePriceRates,
  OpenRouterWireUnknownPricingField,
  (value: string | null | undefined) => number | undefined,
])[] = [
  ['prompt', 'promptUsdPerMillion', 'prompt', usdPerMillion],
  ['completion', 'completionUsdPerMillion', 'completion', usdPerMillion],
  ['request', 'requestUsd', 'request', usd],
  ['image', 'imageUsd', 'image', usd],
  ['input_cache_read', 'cacheReadUsdPerMillion', 'cacheRead', usdPerMillion],
  ['input_cache_write', 'cacheWriteUsdPerMillion', 'cacheWrite', usdPerMillion],
  ['input_cache_write_1h', 'cacheWrite1hUsdPerMillion', 'cacheWrite1h', usdPerMillion],
];

const hasOwnDefined = (obj: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(obj, key) && obj[key] !== undefined;

function parsePriceRecord(
  source: Record<string, unknown>,
  defaultOmittedRequestZero: boolean,
) {
  const rates: { -readonly [K in keyof OpenRouterWirePriceRates]?: number } = {};
  const unknown: OpenRouterWireUnknownPricingField[] = [];
  for (const [wireKey, outKey, field, parse] of WIRE_PRICE_SPECS) {
    if (!hasOwnDefined(source, wireKey)) {
      if (wireKey === 'request' && defaultOmittedRequestZero) rates.requestUsd = 0;
      continue;
    }
    const raw = source[wireKey];
    const parsed = typeof raw === 'string' ? parse(raw) : undefined;
    if (parsed !== undefined) rates[outKey] = parsed;
    else unknown.push(field);
  }
  return { rates, unknown };
}

function mergeRateCeilings(
  current: OpenRouterWirePriceRates | undefined,
  next: OpenRouterWirePriceRates,
): OpenRouterWirePriceRates {
  const merged: { -readonly [K in keyof OpenRouterWirePriceRates]?: number } = { ...current };
  for (const [, key] of WIRE_PRICE_SPECS) {
    const candidate = next[key];
    if (candidate === undefined) continue;
    const prev = merged[key];
    merged[key] = prev === undefined ? candidate : Math.max(prev, candidate);
  }
  return merged;
}

function parseOverrideCondition(
  raw: Record<string, unknown>,
): { readonly threshold?: number; readonly prices: Record<string, unknown> } | undefined {
  if (
    (hasOwnDefined(raw, 'condition') && !isRecord(raw.condition)) ||
    (hasOwnDefined(raw, 'pricing') && !isRecord(raw.pricing))
  ) {
    return undefined;
  }
  const cond = isRecord(raw.condition) ? raw.condition : raw;
  const prices = isRecord(raw.pricing) ? raw.pricing : raw;
  if (
    isRecord(raw.condition) &&
    Object.keys(raw.condition).some((k) => !KNOWN_CONDITION_KEYS.has(k))
  ) {
    return undefined;
  }
  const threshold = cond.min_prompt_tokens;
  const validThreshold = isPositiveSafeInteger(threshold);
  const utcOk = (v: unknown) => v === 0 || (isPositiveSafeInteger(v) && v <= 2400);
  const daysOk = (v: unknown) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((d) => typeof d === 'string' && d.trim().length > 0);
  const hasUtc =
    hasOwnDefined(cond, 'utc_start') ||
    hasOwnDefined(cond, 'utc_end') ||
    hasOwnDefined(cond, 'utc_days');
  if (
    (hasOwnDefined(cond, 'min_prompt_tokens') && !validThreshold) ||
    (hasOwnDefined(cond, 'utc_start') && !utcOk(cond.utc_start)) ||
    (hasOwnDefined(cond, 'utc_end') && !utcOk(cond.utc_end)) ||
    (hasOwnDefined(cond, 'utc_days') && !daysOk(cond.utc_days)) ||
    (!validThreshold && !hasUtc)
  ) {
    return undefined;
  }
  return validThreshold && !hasUtc ? { threshold, prices } : { prices };
}

/** Parse base pricing and conditional `overrides` while distinguishing omitted keys from explicit unknowns. */
export function parseOpenRouterWirePricing(
  pricing: Record<string, unknown> | null | undefined,
) {
  const base = pricing != null ? parsePriceRecord(pricing, true) : undefined;
  const unknownSet = new Set<OpenRouterWireUnknownPricingField>(base?.unknown ?? []);
  const rawOverrides = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
  const tiers: OpenRouterWirePricingTier[] = [];
  const seenThresholds = new Set<number>();
  let conditionalCeiling: OpenRouterWirePriceRates | undefined;
  let hasUnverified = false;
  for (const raw of rawOverrides) {
    const condition = isRecord(raw) ? parseOverrideCondition(raw) : undefined;
    if (condition === undefined) {
      hasUnverified = true;
      continue;
    }
    const parsed = parsePriceRecord(condition.prices, false);
    if (condition.threshold !== undefined) {
      if (seenThresholds.has(condition.threshold)) {
        hasUnverified = true;
        continue;
      }
      seenThresholds.add(condition.threshold);
      tiers.push({
        minPromptTokens: condition.threshold,
        ...parsed.rates,
        ...(parsed.unknown.length > 0 && { unknownPricingFields: parsed.unknown }),
      });
    } else {
      conditionalCeiling = mergeRateCeilings(conditionalCeiling, parsed.rates);
      for (const field of parsed.unknown) unknownSet.add(field);
    }
  }
  tiers.sort((left, right) => left.minPromptTokens - right.minPromptTokens);
  return {
    ...(base !== undefined && { base: base.rates }),
    hasConditionalPricing: rawOverrides.length > 0,
    ...(tiers.length > 0 && { pricingTiers: tiers }),
    ...(conditionalCeiling !== undefined && { conditionalPricingCeiling: conditionalCeiling }),
    unknownPricingFields: [...unknownSet],
    hasUnverifiedPricingOverrides: hasUnverified,
  };
}
