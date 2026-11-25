import { z } from 'zod';
import { withLinkedAbortSignals } from '../internal/abort-race';
import { readBoundedBody } from '../internal/bounded-body';
import { assertTimerMs } from '../internal/deadline';

/** OpenRouter's `/models` row: the one parser the catalog and the snapshot share. */
export const OpenRouterModelSchema = z
  .object({
    id: z.string().min(1),
    canonical_slug: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    context_length: z.int().nonnegative(),
    architecture: z.object({ input_modalities: z.array(z.string()).default([]) }).loose(),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
        request: z.string().optional(),
        image: z.string().optional(),
      })
      .loose(),
    supported_parameters: z.array(z.string()).default([]),
  })
  .loose();
export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
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

/**
 * One authenticated JSON read from OpenRouter: redirects refused (the key goes to
 * openrouter.ai and nowhere else), the body bounded, a non-2xx status thrown.
 */
export async function openRouterJson(input: {
  fetcher: OpenRouterCatalogFetch;
  url: URL;
  apiKey: string;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<unknown> {
  const response = await input.fetcher(input.url, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
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

/** USD per token as OpenRouter writes it (a decimal string) → USD per million, or `undefined` when not a real price. */
export function usdPerMillion(perToken: string | null | undefined): number | undefined {
  const value = usd(perToken);
  return value === undefined ? undefined : value * 1_000_000;
}

/** A plain non-negative decimal (`0.000002`, `2e-6`); `""`, `-1`, `0x10` and words are not prices. */
const DECIMAL = /^\d+(?:\.\d+)?(?:e-?\d+)?$/i;

/** USD as written (a decimal string) → a number, or `undefined` when not a real price. */
export function usd(value: string | null | undefined): number | undefined {
  // OpenRouter writes "-1" for a price it does not know; that is no price, never zero.
  if (value === undefined || value === null || !DECIMAL.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
