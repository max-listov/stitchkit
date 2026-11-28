import { z } from 'zod';
import {
  type AgentCacheControl,
  AgentCacheControlSchema,
  type AgentModelProviderOptions,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import { assertNoExtraBodyClash, recordField } from './provider-http';

/** Request keys owned by the OpenRouter policy or protocol; `extraBody` cannot silently shadow them. */
export const OPENROUTER_POLICY_KEYS = [
  'provider',
  'reasoning',
  'session_id',
  'usage',
  'cache_control',
  'model',
  'stream',
  'messages',
  'response_format',
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'stop',
] as const;

/** `reasoning.effort` levels supported by OpenRouter, including `max`. */
export const OpenRouterReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
/** Reasoning effort level inferred from `OpenRouterReasoningEffortSchema`. */
export type OpenRouterReasoningEffort = z.infer<typeof OpenRouterReasoningEffortSchema>;

const Usd = z.number().nonnegative();

/** The most this request may cost; OpenRouter routes only to endpoints under it. */
export const OpenRouterMaxPriceSchema = z.strictObject({
  promptUsdPerMillion: Usd.optional(),
  completionUsdPerMillion: Usd.optional(),
  requestUsd: Usd.optional(),
  imageUsd: Usd.optional(),
});
/** Maximum per-request price ceiling inferred from `OpenRouterMaxPriceSchema`. */
export type OpenRouterMaxPrice = z.infer<typeof OpenRouterMaxPriceSchema>;

const Slug = z.string().min(1).max(128);

/** OpenRouter's provider routing, as the application states it. */
export const OpenRouterProviderRoutingSchema = z.strictObject({
  order: z.array(Slug).min(1).optional(),
  only: z.array(Slug).min(1).optional(),
  ignore: z.array(Slug).min(1).optional(),
  allowFallbacks: z.boolean().optional(),
  requireParameters: z.boolean().optional(),
  dataCollection: z.enum(['allow', 'deny']).optional(),
  zdr: z.boolean().optional(),
  sort: z.enum(['price', 'throughput', 'latency']).optional(),
  /** Only upstreams serving one of these weight formats (`fp8`, `bf16`, …). */
  quantizations: z.array(z.string().min(1).max(16)).min(1).optional(),
});
/** Upstream provider routing preferences inferred from `OpenRouterProviderRoutingSchema`. */
export type OpenRouterProviderRouting = z.infer<typeof OpenRouterProviderRoutingSchema>;

const OpenRouterReasoningPolicySchema = z
  .strictObject({
    effort: OpenRouterReasoningEffortSchema.optional(),
    maxTokens: z.int().positive().optional(),
    enabled: z.boolean().optional(),
    exclude: z.boolean().optional(),
  })
  .superRefine((reasoning, context) => {
    if (reasoning.effort !== undefined && reasoning.maxTokens !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['maxTokens'],
        message: 'Specify reasoning.effort or reasoning.maxTokens, not both',
      });
    }
    if (
      reasoning.effort === undefined &&
      reasoning.maxTokens === undefined &&
      reasoning.enabled === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message:
          'Specify at least one of reasoning.effort, reasoning.maxTokens, or reasoning.enabled',
      });
    }
  });

/**
 * Everything a request to one OpenRouter model needs beyond the prompt. `sessionId`
 * keeps a conversation on one upstream (prompt caches); `provider.order` names the
 * upstreams outright — the two decide the same thing, so a policy names one.
 * `looseTools` sends function tool schemas with `strict: false`, for upstreams
 * whose strict mode rejects ordinary JSON Schema.
 */
export const OpenRouterRequestPolicySchema = z
  .strictObject({
    sessionId: z.string().min(1).max(256).optional(),
    reasoning: OpenRouterReasoningPolicySchema.optional(),
    provider: OpenRouterProviderRoutingSchema.optional(),
    maxPrice: OpenRouterMaxPriceSchema.optional(),
    looseTools: z.boolean().optional(),
    cacheControl: AgentCacheControlSchema.optional(),
  })
  .superRefine((policy, context) => {
    if (policy.sessionId !== undefined && policy.provider?.order !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['provider', 'order'],
        message: 'A request pins its route by sessionId or by provider.order, not both',
      });
  });
/** OpenRouter request policy inferred from `OpenRouterRequestPolicySchema`. */
export type OpenRouterRequestPolicy = z.infer<typeof OpenRouterRequestPolicySchema>;

export interface OpenRouterWireReasoning {
  readonly effort?: OpenRouterReasoningEffort;
  readonly max_tokens?: number;
  readonly enabled?: boolean;
  readonly exclude?: boolean;
}

export interface OpenRouterWirePolicy {
  readonly provider?: Record<string, unknown>;
  readonly reasoning?: OpenRouterWireReasoning;
  readonly sessionId?: string;
  readonly looseTools: boolean;
  readonly cacheControl?: AgentCacheControl;
}

/** Validate and project `OpenRouterRequestPolicy` into OpenRouter wire fields. */
export function resolveOpenRouterWirePolicy(
  raw: OpenRouterRequestPolicy,
): OpenRouterWirePolicy {
  const policy = OpenRouterRequestPolicySchema.parse(raw);
  const routing = policy.provider;
  const price = policy.maxPrice;
  const maxPrice = price && {
    ...(price.promptUsdPerMillion !== undefined && { prompt: price.promptUsdPerMillion }),
    ...(price.completionUsdPerMillion !== undefined && {
      completion: price.completionUsdPerMillion,
    }),
    ...(price.requestUsd !== undefined && { request: price.requestUsd }),
    ...(price.imageUsd !== undefined && { image: price.imageUsd }),
  };
  const provider =
    routing || maxPrice
      ? {
          ...(routing?.order && { order: routing.order }),
          ...(routing?.only && { only: routing.only }),
          ...(routing?.ignore && { ignore: routing.ignore }),
          ...(routing?.allowFallbacks !== undefined && {
            allow_fallbacks: routing.allowFallbacks,
          }),
          ...(routing?.requireParameters !== undefined && {
            require_parameters: routing.requireParameters,
          }),
          ...(routing?.dataCollection && { data_collection: routing.dataCollection }),
          ...(routing?.zdr !== undefined && { zdr: routing.zdr }),
          ...(routing?.sort && { sort: routing.sort }),
          ...(routing?.quantizations && { quantizations: routing.quantizations }),
          ...(maxPrice && Object.keys(maxPrice).length > 0 && { max_price: maxPrice }),
        }
      : undefined;

  return {
    ...(provider && Object.keys(provider).length > 0 && { provider }),
    ...(policy.reasoning && {
      reasoning: {
        ...(policy.reasoning.effort !== undefined && { effort: policy.reasoning.effort }),
        ...(policy.reasoning.maxTokens !== undefined && {
          max_tokens: policy.reasoning.maxTokens,
        }),
        ...(policy.reasoning.enabled !== undefined && { enabled: policy.reasoning.enabled }),
        ...(policy.reasoning.exclude !== undefined && { exclude: policy.reasoning.exclude }),
      },
    }),
    ...(policy.sessionId !== undefined && { sessionId: policy.sessionId }),
    looseTools: policy.looseTools === true,
    ...(policy.cacheControl !== undefined && { cacheControl: policy.cacheControl }),
  };
}

export interface MergedOpenRouterStepPolicy {
  readonly provider?: Record<string, unknown>;
  readonly reasoning?: OpenRouterWireReasoning;
  readonly stepSessionId?: string;
  readonly baseSessionId?: string;
  readonly looseTools: boolean;
  readonly explicitCacheControl?: AgentCacheControl;
  readonly baseCacheControl?: AgentCacheControl;
  readonly stepExtraBody?: Readonly<Record<string, unknown>>;
}

/**
 * Parse per-step `providerOptions.openrouter` through `OpenRouterRequestPolicySchema` +
 * `resolveOpenRouterWirePolicy` (separating explicit `extraBody` pass-through) and merge
 * cleanly with the model's resolved `OpenRouterWirePolicy`.
 */
export function mergeOpenRouterStepPolicy(
  base: OpenRouterWirePolicy,
  providerOptions: AgentModelProviderOptions | undefined,
): MergedOpenRouterStepPolicy {
  const reqOr = recordField(providerOptions, 'openrouter');
  if (!reqOr || Object.keys(reqOr).length === 0) {
    return {
      ...(base.provider !== undefined && { provider: base.provider }),
      ...(base.reasoning !== undefined && { reasoning: base.reasoning }),
      ...(base.sessionId !== undefined && { baseSessionId: base.sessionId }),
      looseTools: base.looseTools,
      ...(base.cacheControl !== undefined && { baseCacheControl: base.cacheControl }),
    };
  }

  let stepExtraBody: Record<string, unknown> | undefined;
  const policyInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(reqOr)) {
    if (key === 'extraBody') {
      if (value !== undefined) {
        if (!isRecord(value)) {
          throw new TypeError(
            'openRouterProvider: providerOptions.openrouter.extraBody must be a plain object',
          );
        }
        assertNoExtraBodyClash('openRouterProvider', value, OPENROUTER_POLICY_KEYS);
        stepExtraBody = value;
      }
      continue;
    }
    policyInput[key] = value;
  }

  const parsedStep = OpenRouterRequestPolicySchema.parse(policyInput);
  const stepWire = resolveOpenRouterWirePolicy(parsedStep);

  let mergedProvider: Record<string, unknown> | undefined;
  if (base.provider || stepWire.provider) {
    // Explicit step `sessionId` supersedes inherited `defaultPolicy.provider.order` (I9).
    const baseProvider =
      stepWire.sessionId !== undefined && base.provider
        ? Object.fromEntries(Object.entries(base.provider).filter(([k]) => k !== 'order'))
        : base.provider;
    const baseMaxPrice = isRecord(baseProvider?.max_price) ? baseProvider.max_price : null;
    const stepMaxPrice = isRecord(stepWire.provider?.max_price)
      ? stepWire.provider.max_price
      : null;
    const combined: Record<string, unknown> = {
      ...baseProvider,
      ...stepWire.provider,
      ...(baseMaxPrice && stepMaxPrice && { max_price: { ...baseMaxPrice, ...stepMaxPrice } }),
    };
    if (Object.keys(combined).length > 0) mergedProvider = combined;
  }

  return {
    ...(mergedProvider !== undefined && { provider: mergedProvider }),
    ...((stepWire.reasoning ?? base.reasoning) !== undefined && {
      reasoning: stepWire.reasoning ?? base.reasoning,
    }),
    ...(stepWire.sessionId !== undefined && { stepSessionId: stepWire.sessionId }),
    ...(base.sessionId !== undefined && { baseSessionId: base.sessionId }),
    looseTools: parsedStep.looseTools !== undefined ? stepWire.looseTools : base.looseTools,
    ...(stepWire.cacheControl !== undefined && {
      explicitCacheControl: stepWire.cacheControl,
    }),
    ...(base.cacheControl !== undefined && { baseCacheControl: base.cacheControl }),
    ...(stepExtraBody !== undefined && { stepExtraBody }),
  };
}
