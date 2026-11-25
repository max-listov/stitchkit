import { z } from 'zod';

/**
 * How a number came to be known — one vocabulary for the whole entrypoint.
 *
 * There used to be two, and they did not share a word: a spend figure could be
 * `provider-reported` or `computed`, a prompt-budget count `measured`, and
 * neither type accepted the other's terms. A consumer holding both — and it
 * holds both for the *same request*, `AgentPromptBudget.toolSchemas` beside
 * `AgentUsage.inputTokens` — wrote two switches over one question, and the
 * difference between `measured` and `provider-reported` could not be explained
 * without reading both files.
 *
 * The words are now defined once, here, and each surface declares the subset it
 * can produce with `.extract`. No surface widened: a reader's exhaustive switch
 * still sees exactly the values that surface emits, and adding a word to the
 * vocabulary does not silently add it to a surface.
 *
 * `measured` and `provider-reported` are **not** the same fact, which is why
 * both survive:
 *
 * - `provider-reported` — the provider stated this number about a request it
 *   served. Nothing else can produce it.
 * - `measured` — this process counted it exactly, before any request was made.
 *   A tokenizer over a string is the case.
 * - `computed` — arithmetic over other values. A sum of exact numbers is still
 *   `computed`, because what a caller filtering for a billable figure wants is
 *   a number it can bill against unchanged, and a sum is not that.
 * - `estimated` — a heuristic. Not exact and not claimed to be.
 * - `unavailable` — not known. `value` is then absent, and that is a different
 *   fact from a reported zero.
 */
export const AgentProvenanceSchema = z.enum([
  'provider-reported',
  'measured',
  'computed',
  'estimated',
  'unavailable',
]);

export type AgentProvenance = z.infer<typeof AgentProvenanceSchema>;

/**
 * A token count, and how it came to be known.
 *
 * `z.int()` rather than `z.number()`: a fractional token is not a thing, and
 * accepting `3.5` is how a bad estimator's output survives validation and turns
 * up later as a context-window decision nobody can reproduce.
 */
export const AgentUsageValueSchema = z.object({
  value: z.int().nonnegative().optional(),
  provenance: AgentProvenanceSchema.extract([
    'provider-reported',
    'computed',
    'estimated',
    'unavailable',
  ]),
});

/**
 * Money, which is fractional by nature — so `value` stays `z.number()` here and
 * only here. Everything counted in tokens is an integer.
 */
export const AgentCostValueSchema = z.object({
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  provenance: AgentProvenanceSchema.extract([
    'provider-reported',
    'computed',
    'estimated',
    'unavailable',
  ]),
});

export type AgentUsageValue = z.infer<typeof AgentUsageValueSchema>;

export const AgentUsageSchema = z.object({
  inputTokens: AgentUsageValueSchema,
  outputTokens: AgentUsageValueSchema,
  reasoningTokens: AgentUsageValueSchema.optional(),
  cacheReadTokens: AgentUsageValueSchema.optional(),
  cacheWriteTokens: AgentUsageValueSchema.optional(),
  cost: AgentCostValueSchema.optional(),
});

export type AgentUsage = z.infer<typeof AgentUsageSchema>;
