import { z } from 'zod';
import { AgentCacheControlSchema, type AgentModelProviderOptions } from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import type {
  AgentModelRequest,
  AgentModelToolChoice,
  AgentModelToolSpec,
} from './models-driver';
import {
  assertValidCacheTtlOrder,
  budgetCacheBreakpoints,
  MAX_CACHE_BREAKPOINTS,
  type PlannedCacheBreakpoint,
  toWireCacheControl,
} from './provider-cache';
import { prepareAnthropicJsonSchema } from './provider-json-schema';
import { readPortableCacheControl, sanitizeSurrogates } from './provider-media';

/** Thinking mode supported by the Anthropic Messages API. */
export const AnthropicThinkingPolicySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('adaptive') }),
  z.strictObject({
    type: z.literal('enabled'),
    budgetTokens: z.int().min(1024),
  }),
  z.strictObject({ type: z.literal('disabled') }),
]);

/** Thinking policy inferred from `AnthropicThinkingPolicySchema`. */
export type AnthropicThinkingPolicy = z.infer<typeof AnthropicThinkingPolicySchema>;

const AnthropicRequestPolicyFieldsSchema = z.strictObject({
  maxOutputTokens: z.int().positive().optional(),
  thinking: AnthropicThinkingPolicySchema.optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  cacheControl: AgentCacheControlSchema.optional(),
  eagerInputStreaming: z.boolean().optional(),
  disableParallelToolUse: z.boolean().optional(),
  serviceTier: z.enum(['auto', 'standard_only']).optional(),
  betas: z.array(z.string().min(1)).optional(),
});

/** Per-model request policy for the native Anthropic Messages driver. */
export const AnthropicRequestPolicySchema = AnthropicRequestPolicyFieldsSchema.superRefine(
  (policy, context) => {
    if (
      policy.thinking?.type === 'enabled' &&
      policy.maxOutputTokens !== undefined &&
      policy.maxOutputTokens <= policy.thinking.budgetTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['thinking', 'budgetTokens'],
        message: 'maxOutputTokens must be strictly greater than thinking.budgetTokens',
      });
    }
  },
);

/** Anthropic request policy inferred from `AnthropicRequestPolicySchema`. */
export type AnthropicRequestPolicy = z.infer<typeof AnthropicRequestPolicySchema>;

/** Request keys owned by the Anthropic driver protocol or policy. */
export const ANTHROPIC_OWNED_BODY_KEYS: readonly string[] = [
  'model',
  'messages',
  'system',
  'max_tokens',
  'stream',
  'tools',
  'tool_choice',
  'thinking',
  'output_config',
  'cache_control',
  'service_tier',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
];

const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14';

/** Validate and normalize one `AnthropicRequestPolicy`. */
export function resolveAnthropicPolicy(
  raw: AnthropicRequestPolicy = {},
): AnthropicRequestPolicy {
  return AnthropicRequestPolicySchema.parse(raw);
}

/** Whether a policy turns extended or adaptive thinking on. */
export function isAnthropicThinkingEnabled(
  thinking: AnthropicThinkingPolicy | undefined,
): boolean {
  return thinking?.type === 'enabled' || thinking?.type === 'adaptive';
}

/** Merge comma-separated or array beta feature flags while preserving first-seen order. */
export function mergeAnthropicBetas(
  ...groups: readonly (readonly string[] | undefined)[]
): string | undefined {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    for (const raw of group) {
      for (const piece of raw.split(',')) {
        const trimmed = piece.trim();
        if (trimmed.length === 0 || seen.has(trimmed)) continue;
        seen.add(trimmed);
        ordered.push(trimmed);
      }
    }
  }
  return ordered.length > 0 ? ordered.join(',') : undefined;
}

/** Read the `anthropic` namespace out of `AgentModelProviderOptions`. */
export function readAnthropicProviderOptions(
  providerOptions: AgentModelProviderOptions | undefined,
): Record<string, unknown> | undefined {
  const entry = providerOptions?.anthropic;
  return isRecord(entry) ? entry : undefined;
}

/** Overlay validated per-step `providerOptions.anthropic` overrides onto a resolved policy. */
export function mergeAnthropicStepPolicy(
  base: AnthropicRequestPolicy,
  providerOptions: AgentModelProviderOptions | undefined,
  requestMaxOutputTokens?: number,
): AnthropicRequestPolicy {
  const raw = readAnthropicProviderOptions(providerOptions);
  if (!raw || Object.keys(raw).length === 0) return base;
  const override = AnthropicRequestPolicyFieldsSchema.parse(raw);
  const mergedBetas =
    base.betas !== undefined || override.betas !== undefined
      ? Array.from(new Set([...(base.betas ?? []), ...(override.betas ?? [])]))
      : undefined;
  const merged: AnthropicRequestPolicy = {
    ...(override.maxOutputTokens !== undefined
      ? { maxOutputTokens: override.maxOutputTokens }
      : base.maxOutputTokens !== undefined && { maxOutputTokens: base.maxOutputTokens }),
    ...(override.thinking !== undefined
      ? { thinking: override.thinking }
      : base.thinking !== undefined && { thinking: base.thinking }),
    ...(override.effort !== undefined
      ? { effort: override.effort }
      : base.effort !== undefined && { effort: base.effort }),
    ...(override.cacheControl !== undefined
      ? { cacheControl: override.cacheControl }
      : base.cacheControl !== undefined && { cacheControl: base.cacheControl }),
    ...(override.eagerInputStreaming !== undefined
      ? { eagerInputStreaming: override.eagerInputStreaming }
      : base.eagerInputStreaming !== undefined && {
          eagerInputStreaming: base.eagerInputStreaming,
        }),
    ...(override.disableParallelToolUse !== undefined
      ? { disableParallelToolUse: override.disableParallelToolUse }
      : base.disableParallelToolUse !== undefined && {
          disableParallelToolUse: base.disableParallelToolUse,
        }),
    ...(override.serviceTier !== undefined
      ? { serviceTier: override.serviceTier }
      : base.serviceTier !== undefined && { serviceTier: base.serviceTier }),
    ...(mergedBetas !== undefined && mergedBetas.length > 0 && { betas: mergedBetas }),
  };
  const effectiveMaxOutputTokens = requestMaxOutputTokens ?? merged.maxOutputTokens;
  if (
    merged.thinking?.type === 'enabled' &&
    effectiveMaxOutputTokens !== undefined &&
    effectiveMaxOutputTokens <= merged.thinking.budgetTokens
  ) {
    throw new TypeError(
      `anthropicProvider requires maxOutputTokens (${effectiveMaxOutputTokens}) to exceed thinking.budgetTokens (${merged.thinking.budgetTokens})`,
    );
  }
  return merged;
}

/** Fail fast on invalid or unsupported Anthropic request settings before hitting the network (I9). */
export function validateAnthropicRequest(
  request: AgentModelRequest,
  policy: AnthropicRequestPolicy,
): number {
  const maxTokens = request.settings.maxOutputTokens ?? policy.maxOutputTokens;
  if (maxTokens === undefined) {
    throw new TypeError(
      'anthropicProvider requires maxOutputTokens in request settings or policy',
    );
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError('anthropicProvider requires maxOutputTokens to be a positive integer');
  }
  if (policy.thinking?.type === 'enabled' && maxTokens <= policy.thinking.budgetTokens) {
    throw new TypeError(
      `anthropicProvider requires maxOutputTokens (${maxTokens}) to exceed thinking.budgetTokens (${policy.thinking.budgetTokens})`,
    );
  }

  const unsupported: string[] = [];
  if (request.settings.presencePenalty !== undefined) unsupported.push('presencePenalty');
  if (request.settings.frequencyPenalty !== undefined) unsupported.push('frequencyPenalty');
  if (request.settings.seed !== undefined) unsupported.push('seed');
  if (unsupported.length > 0) {
    throw new TypeError(
      `anthropicProvider does not support sampling setting(s): ${unsupported.join(', ')}`,
    );
  }

  const forcedToolChoice =
    request.toolChoice === 'required' ||
    (typeof request.toolChoice === 'object' && request.toolChoice !== null);

  if (request.settings.temperature !== undefined && request.settings.topP !== undefined) {
    throw new TypeError(
      'anthropicProvider does not allow setting both temperature and topP in the same request',
    );
  }

  if (isAnthropicThinkingEnabled(policy.thinking)) {
    if (request.settings.temperature !== undefined && request.settings.temperature !== 1) {
      throw new TypeError(
        'anthropicProvider does not allow temperature other than 1 when thinking is enabled',
      );
    }
    if (
      request.settings.topP !== undefined &&
      (request.settings.topP < 0.95 || request.settings.topP > 1)
    ) {
      throw new TypeError(
        'anthropicProvider requires topP between 0.95 and 1 when thinking is enabled',
      );
    }
    if (request.settings.topK !== undefined) {
      throw new TypeError('anthropicProvider does not allow topK when thinking is enabled');
    }
    if (forcedToolChoice) {
      throw new TypeError(
        'anthropicProvider does not allow forced toolChoice when thinking is enabled',
      );
    }
  }

  if (request.responseFormat?.type === 'json-object') {
    throw new TypeError(
      'anthropicProvider does not support schemaless json-object responseFormat; use json-schema',
    );
  }
  if (request.tools.length === 0 && forcedToolChoice) {
    throw new TypeError(
      'anthropicProvider cannot force toolChoice when no tools are provided',
    );
  }

  return maxTokens;
}

function encodeTools(
  specs: readonly AgentModelToolSpec[],
  policy: AnthropicRequestPolicy,
  plannedBreakpoints: PlannedCacheBreakpoint<Record<string, unknown>>[],
): { readonly tools: Record<string, unknown>[]; readonly eagerUsed: boolean } {
  const tools: Record<string, unknown>[] = [];
  let eagerUsed = policy.eagerInputStreaming === true;

  for (const spec of specs) {
    if (spec.type === 'provider') {
      throw new TypeError(
        `anthropicProvider: unsupported provider tool "${spec.id}" (type: "provider")`,
      );
    }
    const opts = readAnthropicProviderOptions(spec.providerOptions);
    const eager =
      policy.eagerInputStreaming === true ||
      opts?.eagerInputStreaming === true ||
      opts?.eager_input_streaming === true;
    if (eager) eagerUsed = true;
    const inputSchema =
      spec.strict === true ? prepareAnthropicJsonSchema(spec.inputSchema) : spec.inputSchema;
    const toolObj: Record<string, unknown> = {
      name: spec.name,
      ...(spec.description !== undefined && {
        description: sanitizeSurrogates(spec.description),
      }),
      input_schema: inputSchema,
      ...(spec.strict !== undefined && { strict: spec.strict }),
      ...(eager && { eager_input_streaming: true }),
    };
    tools.push(toolObj);
    const control = readPortableCacheControl(
      spec.cacheControl,
      spec.providerOptions,
      'anthropic',
    );
    if (control !== undefined) {
      plannedBreakpoints.push({ slot: 'tools', control, target: toolObj });
    }
  }

  return { tools, eagerUsed };
}

function encodeToolChoice(
  toolChoice: AgentModelToolChoice | undefined,
  hasTools: boolean,
  hasToolsField: boolean,
  disableParallel: boolean,
): Record<string, unknown> | undefined {
  if (!hasTools) {
    return hasToolsField && toolChoice === 'none' ? { type: 'none' } : undefined;
  }
  if (toolChoice === undefined) {
    return disableParallel ? { type: 'auto', disable_parallel_tool_use: true } : undefined;
  }
  if (toolChoice === 'none') return { type: 'none' };
  const parallel = disableParallel ? { disable_parallel_tool_use: true } : {};
  if (toolChoice === 'auto') return { type: 'auto', ...parallel };
  if (toolChoice === 'required') return { type: 'any', ...parallel };
  return { type: 'tool', name: toolChoice.toolName, ...parallel };
}

/**
 * Encode all policy, sampling, tool, structured-output, and cache-breakpoint fields
 * for an Anthropic `/v1/messages` request, plus the auto-enabled beta header flags.
 */
export function buildAnthropicPolicyFields(input: {
  readonly request: AgentModelRequest;
  readonly policy: AnthropicRequestPolicy;
  readonly maxTokens: number;
  readonly hasToolTraffic: boolean;
  readonly systemBreakpoints: readonly PlannedCacheBreakpoint<Record<string, unknown>>[];
  readonly messageBreakpoints: readonly PlannedCacheBreakpoint<Record<string, unknown>>[];
}): { readonly fields: Record<string, unknown>; readonly autoBetas: readonly string[] } {
  const { request, policy, maxTokens, hasToolTraffic, systemBreakpoints, messageBreakpoints } =
    input;
  const toolBreakpoints: PlannedCacheBreakpoint<Record<string, unknown>>[] = [];
  const { tools: encodedTools, eagerUsed } = encodeTools(
    request.tools,
    policy,
    toolBreakpoints,
  );

  const topLevelCacheControl = request.cacheControl ?? policy.cacheControl;
  const explicitLimit =
    topLevelCacheControl !== undefined ? MAX_CACHE_BREAKPOINTS - 1 : MAX_CACHE_BREAKPOINTS;
  const kept = budgetCacheBreakpoints(
    [...toolBreakpoints, ...systemBreakpoints, ...messageBreakpoints],
    explicitLimit,
  );
  const wireControls = [
    ...kept.map((bp) => bp.control),
    ...(topLevelCacheControl !== undefined ? [topLevelCacheControl] : []),
  ];
  assertValidCacheTtlOrder(wireControls, 'anthropicProvider');
  for (const bp of kept) {
    bp.target.cache_control = toWireCacheControl(bp.control);
  }

  const includeTools = encodedTools.length > 0 || hasToolTraffic;
  const toolChoice = encodeToolChoice(
    request.toolChoice,
    encodedTools.length > 0,
    includeTools,
    policy.disableParallelToolUse === true,
  );

  const outputConfig: Record<string, unknown> = {
    ...(policy.effort !== undefined && { effort: policy.effort }),
    ...(request.responseFormat?.type === 'json-schema' && {
      format: {
        type: 'json_schema',
        schema: prepareAnthropicJsonSchema(request.responseFormat.schema),
      },
    }),
  };

  const thinkingWire =
    policy.thinking === undefined
      ? undefined
      : policy.thinking.type === 'enabled'
        ? { type: 'enabled', budget_tokens: policy.thinking.budgetTokens }
        : { type: policy.thinking.type };

  const fields: Record<string, unknown> = {
    max_tokens: maxTokens,
    stream: true,
    ...(includeTools && { tools: encodedTools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(thinkingWire !== undefined && { thinking: thinkingWire }),
    ...(Object.keys(outputConfig).length > 0 && { output_config: outputConfig }),
    ...(topLevelCacheControl !== undefined && {
      cache_control: toWireCacheControl(topLevelCacheControl),
    }),
    ...(policy.serviceTier !== undefined && { service_tier: policy.serviceTier }),
    ...(request.settings.temperature !== undefined && {
      temperature: request.settings.temperature,
    }),
    ...(request.settings.topP !== undefined && { top_p: request.settings.topP }),
    ...(request.settings.topK !== undefined && { top_k: request.settings.topK }),
    ...(request.settings.stopSequences !== undefined &&
      request.settings.stopSequences.length > 0 && {
        stop_sequences: [...request.settings.stopSequences],
      }),
  };

  const autoBetas: string[] = [];
  if (isAnthropicThinkingEnabled(policy.thinking)) autoBetas.push(INTERLEAVED_THINKING_BETA);
  if (eagerUsed) autoBetas.push(FINE_GRAINED_TOOL_STREAMING_BETA);
  return { fields, autoBetas };
}
