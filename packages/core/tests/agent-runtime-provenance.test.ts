import { describe, expect, test } from 'bun:test';
import type { LanguageModelUsage } from 'ai';
import {
  AgentCostValueSchema,
  AgentProvenanceSchema,
  AgentTokenCountSchema,
  AgentUsageSchema,
  AgentUsageValueSchema,
  composeAgentPrompt,
  selectAgentHistory,
} from '../src/agent-runtime';
import { normalizeSdkUsage } from '../src/agent-runtime/runtime-internals';

/**
 * The vocabulary, written out once here on purpose.
 *
 * This file is the sanction: a word may be added, removed or moved between
 * surfaces only by editing these three lists, which is the review this used to
 * lack. Two enums drifted apart in silence because nothing held them side by
 * side — `measured` on one, `provider-reported` on the other, describing token
 * counts for the same request.
 */
const VOCABULARY = ['provider-reported', 'measured', 'computed', 'estimated', 'unavailable'];
/** After a request: the provider may have reported. Nothing is `measured`. */
const SPEND = ['provider-reported', 'computed', 'estimated', 'unavailable'];
/** Before a request: this process may have counted. Nobody has reported yet. */
const BUDGET = ['measured', 'computed', 'estimated', 'unavailable'];

/** Widened to plain strings so the lists above, not the enums, are the claim. */
const words = (options: readonly string[]): string[] => [...options];

const message = (id: string, role: 'user' | 'assistant', text: string) => ({
  schemaVersion: 1 as const,
  id,
  conversationId: 'c1',
  role,
  status: 'completed' as const,
  parts: [{ type: 'text' as const, text }],
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
});

const sdkUsage = (input: number, output: number): LanguageModelUsage =>
  ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: {},
    outputTokenDetails: {},
  }) as unknown as LanguageModelUsage;

describe('one provenance vocabulary', () => {
  test('every surface draws its words from the same list', () => {
    expect(words(AgentProvenanceSchema.options)).toEqual(VOCABULARY);
    expect(words(AgentUsageValueSchema.shape.provenance.options)).toEqual(SPEND);
    expect(words(AgentCostValueSchema.shape.provenance.options)).toEqual(SPEND);
    expect(words(AgentTokenCountSchema.shape.provenance.options)).toEqual(BUDGET);
    for (const word of [...SPEND, ...BUDGET]) expect(VOCABULARY).toContain(word);
  });

  test('a word shared by both surfaces means the same thing on both', () => {
    // The failure this guards is not "the lists differ" — they are meant to.
    // It is a word appearing on one surface with a meaning the other does not
    // give it. `computed`, `estimated` and `unavailable` are the words both
    // may produce; `provider-reported` and `measured` are each exclusive, and
    // that exclusivity is the whole reason both survive.
    const shared = SPEND.filter((word) => BUDGET.includes(word));
    expect(shared).toEqual(['computed', 'estimated', 'unavailable']);
    expect(SPEND.filter((word) => !BUDGET.includes(word))).toEqual(['provider-reported']);
    expect(BUDGET.filter((word) => !SPEND.includes(word))).toEqual(['measured']);
  });

  test('neither surface accepts the other exclusive word', () => {
    expect(AgentUsageValueSchema.safeParse({ provenance: 'measured' }).success).toBe(false);
    expect(AgentTokenCountSchema.safeParse({ provenance: 'provider-reported' }).success).toBe(
      false,
    );
  });
});

describe('a token is an integer', () => {
  test('a fractional token count is refused wherever tokens are counted', () => {
    expect(
      AgentUsageValueSchema.safeParse({ value: 3.5, provenance: 'provider-reported' }).success,
    ).toBe(false);
    expect(
      AgentTokenCountSchema.safeParse({ value: 3.5, provenance: 'measured' }).success,
    ).toBe(false);
    expect(
      AgentUsageSchema.safeParse({
        inputTokens: { value: 3.5, provenance: 'provider-reported' },
        outputTokens: { value: 1, provenance: 'provider-reported' },
      }).success,
    ).toBe(false);
  });

  test('money stays fractional, because money is', () => {
    expect(
      AgentCostValueSchema.safeParse({
        value: 0.0125,
        currency: 'USD',
        provenance: 'provider-reported',
      }).success,
    ).toBe(true);
  });

  test('a provider that reports a fraction gets "unavailable", not a thrown run', () => {
    // The schema refuses the value; this path must not turn that refusal into
    // an exception out of the terminal commit of a run that already answered.
    const usage = normalizeSdkUsage(sdkUsage(3.5, 10));
    expect(usage.inputTokens).toEqual({ provenance: 'unavailable' });
    expect(usage.outputTokens).toEqual({ value: 10, provenance: 'provider-reported' });
    expect(AgentUsageSchema.safeParse(usage).success).toBe(true);
  });
});

describe('a total is computed, not measured', () => {
  test('selectAgentHistory sums exact counts into a computed total', async () => {
    const result = await selectAgentHistory({
      messages: [message('m1', 'user', 'hello'), message('m2', 'assistant', 'hi')],
      availableTokens: 1_000,
      estimateMessage: () => ({ value: 10, provenance: 'measured' }),
    });
    expect(result.totalTokens).toEqual({ value: 20, provenance: 'computed' });
  });

  test('one estimated part makes the whole total an estimate', async () => {
    const result = await selectAgentHistory({
      messages: [message('m1', 'user', 'hello'), message('m2', 'assistant', 'hi')],
      availableTokens: 1_000,
      estimateMessage: (candidate) =>
        candidate.id === 'm1'
          ? { value: 10, provenance: 'measured' }
          : { value: 10, provenance: 'estimated' },
    });
    expect(result.totalTokens).toEqual({ value: 20, provenance: 'estimated' });
  });

  test('composeAgentPrompt sums its sections into a computed total', async () => {
    const compose = composeAgentPrompt<undefined>([
      { name: 'a', stability: 'stable', render: () => 'aaa' },
      { name: 'b', stability: 'dynamic', render: () => 'bbb' },
    ]);
    const composed = await compose({
      context: undefined,
      signal: AbortSignal.any([]),
      estimateFallback: () => ({ value: 7, provenance: 'measured' }),
    });
    expect(composed.instructionTokens).toEqual({ value: 14, provenance: 'computed' });
  });
});

describe('a bad estimator does not reach the window arithmetic', () => {
  const compose = composeAgentPrompt<undefined>([
    { name: 'a', stability: 'stable', render: () => 'aaa' },
  ]);

  test('a fractional section estimate is refused', async () => {
    await expect(
      compose({
        context: undefined,
        signal: AbortSignal.any([]),
        estimateFallback: () => ({ value: 3.5, provenance: 'estimated' }),
      }),
    ).rejects.toThrow();
  });

  test('a fractional section estimateTokens hook is refused', async () => {
    const withHook = composeAgentPrompt<undefined>([
      {
        name: 'a',
        stability: 'stable',
        render: () => 'aaa',
        estimateTokens: () => ({ value: 1.25, provenance: 'measured' }),
      },
    ]);
    await expect(
      withHook({ context: undefined, signal: AbortSignal.any([]) }),
    ).rejects.toThrow();
  });

  test('a fractional budget reservation is refused', async () => {
    await expect(
      compose({
        context: undefined,
        signal: AbortSignal.any([]),
        estimateFallback: () => ({ value: 7, provenance: 'measured' }),
        budget: {
          contextWindow: 1_000,
          reservedOutput: 100,
          toolSchemas: { value: 12.5, provenance: 'measured' },
          attachments: { value: 0, provenance: 'measured' },
          providerOverhead: { value: 0, provenance: 'measured' },
        },
      }),
    ).rejects.toThrow();
  });

  test('a fractional context window is refused', async () => {
    await expect(
      compose({
        context: undefined,
        signal: AbortSignal.any([]),
        estimateFallback: () => ({ value: 7, provenance: 'measured' }),
        budget: {
          contextWindow: 1_000.5,
          reservedOutput: 100,
          toolSchemas: { value: 0, provenance: 'measured' },
          attachments: { value: 0, provenance: 'measured' },
          providerOverhead: { value: 0, provenance: 'measured' },
        },
      }),
    ).rejects.toThrow();
  });
});
