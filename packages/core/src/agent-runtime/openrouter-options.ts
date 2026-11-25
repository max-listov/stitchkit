import type { OpenRouterChatSettings } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { isRecord } from '../internal/typed';

/** `reasoning.effort`; `max` is newer than the SDK's type and travels in the raw body. */
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

const Usd = z.number().nonnegative().finite();

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

/**
 * Everything a request to one OpenRouter model needs beyond the prompt. `sessionId`
 * keeps a conversation on one upstream (prompt caches); `provider.order` names the
 * upstreams outright — the two decide the same thing, so a policy names one.
 * `looseTools` sends tool and response schemas with `strict: false`, for upstreams
 * whose strict mode rejects ordinary JSON Schema.
 */
export const OpenRouterRequestPolicySchema = z
  .strictObject({
    sessionId: z.string().min(1).max(256).optional(),
    reasoning: z
      .strictObject({
        effort: OpenRouterReasoningEffortSchema,
        exclude: z.boolean().optional(),
      })
      .optional(),
    provider: OpenRouterProviderRoutingSchema.optional(),
    maxPrice: OpenRouterMaxPriceSchema.optional(),
    looseTools: z.boolean().optional(),
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

/** The policy as `@openrouter/ai-sdk-provider` chat settings, with `usage` accounting on. */
export function buildOpenRouterChatSettings(
  raw: OpenRouterRequestPolicy,
): OpenRouterChatSettings {
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
          ...(maxPrice && { max_price: maxPrice }),
        }
      : undefined;
  const reasoning = policy.reasoning;
  // `max` is not in the SDK's union: the whole reasoning object goes in the raw body,
  // where the SDK does not touch it, rather than half in settings and half outside.
  const rawReasoning =
    reasoning?.effort === 'max'
      ? {
          reasoning: {
            effort: 'max',
            ...(reasoning.exclude !== undefined && { exclude: reasoning.exclude }),
          },
        }
      : undefined;
  const extraBody = {
    ...rawReasoning,
    ...(policy.sessionId !== undefined && { session_id: policy.sessionId }),
  };
  return {
    usage: { include: true },
    ...(provider && { provider }),
    ...(reasoning &&
      reasoning.effort !== 'max' && {
        reasoning: {
          effort: reasoning.effort,
          ...(reasoning.exclude !== undefined && { exclude: reasoning.exclude }),
        },
      }),
    ...(Object.keys(extraBody).length > 0 && { extraBody }),
    ...(policy.looseTools && { structuredOutputs: { strict: false } }),
  };
}

/**
 * A chat-completions body with every function tool marked `strict: false`: the SDK does
 * not serialize a tool's `strict`, so `looseTools` can only be delivered on the wire.
 */
export function withOpenRouterLooseTools(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.tools)) return body;
  return {
    ...body,
    tools: body.tools.map((tool: unknown) =>
      isRecord(tool) && tool.type === 'function' && isRecord(tool.function)
        ? { ...tool, function: { ...tool.function, strict: false } }
        : tool,
    ),
  };
}

/**
 * Rewrite a chat-completions body on its way out: `rewrite` gets the parsed body
 * and returns the one to send. Bodies that are not JSON text pass unchanged.
 */
export function rewriteOpenRouterBodyFetch(
  inner: typeof fetch,
  rewrite: (body: unknown) => unknown,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fromRequest = input instanceof Request && init?.body === undefined;
    const text = fromRequest ? await input.clone().text() : init?.body;
    if (typeof text !== 'string' || text.length === 0) return inner(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return inner(input, init);
    }
    const body = JSON.stringify(rewrite(parsed));
    if (fromRequest) return inner(new Request(input, { body }), init);
    return inner(input, { ...init, body });
  };
  // `typeof fetch` carries the runtime's extras (Bun's `preconnect`); keep the inner one's.
  return Object.assign(wrapped, { preconnect: inner.preconnect });
}
