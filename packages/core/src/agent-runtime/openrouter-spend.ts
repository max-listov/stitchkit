import { z } from 'zod';
import { assertTimerMs } from '../internal/deadline';
import { openAiCompatibleUsage } from '../spend/facts';
import type { SpendProvider } from '../spend/gateway';
import type { SpendReconciler } from '../spend/reconcile';
import type { SpendRecord } from '../spend/schemas';
import {
  type OpenRouterCatalogFetch,
  OpenRouterHttpError,
  openRouterJson,
  withOpenRouterTimeout,
} from './openrouter-models';

/** OpenRouter as a `stitchkit/spend` gateway provider: its origin, its key, its usage format. */
export function openRouterSpendProvider(options: {
  /** Read per call, so a rotated key needs no restart. */
  apiKey: () => string | Promise<string>;
}): SpendProvider {
  return {
    name: 'openrouter',
    origin: 'https://openrouter.ai',
    headers: async () => ({ authorization: `Bearer ${await options.apiKey()}` }),
    facts: openAiCompatibleUsage,
  };
}

const GenerationSchema = z.object({
  data: z
    .object({
      total_cost: z.number().nonnegative().nullish(),
      provider_name: z.string().min(1).nullish(),
      model: z.string().min(1).nullish(),
      native_tokens_prompt: z.int().nonnegative().nullish(),
      native_tokens_completion: z.int().nonnegative().nullish(),
      native_tokens_reasoning: z.int().nonnegative().nullish(),
    })
    .loose(),
});

/**
 * Ask OpenRouter what an attempt cost (`GET /api/v1/generation?id=`), by the
 * generation id the gateway read from the response. A 404 is "not yet" — the
 * attempt stays pending; an attempt with no generation id can never be priced.
 */
export function createOpenRouterSpendReconciler(options: {
  /**
   * The key that made the call: OpenRouter prices a generation only for it. A
   * function when keys differ per space or per caller.
   */
  apiKey: string | ((record: SpendRecord) => string | Promise<string>);
  fetcher?: OpenRouterCatalogFetch;
  timeoutMs?: number;
}): SpendReconciler {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  assertTimerMs('timeoutMs', timeoutMs);
  return async (record) => {
    const id = record.receipt?.facts.providerRequestId;
    if (id === undefined) return { costStatus: 'unknown', failureCode: 'no-generation-id' };
    const url = new URL('https://openrouter.ai/api/v1/generation');
    url.searchParams.set('id', id);
    let body: unknown;
    try {
      const apiKey =
        typeof options.apiKey === 'string' ? options.apiKey : await options.apiKey(record);
      body = await withOpenRouterTimeout(timeoutMs, undefined, (signal) =>
        openRouterJson({ fetcher, url, apiKey, signal, maxBytes: 1024 * 1024 }),
      );
    } catch (error) {
      if (error instanceof OpenRouterHttpError && error.status === 404) return undefined;
      throw error;
    }
    const { data } = GenerationSchema.parse(body);
    if (data.total_cost == null) return undefined;
    return {
      costStatus: 'reported',
      costUsd: data.total_cost,
      ...(data.provider_name && { provider: data.provider_name }),
      ...(data.model && { resolvedModel: data.model }),
      ...(data.native_tokens_prompt != null && { inputTokens: data.native_tokens_prompt }),
      ...(data.native_tokens_completion != null && {
        outputTokens: data.native_tokens_completion,
      }),
      ...(data.native_tokens_reasoning != null && {
        reasoningTokens: data.native_tokens_reasoning,
      }),
    };
  };
}
