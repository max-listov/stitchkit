import { z } from 'zod';
import type { AgentUsage, AgentUsageValue } from './schemas-usage';

const NonNegativeIntSchema = z.int().nonnegative();

/** Construct a provider-reported integer usage counter, or `unavailable` when absent/invalid. */
export function reportedInt(value: unknown): AgentUsageValue {
  const parsed = NonNegativeIntSchema.safeParse(value);
  return parsed.success
    ? { value: parsed.data, provenance: 'provider-reported' }
    : { provenance: 'unavailable' };
}

/** Construct a computed integer usage counter (e.g. Anthropic total prompt tokens = input + cache). */
export function computedInt(value: unknown): AgentUsageValue {
  const parsed = NonNegativeIntSchema.safeParse(value);
  return parsed.success
    ? { value: parsed.data, provenance: 'computed' }
    : { provenance: 'unavailable' };
}

/** Construct a provider-reported USD cost figure, or `unavailable` when absent/non-finite. */
export function reportedUsd(value: unknown): NonNullable<AgentUsage['cost']> {
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, currency: 'USD', provenance: 'provider-reported' };
}

/** Construct a computed USD cost figure (e.g. BYOK OpenRouter fee + upstream inference cost). */
export function computedUsd(value: unknown): NonNullable<AgentUsage['cost']> {
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, currency: 'USD', provenance: 'computed' };
}

/** Read a finite non-negative number (e.g. USD sub-cost), or `undefined`. */
export function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Assemble a complete, provenance-honest `AgentUsage` record and sanity-check
 * sub-counter bounds so corrupted provider numbers never silently exceed totals.
 */
export function buildProviderUsage(input: {
  readonly inputTokens: AgentUsageValue;
  readonly outputTokens: AgentUsageValue;
  readonly reasoningTokens?: AgentUsageValue;
  readonly cacheReadTokens?: AgentUsageValue;
  readonly cacheWriteTokens?: AgentUsageValue;
  readonly cost?: NonNullable<AgentUsage['cost']>;
}): AgentUsage {
  const unavailable: AgentUsageValue = { provenance: 'unavailable' };
  const inputTotal = input.inputTokens.value;
  const outputTotal = input.outputTokens.value;

  const reasoningTokens =
    input.reasoningTokens &&
    outputTotal !== undefined &&
    input.reasoningTokens.value !== undefined &&
    input.reasoningTokens.value > outputTotal
      ? unavailable
      : (input.reasoningTokens ?? unavailable);

  const cacheReadVal = input.cacheReadTokens?.value;
  const cacheWriteVal = input.cacheWriteTokens?.value;
  const cacheExceedsInput =
    inputTotal !== undefined && (cacheReadVal ?? 0) + (cacheWriteVal ?? 0) > inputTotal;

  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens,
    cacheReadTokens: cacheExceedsInput ? unavailable : (input.cacheReadTokens ?? unavailable),
    cacheWriteTokens: cacheExceedsInput
      ? unavailable
      : (input.cacheWriteTokens ?? unavailable),
    cost: input.cost ?? { provenance: 'unavailable' },
  };
}
