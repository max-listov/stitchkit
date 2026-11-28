import { z } from 'zod';
import {
  type OpenRouterCatalogSnapshot,
  OpenRouterCatalogSnapshotSchema,
  type OpenRouterSnapshotModel,
} from './openrouter-catalog';
import {
  effectiveContextLength,
  resolveOpenRouterModelCeiling,
} from './openrouter-catalog-query';

const Usd = z.number().nonnegative();

/**
 * What a model must show in the snapshot to be used. Free of roles: which model a
 * role gets is the application's; whether that model can be trusted with it is this.
 */
export const OpenRouterAdmissionPolicySchema = z.strictObject({
  /** A snapshot older than this cannot admit; its models are `unverified`. */
  maxSnapshotAgeMs: z.int().positive(),
  /** Request parameters every admitted model supports (`tools`, `reasoning`, …). */
  requiredParameters: z.array(z.string().min(1)).default([]),
  /** Input modalities every admitted model accepts (`image` for a vision role). */
  requiredInputModalities: z.array(z.string().min(1)).default([]),
  minContextLength: z.int().nonnegative().optional(),
  maxPromptUsdPerMillion: Usd.optional(),
  maxCompletionUsdPerMillion: Usd.optional(),
  /** Require a known endpoint list with at least one upstream up (`status` 0 or absent). */
  requireLiveEndpoint: z.boolean().default(false),
});
/** Model admission policy input inferred from `OpenRouterAdmissionPolicySchema`. */
export type OpenRouterAdmissionPolicy = z.input<typeof OpenRouterAdmissionPolicySchema>;

/** Why a model was not admitted. */
export const OpenRouterAdmissionReasonSchema = z.enum([
  'floating-alias',
  'unknown-model',
  'stale-snapshot',
  'missing-parameter',
  'missing-modality',
  'context-unknown',
  'context-too-small',
  'price-unknown',
  'over-price',
  'no-live-endpoint',
  'endpoints-unknown',
]);
/** Model non-admission reason code inferred from `OpenRouterAdmissionReasonSchema`. */
export type OpenRouterAdmissionReason = z.infer<typeof OpenRouterAdmissionReasonSchema>;

/**
 * `admitted` — the snapshot shows the model meets the policy; `unverified` — the
 * snapshot cannot say (stale, a price or an endpoint list unknown); `rejected` —
 * it says no, or the id is one whose target can change under the caller. A
 * schema, so a stored decision reads back as one.
 */
export const OpenRouterModelAdmissionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('admitted') }),
  z.strictObject({
    state: z.literal('unverified'),
    reason: OpenRouterAdmissionReasonSchema,
    detail: z.string(),
  }),
  z.strictObject({
    state: z.literal('rejected'),
    reason: OpenRouterAdmissionReasonSchema,
    detail: z.string(),
  }),
]);
/** Model admission evaluation result inferred from `OpenRouterModelAdmissionSchema`. */
export type OpenRouterModelAdmission = z.infer<typeof OpenRouterModelAdmissionSchema>;

/** Ids whose meaning moves: `~author/…` routers, `-latest`, `:batch`, `stealth/…`. */
function floatingAlias(modelId: string): string | undefined {
  if (modelId.startsWith('~')) return 'a `~` router id follows whatever its author routes to';
  if (modelId === 'openrouter/auto')
    return '`openrouter/auto` picks a different model per request';
  if (/-latest(?:$|:)/.test(modelId)) return 'a `-latest` id changes model without notice';
  if (modelId.endsWith(':batch')) return 'a `:batch` variant is not an interactive model';
  if (modelId.startsWith('stealth/')) return 'a `stealth/` model has no stated identity';
  return undefined;
}

function highestObservedPrice(
  model: OpenRouterSnapshotModel,
  side: 'prompt' | 'completion',
): number | undefined {
  const values: number[] = [];
  const add = (value: number | undefined): void => {
    if (value !== undefined) values.push(value);
  };
  if (side === 'prompt') {
    add(model.promptUsdPerMillion);
    add(model.cacheWriteUsdPerMillion);
    add(model.cacheWrite1hUsdPerMillion);
    for (const tier of model.pricingTiers ?? []) {
      add(tier.promptUsdPerMillion);
      add(tier.cacheWriteUsdPerMillion);
      add(tier.cacheWrite1hUsdPerMillion);
    }
    add(model.conditionalPricingCeiling?.promptUsdPerMillion);
    add(model.conditionalPricingCeiling?.cacheWriteUsdPerMillion);
    add(model.conditionalPricingCeiling?.cacheWrite1hUsdPerMillion);
  } else {
    add(model.completionUsdPerMillion);
    for (const tier of model.pricingTiers ?? []) add(tier.completionUsdPerMillion);
    add(model.conditionalPricingCeiling?.completionUsdPerMillion);
  }
  return values.length > 0 ? Math.max(...values) : undefined;
}

/**
 * Every stated price is checked before an unstated one answers: a price the snapshot
 * shows over its limit rejects the model, whatever the other side leaves unknown.
 * Uses the worst-case pricing ceiling across base pricing, cache writes, and conditional overrides.
 */
function priceCheck(
  model: OpenRouterSnapshotModel,
  policy: z.output<typeof OpenRouterAdmissionPolicySchema>,
): OpenRouterModelAdmission | undefined {
  const ceiling = resolveOpenRouterModelCeiling(model);
  let unknown: OpenRouterModelAdmission | undefined;
  const checks: readonly (readonly [
    number | undefined,
    number | undefined,
    'prompt' | 'completion',
  ])[] = [
    [policy.maxPromptUsdPerMillion, ceiling.promptUsdPerMillion, 'prompt'],
    [policy.maxCompletionUsdPerMillion, ceiling.completionUsdPerMillion, 'completion'],
  ];
  for (const [limit, ceilingPrice, side] of checks) {
    if (limit === undefined) continue;
    const observed = highestObservedPrice(model, side);
    if (observed !== undefined && observed > limit) {
      return {
        state: 'rejected',
        reason: 'over-price',
        detail: `the ${side} price ${observed} USD per million exceeds ${limit}`,
      };
    }
    if (ceilingPrice === undefined) {
      unknown ??= {
        state: 'unverified',
        reason: 'price-unknown',
        detail: `the ${side} price ceiling is not stated`,
      };
    } else if (ceilingPrice > limit) {
      return {
        state: 'rejected',
        reason: 'over-price',
        detail: `the ${side} price ${ceilingPrice} USD per million exceeds ${limit}`,
      };
    }
  }
  return unknown;
}

/** Decide one model from a stored snapshot. Never a guess: what the snapshot cannot show is `unverified`. */
export function evaluateOpenRouterModelAdmission(input: {
  snapshot: OpenRouterCatalogSnapshot;
  modelId: string;
  policy: OpenRouterAdmissionPolicy;
  now?: () => Date;
}): OpenRouterModelAdmission {
  const alias = floatingAlias(input.modelId);
  if (alias) return { state: 'rejected', reason: 'floating-alias', detail: alias };
  const snapshot = OpenRouterCatalogSnapshotSchema.parse(input.snapshot);
  const policy = OpenRouterAdmissionPolicySchema.parse(input.policy);
  const age = (input.now?.() ?? new Date()).getTime() - Date.parse(snapshot.observedAt);
  // A snapshot from the future is a wrong clock, not a fresh one.
  if (!(age >= 0 && age <= policy.maxSnapshotAgeMs))
    return {
      state: 'unverified',
      reason: 'stale-snapshot',
      detail: `the snapshot is from ${snapshot.observedAt}`,
    };
  const model = snapshot.models.find((entry) => entry.id === input.modelId);
  if (!model)
    return {
      state: 'rejected',
      reason: 'unknown-model',
      detail: `${input.modelId} is not in the catalog`,
    };
  if (model.aliasOf)
    return {
      state: 'rejected',
      reason: 'floating-alias',
      detail: `${model.id} stands for ${model.aliasOf}`,
    };
  if (model.aliasTarget)
    return {
      state: 'rejected',
      reason: 'floating-alias',
      detail: `${model.id} aliases ${model.aliasTarget.id}`,
    };
  const missing = policy.requiredParameters.filter(
    (name) => !model.supportedParameters.includes(name),
  );
  if (missing.length > 0)
    return {
      state: 'rejected',
      reason: 'missing-parameter',
      detail: `does not support ${missing.join(', ')}`,
    };
  const modalities = policy.requiredInputModalities.filter(
    (name) => !model.inputModalities.includes(name),
  );
  if (modalities.length > 0)
    return {
      state: 'rejected',
      reason: 'missing-modality',
      detail: `does not accept ${modalities.join(', ')} input`,
    };
  if (policy.minContextLength !== undefined) {
    const contextLength = effectiveContextLength(model);
    if (contextLength === undefined)
      return {
        state: 'unverified',
        reason: 'context-unknown',
        detail: 'the context length is not stated',
      };
    if (contextLength < policy.minContextLength)
      return {
        state: 'rejected',
        reason: 'context-too-small',
        detail: `context ${contextLength} is under ${policy.minContextLength}`,
      };
  }
  const price = priceCheck(model, policy);
  if (price) return price;
  if (policy.requireLiveEndpoint) {
    if (model.endpoints === undefined)
      return {
        state: 'unverified',
        reason: 'endpoints-unknown',
        detail: 'the snapshot has no endpoint list',
      };
    if (
      !model.endpoints.some(
        (endpoint) => endpoint.status === undefined || endpoint.status === 0,
      )
    )
      return { state: 'rejected', reason: 'no-live-endpoint', detail: 'no upstream is up' };
  }
  return { state: 'admitted' };
}
