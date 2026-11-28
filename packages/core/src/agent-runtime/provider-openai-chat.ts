import type {
  AgentCacheControl,
  AgentModelAssistantMessage,
  AgentModelMessage,
  AgentModelProviderOptions,
  AgentModelToolMessage,
  AgentModelUserContentPart,
  AgentModelUserMessage,
  AgentToolModelContentPart,
  AgentToolModelOutput,
} from '../agent-parts/model';
import type { AgentModelRequest, AgentModelToolSpec } from './models-driver';
import {
  assertValidCacheTtlOrder,
  budgetCacheBreakpoints,
  type CacheBreakpointSlot,
  MAX_CACHE_BREAKPOINTS,
  type PlannedCacheBreakpoint,
  toWireCacheControl,
} from './provider-cache';
import { historyHasToolTraffic, normalizeProviderHistory } from './provider-history';
import { normalizeOpenAiJsonSchema } from './provider-json-schema';
import {
  deterministicJson,
  readPortableCacheControl,
  sanitizeSurrogates,
} from './provider-media';
import {
  collectChatReasoningDetails,
  encodeChatFilePart,
  encodeChatResponseFormat,
  extractChatToolExtraContent,
} from './provider-openai-chat-helpers';

type WireCc = Record<string, string>;
type Cacheable = {
  readonly cacheControl?: AgentCacheControl;
  readonly providerOptions?: AgentModelProviderOptions;
};

/** Provider-specific hooks customizing the reusable OpenAI Chat Completions wire encoder. */
export interface OpenAiChatEncodeHooks {
  readonly providerKey: string;
  readonly looseTools?: boolean;
  readonly supportsInlineCacheControl?: boolean;
  readonly supportsAnthropicCacheControlOnMessages?: (modelId: string) => boolean;
  readonly explicitTopLevelCacheControl?: AgentCacheControl;
  readonly autoTopLevelCacheControl?: AgentCacheControl;
  readonly usageInclusion?: 'openrouter' | 'stream-options' | 'none';
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  readonly supportsTopK?: boolean;
  readonly supportsReasoningDetails?: boolean;
  readonly supportsToolExtraContent?: boolean;
  readonly normalizeJsonSchema?: boolean;
  readonly mapToolCallId?: (rawId: string) => string;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly extraFields?: Readonly<Record<string, unknown>>;
}

interface EncodedPart {
  readonly wire: Record<string, unknown>;
  readonly isNonEmptyText: boolean;
  readonly canAttachCache: boolean;
  hasCache: boolean;
}

class EncodeContext {
  readonly planned: PlannedCacheBreakpoint<(wireCc: WireCc) => void>[] = [];
  constructor(readonly hooks: OpenAiChatEncodeHooks) {}
  ccOf(item: Cacheable) {
    return readPortableCacheControl(
      item.cacheControl,
      item.providerOptions,
      this.hooks.providerKey,
    );
  }
  plan(
    slot: CacheBreakpointSlot,
    cc: AgentCacheControl | undefined,
    target: (w: WireCc) => void,
  ) {
    if (cc !== undefined) this.planned.push({ slot, control: cc, target });
  }
  planText(
    slot: CacheBreakpointSlot,
    cc: AgentCacheControl | undefined,
    msg: Record<string, unknown>,
    text: string,
  ) {
    if (text.length > 0)
      this.plan(slot, cc, (w) => {
        msg.content = [{ type: 'text', text, cache_control: w }];
      });
  }
}

function attachFallbackPartCache(
  parts: readonly EncodedPart[],
  cc: AgentCacheControl,
  ctx: EncodeContext,
) {
  const rev = [...parts].reverse();
  const chosen =
    rev.find((p) => !p.hasCache && p.isNonEmptyText) ??
    rev.find((p) => !p.hasCache && p.canAttachCache);
  if (!chosen) return;
  chosen.hasCache = true;
  ctx.plan('message', cc, (wireCc) => {
    chosen.wire.cache_control = wireCc;
  });
}

function encodePartList(
  items: readonly (AgentModelUserContentPart | AgentToolModelContentPart)[],
  allowPartCache: boolean,
  ctx: EncodeContext,
): EncodedPart[] {
  const out: EncodedPart[] = [];
  for (const part of items) {
    const wire =
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : part.type === 'file'
          ? encodeChatFilePart(part.data, part.mediaType, part.filename, ctx.hooks.providerKey)
          : { type: 'text', text: deterministicJson(part) };
    const isText = wire.type === 'text';
    const isNonEmptyText = isText && typeof wire.text === 'string' && wire.text.length > 0;
    if (isText && !isNonEmptyText) continue;
    const entry: EncodedPart = {
      wire,
      isNonEmptyText,
      canAttachCache: !isText || isNonEmptyText,
      hasCache: false,
    };
    const partCc = allowPartCache ? ctx.ccOf(part) : undefined;
    if (partCc !== undefined && entry.canAttachCache) {
      entry.hasCache = true;
      ctx.plan('message', partCc, (wireCc) => {
        entry.wire.cache_control = wireCc;
      });
    }
    out.push(entry);
  }
  return out;
}

function encodeUserMessage(
  msg: AgentModelUserMessage,
  ctx: EncodeContext,
): Record<string, unknown> {
  const msgCc = ctx.ccOf(msg);
  if (typeof msg.content === 'string') {
    const wire: Record<string, unknown> = { role: 'user', content: msg.content };
    ctx.planText('message', msgCc, wire, msg.content);
    return wire;
  }
  const only =
    msg.content.length === 1 && msg.content[0]?.type === 'text' ? msg.content[0] : null;
  if (only) {
    const wire: Record<string, unknown> = { role: 'user', content: only.text };
    ctx.planText('message', ctx.ccOf(only) ?? msgCc, wire, only.text);
    return wire;
  }
  const parts = encodePartList(msg.content, true, ctx);
  if (msgCc && parts.length > 0) attachFallbackPartCache(parts, msgCc, ctx);
  return { role: 'user', content: parts.length > 0 ? parts.map((p) => p.wire) : '' };
}

function encodeAssistantMessage(
  msg: AgentModelAssistantMessage,
  ctx: EncodeContext,
): Record<string, unknown> | undefined {
  const { hooks } = ctx;
  const msgCc = ctx.ccOf(msg);
  if (typeof msg.content === 'string') {
    if (msg.content.length === 0) return undefined;
    const wire: Record<string, unknown> = { role: 'assistant', content: msg.content };
    ctx.planText('message', msgCc, wire, msg.content);
    return wire;
  }
  const blocks: Array<{ wire: Record<string, unknown>; text: string; hasCache: boolean }> = [];
  let reasoning = '';
  const toolCalls: Record<string, unknown>[] = [];
  const allOptions: (AgentModelProviderOptions | undefined)[] = [msg.providerOptions];
  const msgWire: Record<string, unknown> = { role: 'assistant', content: null };
  const markBlock = (block: (typeof blocks)[number], cc: AgentCacheControl | undefined) => {
    if (cc === undefined || block.hasCache) return;
    block.hasCache = true;
    ctx.plan('message', cc, (wireCc) => {
      block.wire.cache_control = wireCc;
      msgWire.content = blocks.map((b) => b.wire);
    });
  };

  for (const part of msg.content) {
    if ('providerOptions' in part) allOptions.push(part.providerOptions);
    if (part.type === 'text' && part.text.length > 0) {
      const block = {
        wire: { type: 'text', text: part.text },
        text: part.text,
        hasCache: false,
      };
      blocks.push(block);
      markBlock(block, ctx.ccOf(part));
    } else if (part.type === 'reasoning') {
      reasoning += part.text;
    } else if (part.type === 'tool-call' && part.providerExecuted !== true) {
      const id = hooks.mapToolCallId ? hooks.mapToolCallId(part.toolCallId) : part.toolCallId;
      const extra = hooks.supportsToolExtraContent
        ? extractChatToolExtraContent(part.providerOptions, hooks.providerKey)
        : undefined;
      const args =
        typeof part.input === 'string'
          ? sanitizeSurrogates(part.input)
          : deterministicJson(part.input ?? {});
      toolCalls.push({
        id,
        type: 'function',
        function: { name: part.toolName, arguments: args },
        ...(extra !== undefined && { extra_content: extra }),
      });
    }
  }

  const details = hooks.supportsReasoningDetails
    ? collectChatReasoningDetails(allOptions, hooks.providerKey)
    : [];
  if (blocks.length === 0 && toolCalls.length === 0 && details.length === 0) return undefined;
  msgWire.content =
    blocks.length > 0 ? blocks.map((b) => b.text).join('') : toolCalls.length > 0 ? null : '';
  if (toolCalls.length > 0) msgWire.tool_calls = toolCalls;
  if (details.length > 0) {
    msgWire.reasoning_details = details;
    if (reasoning.length > 0) msgWire.reasoning = reasoning;
  }
  const last = blocks.at(-1);
  if (last) markBlock(last, msgCc);
  return msgWire;
}

function encodeToolMessage(
  msg: AgentModelToolMessage,
  ctx: EncodeContext,
): Record<string, unknown>[] {
  const results = msg.content.filter((p) => p.type === 'tool-result');
  if (results.length === 0) return [];
  let turnCc: AgentCacheControl | undefined;
  for (const part of results) turnCc = ctx.ccOf(part) ?? ctx.ccOf(part.output) ?? turnCc;
  const effectiveCc = turnCc ?? ctx.ccOf(msg);
  return results.map((part, index) => {
    const isLast = index === results.length - 1;
    const id = ctx.hooks.mapToolCallId
      ? ctx.hooks.mapToolCallId(part.toolCallId)
      : part.toolCallId;
    const out: AgentToolModelOutput = part.output;
    let content: string | Record<string, unknown>[];
    let parts: EncodedPart[] | undefined;
    if (out.type === 'text' || out.type === 'error-text') content = out.value;
    else if (out.type === 'json' || out.type === 'error-json')
      content = deterministicJson(out.value);
    else if (out.type === 'execution-denied') content = out.reason ?? 'Tool execution denied';
    else {
      parts = encodePartList(out.value, isLast, ctx);
      content = parts.length === 0 ? '(no tool output)' : parts.map((p) => p.wire);
    }
    const wire: Record<string, unknown> = {
      role: 'tool',
      tool_call_id: id,
      name: part.toolName,
      content,
    };
    if (isLast && effectiveCc !== undefined) {
      if (typeof content === 'string') ctx.planText('message', effectiveCc, wire, content);
      else if (parts && parts.length > 0) attachFallbackPartCache(parts, effectiveCc, ctx);
    }
    return wire;
  });
}

function encodeMessages(
  request: AgentModelRequest,
  normalized: readonly AgentModelMessage[],
  ctx: EncodeContext,
): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = [];
  const pushSys = (text: string, item: Cacheable): void => {
    if (!text) return;
    const msg: Record<string, unknown> = { role: 'system', content: text };
    ctx.planText('system', ctx.ccOf(item), msg, text);
    wire.push(msg);
  };
  for (const sys of request.instructions) pushSys(sanitizeSurrogates(sys.content), sys);
  for (const msg of normalized) {
    if (msg.role === 'system') pushSys(msg.content, msg);
    else if (msg.role === 'user') wire.push(encodeUserMessage(msg, ctx));
    else if (msg.role === 'assistant') {
      const encoded = encodeAssistantMessage(msg, ctx);
      if (encoded) wire.push(encoded);
    } else wire.push(...encodeToolMessage(msg, ctx));
  }
  return wire;
}

function encodeTools(
  specs: readonly AgentModelToolSpec[],
  normalized: readonly AgentModelMessage[],
  ctx: EncodeContext,
): Record<string, unknown>[] | undefined {
  if (specs.length === 0) return historyHasToolTraffic(normalized) ? [] : undefined;
  return specs.map((spec) => {
    if (spec.type === 'provider') {
      throw new TypeError(
        `${ctx.hooks.providerKey}: unsupported provider tool "${spec.id}" (type: "provider")`,
      );
    }
    const strict = spec.strict ?? (ctx.hooks.looseTools ? false : undefined);
    const params = ctx.hooks.normalizeJsonSchema
      ? normalizeOpenAiJsonSchema(spec.inputSchema, strict === true)
      : spec.inputSchema;
    const fn: Record<string, unknown> = { name: spec.name, parameters: params };
    if (spec.description !== undefined) fn.description = sanitizeSurrogates(spec.description);
    if (strict !== undefined) fn.strict = strict;
    const toolWire: Record<string, unknown> = { type: 'function', function: fn };
    ctx.plan('tools', ctx.ccOf(spec), (w) => {
      toolWire.cache_control = w;
    });
    return toolWire;
  });
}

/** Build a reusable OpenAI Chat Completions JSON request body from an `AgentModelRequest`. */
export function buildOpenAiChatRequestBody(input: {
  readonly modelId: string;
  readonly request: AgentModelRequest;
  readonly hooks: OpenAiChatEncodeHooks;
}): Record<string, unknown> {
  const { modelId, request, hooks } = input;
  const normalized = normalizeProviderHistory(request.messages);
  const ctx = new EncodeContext(hooks);
  const tools = encodeTools(request.tools, normalized, ctx);
  const messages = encodeMessages(request, normalized, ctx);
  const responseFormat = encodeChatResponseFormat(
    request.responseFormat,
    hooks.normalizeJsonSchema === true,
  );

  let topLevelCache: WireCc | undefined;
  let topLevelCacheControl: AgentCacheControl | undefined;
  if (hooks.explicitTopLevelCacheControl !== undefined) {
    topLevelCacheControl = hooks.explicitTopLevelCacheControl;
    topLevelCache = toWireCacheControl(hooks.explicitTopLevelCacheControl);
  } else if (
    hooks.autoTopLevelCacheControl !== undefined &&
    (hooks.supportsAnthropicCacheControlOnMessages
      ? hooks.supportsAnthropicCacheControlOnMessages(modelId)
      : hooks.supportsInlineCacheControl === true)
  ) {
    topLevelCacheControl = hooks.autoTopLevelCacheControl;
    topLevelCache = toWireCacheControl(hooks.autoTopLevelCacheControl);
  }
  const keptBreakpoints =
    hooks.supportsInlineCacheControl !== false && ctx.planned.length > 0
      ? budgetCacheBreakpoints(
          ctx.planned,
          topLevelCache ? MAX_CACHE_BREAKPOINTS - 1 : MAX_CACHE_BREAKPOINTS,
        )
      : [];
  const wireControls = [
    ...keptBreakpoints.map((bp) => bp.control),
    ...(topLevelCacheControl !== undefined ? [topLevelCacheControl] : []),
  ];
  if (wireControls.length > 0) {
    assertValidCacheTtlOrder(wireControls, hooks.providerKey);
  }
  for (const bp of keptBreakpoints) {
    bp.target(toWireCacheControl(bp.control));
  }

  const s = request.settings;
  const maxTokensKey = hooks.maxTokensField ?? 'max_tokens';
  const body: Record<string, unknown> = {
    ...(hooks.extraBody ?? {}),
    ...(hooks.extraFields ?? {}),
    model: modelId,
    stream: true,
    messages,
  };
  if (hooks.usageInclusion === 'openrouter') body.usage = { include: true };
  else if (hooks.usageInclusion === 'stream-options')
    body.stream_options = { include_usage: true };
  if (tools !== undefined) body.tools = tools;
  if (request.tools.length > 0 && request.toolChoice !== undefined) {
    body.tool_choice =
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : { type: 'function', function: { name: request.toolChoice.toolName } };
  }
  if (responseFormat !== undefined) body.response_format = responseFormat;
  if (s.maxOutputTokens !== undefined) body[maxTokensKey] = s.maxOutputTokens;
  if (s.temperature !== undefined) body.temperature = s.temperature;
  if (s.topP !== undefined) body.top_p = s.topP;
  if (hooks.supportsTopK !== false && s.topK !== undefined) body.top_k = s.topK;
  if (s.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
  if (s.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
  if (s.seed !== undefined) body.seed = s.seed;
  if (s.stopSequences !== undefined) body.stop = [...s.stopSequences];
  if (topLevelCache !== undefined) body.cache_control = topLevelCache;
  return body;
}
