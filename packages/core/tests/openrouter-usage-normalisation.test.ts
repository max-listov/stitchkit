/**
 * Guard: an application that does not build the runtime can still get an honest
 * number out of a provider step.
 *
 * `normalizeOpenRouterUsage` always existed; it was reachable only through
 * `openRouterProvider`, which means only by adopting the whole agent runtime.
 * Two consuming applications that call the SDK directly derived it again, and
 * more than half of their two files agree line for line — not because they
 * could not find ours, but because we did not hand it over.
 *
 * The arithmetic is not what a re-derivation gets wrong. The provenance is: a
 * number the provider reported, a number nobody reported, and a zero are three
 * different facts (→ ADR 0109), and the invented value for a missing field is
 * the one that reads as true and is not.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOpenRouterUsage, openRouterProvider } from '../src/agent-runtime-openrouter';

/** One SDK usage record, in the shape the provider hands over. */
const usage = {
  inputTokens: 1_200,
  outputTokens: 340,
  totalTokens: 1_540,
  inputTokenDetails: { cacheReadTokens: 800, cacheWriteTokens: undefined },
  outputTokenDetails: { reasoningTokens: 64 },
} as unknown as Parameters<typeof normalizeOpenRouterUsage>[0];

describe('provider usage normalisation is usable without the runtime', () => {
  test('a reported count carries provider-reported, and a missing one carries unavailable', () => {
    const normalized = normalizeOpenRouterUsage(usage, {
      openrouter: { cost: 0.0042 },
    });

    expect(normalized.inputTokens).toEqual({ value: 1_200, provenance: 'provider-reported' });
    expect(normalized.outputTokens).toEqual({ value: 340, provenance: 'provider-reported' });
    expect(normalized.reasoningTokens).toEqual({ value: 64, provenance: 'provider-reported' });
    expect(normalized.cacheReadTokens).toEqual({
      value: 800,
      provenance: 'provider-reported',
    });
    // Absent is absent. A zero here would read as "the provider wrote nothing to
    // the cache", which is a claim nobody made.
    expect(normalized.cacheWriteTokens).toEqual({ provenance: 'unavailable' });
    expect(normalized.cost).toEqual({
      value: 0.0042,
      currency: 'USD',
      provenance: 'provider-reported',
    });
  });

  test('a cost the provider did not report is unavailable, never zero', () => {
    expect(normalizeOpenRouterUsage(usage, {}).cost).toEqual({ provenance: 'unavailable' });
    expect(normalizeOpenRouterUsage(usage, undefined).cost).toEqual({
      provenance: 'unavailable',
    });
    // A cost nested under `usage` is the other place OpenRouter writes it.
    expect(
      normalizeOpenRouterUsage(usage, { openrouter: { usage: { cost: 0.5 } } }).cost,
    ).toEqual({ value: 0.5, currency: 'USD', provenance: 'provider-reported' });
  });

  test('the provider and the direct call agree, because they are one implementation', () => {
    // The property that keeps this export from becoming a second copy: if the
    // provider stopped using this function, the two would drift and this fails.
    const metadata = { openrouter: { cost: 0.01 } };
    const provider = openRouterProvider({ apiKey: 'test-key' });
    expect(provider.normalizeUsage?.({ usage, providerMetadata: metadata })).toEqual(
      normalizeOpenRouterUsage(usage, metadata),
    );
  });

  test('a non-integer count is refused rather than rounded into a fact', () => {
    const fractional = {
      ...usage,
      inputTokens: 12.5,
      outputTokens: -1,
    } as unknown as Parameters<typeof normalizeOpenRouterUsage>[0];
    const normalized = normalizeOpenRouterUsage(fractional, {});
    expect(normalized.inputTokens).toEqual({ provenance: 'unavailable' });
    expect(normalized.outputTokens).toEqual({ provenance: 'unavailable' });
  });
});
