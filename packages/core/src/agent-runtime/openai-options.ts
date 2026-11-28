import { z } from 'zod';
import type { AgentModelProviderOptions } from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type { AgentModelCallSettings } from './models-driver';
import { sanitizeSurrogates } from './provider-media';

const ENCRYPTED_REASONING_INCLUDE = 'reasoning.encrypted_content';
const MAX_PROMPT_CACHE_KEY_CHARS = 64;

/** Reasoning effort and summary preferences for OpenAI Responses requests. */
export const OpenAiReasoningPolicySchema = z.strictObject({
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  summary: z.enum(['auto', 'concise', 'detailed']).optional(),
});

/** Reasoning policy inferred from `OpenAiReasoningPolicySchema`. */
export type OpenAiReasoningPolicy = z.infer<typeof OpenAiReasoningPolicySchema>;

/** Per-request OpenAI Responses API policy validated before wire serialization. */
export const OpenAiRequestPolicySchema = z.strictObject({
  store: z.boolean().optional(),
  reasoning: OpenAiReasoningPolicySchema.optional(),
  serviceTier: z.enum(['auto', 'default', 'flex', 'priority']).optional(),
  truncation: z.enum(['auto', 'disabled']).optional(),
  promptCacheKey: z.string().min(1).max(64).optional(),
  promptCacheRetention: z.enum(['in-memory', '24h']).optional(),
  parallelToolCalls: z.boolean().optional(),
  strictTools: z.boolean().optional(),
  include: z.array(z.string().min(1)).optional(),
  user: z.string().min(1).max(256).optional(),
});

/** Request policy inferred from `OpenAiRequestPolicySchema`. */
export type OpenAiRequestPolicy = z.infer<typeof OpenAiRequestPolicySchema>;

/** Normalized internal policy with stateless and loose-tool defaults materialized. */
export interface ResolvedOpenAiPolicy {
  readonly store: boolean;
  readonly reasoning?: OpenAiReasoningPolicy;
  readonly serviceTier?: OpenAiRequestPolicy['serviceTier'];
  readonly truncation?: OpenAiRequestPolicy['truncation'];
  readonly promptCacheKey?: string;
  readonly promptCacheRetention?: OpenAiRequestPolicy['promptCacheRetention'];
  readonly parallelToolCalls?: boolean;
  readonly strictTools: boolean;
  readonly include: readonly string[];
  readonly user?: string;
}

/**
 * Validate an `OpenAiRequestPolicy` and apply OpenAI Responses defaults:
 * stateless (`store: false`) and loose tool schemas (`strictTools: false`).
 */
export function resolveOpenAiPolicy(raw: OpenAiRequestPolicy = {}): ResolvedOpenAiPolicy {
  const policy = OpenAiRequestPolicySchema.parse(raw);
  return {
    store: policy.store ?? false,
    ...(policy.reasoning !== undefined && { reasoning: policy.reasoning }),
    ...(policy.serviceTier !== undefined && { serviceTier: policy.serviceTier }),
    ...(policy.truncation !== undefined && { truncation: policy.truncation }),
    ...(policy.promptCacheKey !== undefined && { promptCacheKey: policy.promptCacheKey }),
    ...(policy.promptCacheRetention !== undefined && {
      promptCacheRetention: policy.promptCacheRetention,
    }),
    ...(policy.parallelToolCalls !== undefined && {
      parallelToolCalls: policy.parallelToolCalls,
    }),
    strictTools: policy.strictTools ?? false,
    include: policy.include !== undefined ? [...policy.include] : [],
    ...(policy.user !== undefined && { user: policy.user }),
  };
}

/** Overlay validated per-step `providerOptions.openai` overrides onto a resolved policy. */
export function mergeOpenAiStepPolicy(
  base: ResolvedOpenAiPolicy,
  providerOptions: AgentModelProviderOptions | undefined,
): ResolvedOpenAiPolicy {
  if (!providerOptions || !isRecord(providerOptions.openai)) return base;
  if (Object.keys(providerOptions.openai).length === 0) return base;
  const override = OpenAiRequestPolicySchema.parse(providerOptions.openai);
  return resolveOpenAiPolicy({
    store: override.store ?? base.store,
    ...(override.reasoning !== undefined
      ? { reasoning: override.reasoning }
      : base.reasoning !== undefined && { reasoning: base.reasoning }),
    ...(override.serviceTier !== undefined
      ? { serviceTier: override.serviceTier }
      : base.serviceTier !== undefined && { serviceTier: base.serviceTier }),
    ...(override.truncation !== undefined
      ? { truncation: override.truncation }
      : base.truncation !== undefined && { truncation: base.truncation }),
    ...(override.promptCacheKey !== undefined
      ? { promptCacheKey: override.promptCacheKey }
      : base.promptCacheKey !== undefined && { promptCacheKey: base.promptCacheKey }),
    ...(override.promptCacheRetention !== undefined
      ? { promptCacheRetention: override.promptCacheRetention }
      : base.promptCacheRetention !== undefined && {
          promptCacheRetention: base.promptCacheRetention,
        }),
    ...(override.parallelToolCalls !== undefined
      ? { parallelToolCalls: override.parallelToolCalls }
      : base.parallelToolCalls !== undefined && { parallelToolCalls: base.parallelToolCalls }),
    strictTools: override.strictTools ?? base.strictTools,
    ...(override.include !== undefined
      ? { include: override.include }
      : base.include.length > 0 && { include: [...base.include] }),
    ...(override.user !== undefined
      ? { user: override.user }
      : base.user !== undefined && { user: base.user }),
  });
}

/**
 * Fail fast before any HTTP call when declared `settings` cannot be honored by the
 * OpenAI Responses API (I9: never silently drop declared options).
 */
export function assertOpenAiSupportedSettings(
  settings: AgentModelCallSettings,
  policy: ResolvedOpenAiPolicy,
): void {
  const unsupported: Array<[keyof AgentModelCallSettings, unknown]> = [
    ['topK', settings.topK],
    ['presencePenalty', settings.presencePenalty],
    ['frequencyPenalty', settings.frequencyPenalty],
    ['seed', settings.seed],
    ['stopSequences', settings.stopSequences],
  ];
  for (const [name, value] of unsupported) {
    if (value !== undefined) {
      throw new TypeError(
        `openai: settings.${name} is not supported by the OpenAI Responses API`,
      );
    }
  }
  if (policy.reasoning !== undefined && policy.reasoning.effort !== 'none') {
    if (settings.temperature !== undefined) {
      throw new TypeError(
        `openai: settings.temperature cannot be set when reasoning.effort is "${policy.reasoning.effort}"`,
      );
    }
    if (settings.topP !== undefined) {
      throw new TypeError(
        `openai: settings.topP cannot be set when reasoning.effort is "${policy.reasoning.effort}"`,
      );
    }
  }
}

/** Derive a deterministic ≤ 64-char `prompt_cache_key` from a conversation identifier. */
export function deriveOpenAiPromptCacheKey(conversationId: string): string | undefined {
  const clean = sanitizeSurrogates(conversationId);
  if (clean.length === 0) return undefined;
  if (clean.length <= MAX_PROMPT_CACHE_KEY_CHARS) return clean;
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < clean.length; i += 1) {
    const code = clean.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b);
    h3 = Math.imul(h3 ^ (code * 31 + i), 0xc2b2ae35);
    h4 = Math.imul(h4 ^ ((code << 5) - code + i), 0x27d4eb2f);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return `ck_${hex(h1)}${hex(h2)}${hex(h3)}${hex(h4)}`;
}

function modelMayEmitEncryptedReasoning(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower.includes('-chat')) return false;
  return (
    /^o[134](?:$|[-._])/u.test(lower) ||
    /^gpt-5(?:$|[-._])/u.test(lower) ||
    lower.includes('codex')
  );
}

/** Resolve deduplicated `include` entries, auto-adding encrypted reasoning on stateless calls. */
export function resolveOpenAiIncludeList(
  policy: ResolvedOpenAiPolicy,
  modelId: string,
  sawOpenAiReasoning: boolean,
): string[] {
  const seen = new Set<string>();
  const include: string[] = [];
  for (const entry of policy.include) {
    if (!seen.has(entry)) {
      seen.add(entry);
      include.push(entry);
    }
  }
  const reasoningDisabled = policy.reasoning?.effort === 'none';
  const wantsEncryptedReasoning =
    policy.store === false &&
    !reasoningDisabled &&
    (policy.reasoning !== undefined ||
      sawOpenAiReasoning ||
      modelMayEmitEncryptedReasoning(modelId));
  if (wantsEncryptedReasoning && !seen.has(ENCRYPTED_REASONING_INCLUDE)) {
    include.push(ENCRYPTED_REASONING_INCLUDE);
  }
  return include;
}
