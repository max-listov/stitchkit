import { z } from 'zod';
import type { SpendFacts } from './schemas';

/** What a provider's response says about the call, read event by event. */
export interface SpendFactsReader {
  /** From the response headers (a request id header, a cost header). */
  headers?(headers: Headers): Partial<SpendFacts>;
  /**
   * From one parsed JSON value: the whole body of a JSON response, or one `data:`
   * event of a server-sent-event stream. Later events refine earlier ones.
   */
  event?(value: unknown): Partial<SpendFacts>;
}

const Count = z.int().nonnegative();
const NonNegativeFinite = z.number().nonnegative();
const NonEmptyString = z.string().min(1);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readField<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Usage as OpenAI-compatible APIs report it (OpenAI, OpenRouter, most gateways):
 * `id`, `model` and the `usage` block of a JSON body or of the final stream event.
 * A `usage.cost` (OpenRouter) is a provider-reported cost; without it the cost is
 * `pending` for a reconciler to learn.
 *
 * Each field is validated on its own so a `null` or out-of-range detail (such as
 * OpenRouter's `cache_write_tokens: null` or `cost: null`) never drops the
 * remaining facts or the provider request id.
 */
export const openAiCompatibleUsage: SpendFactsReader = {
  event(value) {
    if (!isRecord(value)) return {};
    const id = readField(NonEmptyString, value.id);
    const model = readField(NonEmptyString, value.model);
    const provider = readField(NonEmptyString, value.provider);
    const usage = isRecord(value.usage) ? value.usage : undefined;
    const promptDetails =
      usage && isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
    const completionDetails =
      usage && isRecord(usage.completion_tokens_details)
        ? usage.completion_tokens_details
        : undefined;
    const inputTokens = readField(Count, usage?.prompt_tokens);
    const outputTokens = readField(Count, usage?.completion_tokens);
    const reasoningTokens = readField(Count, completionDetails?.reasoning_tokens);
    const cacheReadTokens = readField(Count, promptDetails?.cached_tokens);
    const cacheWriteTokens = readField(Count, promptDetails?.cache_write_tokens);
    const costUsd = readField(NonNegativeFinite, usage?.cost);
    return {
      ...(id !== undefined && { providerRequestId: id }),
      ...(model !== undefined && { resolvedModel: model }),
      ...(provider !== undefined && { provider }),
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
      ...(reasoningTokens !== undefined && { reasoningTokens }),
      ...(cacheReadTokens !== undefined && { cacheReadTokens }),
      ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
      ...(costUsd !== undefined && {
        costUsd,
        costStatus: 'reported' as const,
      }),
    };
  },
};
