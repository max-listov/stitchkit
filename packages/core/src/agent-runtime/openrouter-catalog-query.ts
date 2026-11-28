import { z } from 'zod';
import type {
  OpenRouterCatalogSnapshot,
  OpenRouterEndpoint,
  OpenRouterSnapshotModel,
} from './openrouter-catalog';

const Price = z.number().nonnegative();
const NonNegativeMetric = z.number().nonnegative();
const Percentage = z.number().min(0).max(100);

/** Worst-case per-unit pricing ceiling across base pricing and any conditional pricing tiers. */
export const OpenRouterModelPricingCeilingSchema = z.strictObject({
  promptUsdPerMillion: Price.optional(),
  completionUsdPerMillion: Price.optional(),
  requestUsd: Price.optional(),
});
/** Worst-case pricing ceiling inferred from `OpenRouterModelPricingCeilingSchema`. */
export type OpenRouterModelPricingCeiling = z.infer<
  typeof OpenRouterModelPricingCeilingSchema
>;

/** Aggregated telemetry summary across a model's upstream endpoints. */
export const OpenRouterEndpointSummarySchema = z.strictObject({
  providers: z.int().nonnegative(),
  latencyP50Ms: NonNegativeMetric.optional(),
  throughputP50: NonNegativeMetric.optional(),
  uptime1d: Percentage.optional(),
});
/** Aggregated endpoint telemetry summary inferred from `OpenRouterEndpointSummarySchema`. */
export type OpenRouterEndpointSummary = z.infer<typeof OpenRouterEndpointSummarySchema>;

/** Filter criteria for querying models from an {@link OpenRouterCatalogSnapshot}. */
export interface OpenRouterModelFilter {
  /** Require (`true`) or exclude (`false`) models supporting `tools`. */
  readonly tools?: boolean;
  /** Require (`true`) or exclude (`false`) models supporting `reasoning`, `include_reasoning`, or reasoning efforts. */
  readonly reasoning?: boolean;
  /** Every listed input modality must be present on the model. */
  readonly inputModalities?: readonly string[];
  /** Every listed output modality must be present on the model. */
  readonly outputModalities?: readonly string[];
  /** Minimum effective context length (`min(contextLength, topProviderContextLength)` when both are defined); models without a known context length are excluded. */
  readonly minContextLength?: number;
  /** Maximum prompt price (USD per million tokens); models without a known prompt price are excluded. */
  readonly maxPromptUsdPerMillion?: number;
  /** Maximum completion price (USD per million tokens); models without a known completion price are excluded. */
  readonly maxCompletionUsdPerMillion?: number;
  /** When `true`, keep only models with known zero pricing across all base and conditional charges. */
  readonly freeOnly?: boolean;
  /** Exact author prefix before `/` in `model.id` (case-insensitive). */
  readonly author?: string;
}

/** Return `min(contextLength, topProviderContextLength)` when both are defined, whichever is defined, or `undefined`. */
export function effectiveContextLength(model: OpenRouterSnapshotModel): number | undefined {
  if (model.contextLength !== undefined && model.topProviderContextLength !== undefined) {
    return Math.min(model.contextLength, model.topProviderContextLength);
  }
  return model.contextLength ?? model.topProviderContextLength;
}

/** Summarize distinct provider count and best observed latency, throughput and uptime across endpoints. */
export function summarizeOpenRouterEndpoints(
  endpoints: readonly OpenRouterEndpoint[],
): OpenRouterEndpointSummary {
  const providers = new Set<string>();
  let latencyP50Ms: number | undefined;
  let throughputP50: number | undefined;
  let uptime1d: number | undefined;
  for (const endpoint of endpoints) {
    providers.add(endpoint.provider);
    if (endpoint.latencyP50Ms !== undefined) {
      latencyP50Ms =
        latencyP50Ms === undefined
          ? endpoint.latencyP50Ms
          : Math.min(latencyP50Ms, endpoint.latencyP50Ms);
    }
    if (endpoint.throughputP50 !== undefined) {
      throughputP50 =
        throughputP50 === undefined
          ? endpoint.throughputP50
          : Math.max(throughputP50, endpoint.throughputP50);
    }
    if (endpoint.uptime1d !== undefined) {
      uptime1d =
        uptime1d === undefined ? endpoint.uptime1d : Math.max(uptime1d, endpoint.uptime1d);
    }
  }
  return {
    providers: providers.size,
    ...(latencyP50Ms !== undefined && { latencyP50Ms }),
    ...(throughputP50 !== undefined && { throughputP50 }),
    ...(uptime1d !== undefined && { uptime1d }),
  };
}

/**
 * Compute worst-case per-unit pricing ceilings across base pricing and any conditional tiers.
 * Partial overrides inherit untouched sides from base pricing, whereas explicitly unknown keys
 * (`null`, `"-1"`, invalid) or unverified overrides refuse the affected ceiling side (`undefined`).
 */
export function resolveOpenRouterModelCeiling(
  model: OpenRouterSnapshotModel,
): OpenRouterModelPricingCeiling {
  if (model.hasUnverifiedPricingOverrides === true) return {};
  const tiers = model.pricingTiers ?? [];
  const conditionalCeiling = model.conditionalPricingCeiling;
  const conditional =
    model.hasConditionalPricing === true ||
    tiers.length > 0 ||
    conditionalCeiling !== undefined;
  if (conditional && tiers.length === 0 && conditionalCeiling === undefined) return {};

  const unknown = new Set<string>(model.unknownPricingFields ?? []);
  for (const tier of tiers) {
    for (const field of tier.unknownPricingFields ?? []) unknown.add(field);
  }

  let promptCeiling: number | undefined;
  if (
    model.promptUsdPerMillion !== undefined &&
    !unknown.has('prompt') &&
    !unknown.has('cacheWrite') &&
    !unknown.has('cacheWrite1h')
  ) {
    let current = Math.max(
      model.promptUsdPerMillion,
      model.cacheWriteUsdPerMillion ?? model.promptUsdPerMillion,
      model.cacheWrite1hUsdPerMillion ?? model.promptUsdPerMillion,
    );
    for (const tier of tiers) {
      if (tier.promptUsdPerMillion !== undefined) {
        current = Math.max(current, tier.promptUsdPerMillion);
      }
      if (tier.cacheWriteUsdPerMillion !== undefined) {
        current = Math.max(current, tier.cacheWriteUsdPerMillion);
      }
      if (tier.cacheWrite1hUsdPerMillion !== undefined) {
        current = Math.max(current, tier.cacheWrite1hUsdPerMillion);
      }
    }
    if (conditionalCeiling !== undefined) {
      if (conditionalCeiling.promptUsdPerMillion !== undefined) {
        current = Math.max(current, conditionalCeiling.promptUsdPerMillion);
      }
      if (conditionalCeiling.cacheWriteUsdPerMillion !== undefined) {
        current = Math.max(current, conditionalCeiling.cacheWriteUsdPerMillion);
      }
      if (conditionalCeiling.cacheWrite1hUsdPerMillion !== undefined) {
        current = Math.max(current, conditionalCeiling.cacheWrite1hUsdPerMillion);
      }
    }
    promptCeiling = current;
  }

  let completionCeiling: number | undefined;
  if (model.completionUsdPerMillion !== undefined && !unknown.has('completion')) {
    let current = model.completionUsdPerMillion;
    for (const tier of tiers) {
      if (tier.completionUsdPerMillion !== undefined) {
        current = Math.max(current, tier.completionUsdPerMillion);
      }
    }
    if (conditionalCeiling?.completionUsdPerMillion !== undefined) {
      current = Math.max(current, conditionalCeiling.completionUsdPerMillion);
    }
    completionCeiling = current;
  }

  let requestCeiling: number | undefined;
  if (!unknown.has('request')) {
    let current = model.requestUsd;
    for (const tier of tiers) {
      if (tier.requestUsd !== undefined) {
        current = current === undefined ? tier.requestUsd : Math.max(current, tier.requestUsd);
      }
    }
    if (conditionalCeiling?.requestUsd !== undefined) {
      current =
        current === undefined
          ? conditionalCeiling.requestUsd
          : Math.max(current, conditionalCeiling.requestUsd);
    }
    requestCeiling = current;
  }

  return {
    ...(promptCeiling !== undefined && { promptUsdPerMillion: promptCeiling }),
    ...(completionCeiling !== undefined && { completionUsdPerMillion: completionCeiling }),
    ...(requestCeiling !== undefined && { requestUsd: requestCeiling }),
  };
}

function hasNonZeroRate(rates: {
  readonly promptUsdPerMillion?: number | undefined;
  readonly completionUsdPerMillion?: number | undefined;
  readonly cacheReadUsdPerMillion?: number | undefined;
  readonly cacheWriteUsdPerMillion?: number | undefined;
  readonly cacheWrite1hUsdPerMillion?: number | undefined;
  readonly requestUsd?: number | undefined;
  readonly imageUsd?: number | undefined;
}): boolean {
  return (
    (rates.promptUsdPerMillion ?? 0) > 0 ||
    (rates.completionUsdPerMillion ?? 0) > 0 ||
    (rates.cacheReadUsdPerMillion ?? 0) > 0 ||
    (rates.cacheWriteUsdPerMillion ?? 0) > 0 ||
    (rates.cacheWrite1hUsdPerMillion ?? 0) > 0 ||
    (rates.requestUsd ?? 0) > 0 ||
    (rates.imageUsd ?? 0) > 0
  );
}

function isFreeModel(model: OpenRouterSnapshotModel): boolean {
  if (model.promptUsdPerMillion !== 0 || model.completionUsdPerMillion !== 0) return false;
  if ((model.unknownPricingFields?.length ?? 0) > 0) return false;
  if (hasNonZeroRate(model)) return false;

  const tiers = model.pricingTiers ?? [];
  const conditionalCeiling = model.conditionalPricingCeiling;
  const hasConditional =
    model.hasConditionalPricing === true ||
    tiers.length > 0 ||
    conditionalCeiling !== undefined ||
    model.hasUnverifiedPricingOverrides === true;

  if (!hasConditional) return true;
  if (model.hasUnverifiedPricingOverrides === true) return false;
  if (tiers.length === 0 && conditionalCeiling === undefined) return false;

  for (const tier of tiers) {
    if ((tier.unknownPricingFields?.length ?? 0) > 0 || hasNonZeroRate(tier)) return false;
  }
  if (conditionalCeiling !== undefined && hasNonZeroRate(conditionalCeiling)) return false;

  const ceiling = resolveOpenRouterModelCeiling(model);
  return (
    ceiling.promptUsdPerMillion === 0 &&
    ceiling.completionUsdPerMillion === 0 &&
    (ceiling.requestUsd ?? 0) === 0
  );
}

/** Validate numeric thresholds in an {@link OpenRouterModelFilter}, throwing `RangeError` on invalid values. */
export function validateOpenRouterModelFilter(
  filter: OpenRouterModelFilter | undefined,
): void {
  if (!filter) return;
  const checks: readonly (readonly [string, number | undefined])[] = [
    ['minContextLength', filter.minContextLength],
    ['maxPromptUsdPerMillion', filter.maxPromptUsdPerMillion],
    ['maxCompletionUsdPerMillion', filter.maxCompletionUsdPerMillion],
  ];
  for (const [name, value] of checks) {
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative finite number`);
    }
  }
}

function matchesFilter(
  model: OpenRouterSnapshotModel,
  filter: OpenRouterModelFilter,
): boolean {
  if (
    filter.tools !== undefined &&
    model.supportedParameters.includes('tools') !== filter.tools
  ) {
    return false;
  }
  if (filter.reasoning !== undefined) {
    const supportsReasoning =
      model.supportedParameters.includes('reasoning') ||
      model.supportedParameters.includes('include_reasoning') ||
      (model.reasoning !== undefined &&
        (model.reasoning.supportedEfforts.length > 0 ||
          model.reasoning.defaultEffort !== undefined));
    if (supportsReasoning !== filter.reasoning) return false;
  }
  if (
    filter.inputModalities !== undefined &&
    !filter.inputModalities.every((modality) => model.inputModalities.includes(modality))
  ) {
    return false;
  }
  if (filter.outputModalities !== undefined && filter.outputModalities.length > 0) {
    if (
      model.outputModalities === undefined ||
      !filter.outputModalities.every((modality) => model.outputModalities?.includes(modality))
    ) {
      return false;
    }
  }
  if (filter.minContextLength !== undefined) {
    const contextLength = effectiveContextLength(model);
    if (contextLength === undefined || !(contextLength >= filter.minContextLength))
      return false;
  }
  if (
    filter.maxPromptUsdPerMillion !== undefined &&
    (model.promptUsdPerMillion === undefined ||
      !(model.promptUsdPerMillion <= filter.maxPromptUsdPerMillion))
  ) {
    return false;
  }
  if (
    filter.maxCompletionUsdPerMillion !== undefined &&
    (model.completionUsdPerMillion === undefined ||
      !(model.completionUsdPerMillion <= filter.maxCompletionUsdPerMillion))
  ) {
    return false;
  }
  if (filter.freeOnly === true && !isFreeModel(model)) return false;
  if (filter.author !== undefined) {
    const slash = model.id.indexOf('/');
    const author = slash === -1 ? '' : model.id.slice(0, slash);
    if (author.toLowerCase() !== filter.author.trim().toLowerCase()) return false;
  }
  return true;
}

/** Find a model in a catalog snapshot by exact `id`, falling back to exact `canonicalSlug`. */
export function findOpenRouterModel(
  snapshot: OpenRouterCatalogSnapshot,
  idOrSlug: string,
): OpenRouterSnapshotModel | undefined {
  return (
    snapshot.models.find((model) => model.id === idOrSlug) ??
    snapshot.models.find((model) => model.canonicalSlug === idOrSlug)
  );
}

/** List models in a catalog snapshot matching all provided filter criteria. */
export function listOpenRouterModels(
  snapshot: OpenRouterCatalogSnapshot,
  filter?: OpenRouterModelFilter,
): OpenRouterSnapshotModel[] {
  validateOpenRouterModelFilter(filter);
  if (!filter) return [...snapshot.models];
  return snapshot.models.filter((model) => matchesFilter(model, filter));
}
