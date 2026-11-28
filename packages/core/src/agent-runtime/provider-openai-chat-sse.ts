import type { AgentProviderEnvelope } from '../agent-parts/parts';
import { isRecord } from '../internal/typed';
import type {
  AgentModelCostDetails,
  AgentModelFinishReason,
  AgentModelStreamPart,
} from './models-driver';
import { AgentProviderError, AgentProviderStreamCutError } from './provider-failure';
import {
  nonEmptyString,
  type ParsedProviderError,
  redactProviderFailureText,
} from './provider-http';
import {
  buildChatEnvelope,
  decodeChatMediaAndSources,
  isAbnormalNativeFinishReason,
  isToolCallSlotCollision,
  mergeChatRecord,
} from './provider-openai-chat-helpers';
import { parseSseJson, parseSseStream } from './provider-sse';
import type { AgentUsage } from './schemas';

const MAX_TOOL_CALLS = 256;

export interface OpenAiChatParsedError extends ParsedProviderError {
  readonly statusCode?: number;
}
export interface OpenAiChatUsageResult {
  readonly usage: AgentUsage;
  readonly costDetails?: AgentModelCostDetails;
}
export interface OpenAiChatDecodeOptions {
  readonly provider: string;
  readonly signal?: AbortSignal;
  readonly parseError: (payload: unknown) => OpenAiChatParsedError;
  readonly normalizeUsage: (rawUsage: unknown, metadata?: unknown) => OpenAiChatUsageResult;
}

interface ActiveToolCall {
  id: string;
  rawId?: string;
  name: string;
  arguments: string;
  started: boolean;
  extraContent?: Record<string, unknown>;
}

class DecodeState {
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: Date;
  responseProvider?: string;
  metadataEmitted = false;
  textOpen = false;
  producedOutput = false;
  sawRefusal = false;
  reasoningOpen = false;
  reasoningBlock = 0;
  reasoningDirty = false;
  finishReason: AgentModelFinishReason = 'other';
  rawFinishReason?: string;
  nativeFinishReason?: string;
  sawFinish = false;
  sawDone = false;
  sawError = false;
  rawUsage: unknown;
  reasoningDetails: Record<string, unknown>[] = [];
  toolCalls = new Map<number, ActiveToolCall>();
  activeSlotByWireIndex = new Map<number, number>();
  lastSlot?: number;
  seenIds = new Set<string>();
  constructor(
    readonly streamDeltas: boolean,
    readonly explicitUsageMeta?: unknown,
  ) {}
}

/** Map a Chat Completions `finish_reason` wire string to canonical `AgentModelFinishReason`. */
export function mapOpenAiChatFinishReason(raw: unknown): AgentModelFinishReason {
  if (raw === 'stop' || raw === 'length' || raw === 'error') return raw;
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool-calls';
  return raw === 'content_filter' ? 'content-filter' : 'other';
}

/** Merge one streamed `reasoning_details` chunk by matching `(type, format, index, id)`. */
export function mergeReasoningDetail(
  acc: Record<string, unknown>[],
  d: Record<string, unknown>,
): void {
  const t = d.type;
  if (t === 'reasoning.encrypted') {
    const hasId = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
    if (hasId(d.id)) {
      const existing = acc.find((i) => i.type === t && i.format === d.format && i.id === d.id);
      if (existing) {
        if (typeof d.data === 'string' && d.data.length > 0) existing.data = d.data;
        return;
      }
      acc.push({ ...d });
      return;
    }
    const duplicate = acc.some(
      (i) => i.type === t && i.format === d.format && !hasId(i.id) && i.data === d.data,
    );
    if (!duplicate) acc.push({ ...d });
    return;
  }
  const canMatch = t === 'reasoning.text' || t === 'reasoning.summary';
  const m = canMatch
    ? acc.find(
        (i) => i.type === t && i.format === d.format && i.index === d.index && i.id === d.id,
      )
    : undefined;
  if (!m) {
    acc.push({ ...d });
    return;
  }
  const add = (k: string, v: unknown) => {
    if (typeof v === 'string') m[k] = `${typeof m[k] === 'string' ? m[k] : ''}${v}`;
  };
  if (t === 'reasoning.text') {
    add('text', d.text);
    if (typeof d.signature === 'string' && d.signature.length > 0) m.signature = d.signature;
  } else if (t === 'reasoning.summary') add('summary', d.summary);
}

function makeProviderError(
  provider: string,
  parsed: OpenAiChatParsedError,
): AgentProviderError {
  const { message, ...rest } = parsed;
  return new AgentProviderError(
    redactProviderFailureText(message || `${provider} request failed`),
    { provider, ...rest },
  );
}

function* closeText(state: DecodeState): Generator<AgentModelStreamPart> {
  if (!state.textOpen) return;
  state.textOpen = false;
  yield { type: 'text-end', id: 'text-0' };
}

function* closeReasoning(
  state: DecodeState,
  provider: string,
): Generator<AgentModelStreamPart> {
  const env = buildChatEnvelope(provider, state.reasoningDetails);
  if (!state.reasoningOpen && !(env && state.reasoningDirty)) return;
  const id = `reasoning-${state.reasoningBlock}`;
  state.reasoningBlock += 1;
  state.reasoningDirty = false;
  if (!state.reasoningOpen) yield { type: 'reasoning-start', id };
  state.reasoningOpen = false;
  yield { type: 'reasoning-end', id, ...(env && { provider: env }) };
}

function* processToolCallDelta(
  tc: Record<string, unknown>,
  state: DecodeState,
  provider: string,
): Generator<AgentModelStreamPart> {
  const fn = isRecord(tc.function) ? tc.function : undefined;
  const rawId = nonEmptyString(tc.id);
  const name = nonEmptyString(fn?.name);
  const arg = typeof fn?.arguments === 'string' ? fn.arguments : '';
  const wireIndex =
    typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0
      ? tc.index
      : undefined;
  let slot =
    wireIndex !== undefined
      ? (state.activeSlotByWireIndex.get(wireIndex) ?? wireIndex)
      : (state.lastSlot ?? 0);
  const prev = state.toolCalls.get(slot);
  if (prev !== undefined && isToolCallSlotCollision({ prev, rawId, name, arg })) {
    slot = 0;
    while (state.toolCalls.has(slot)) slot += 1;
  }
  if (wireIndex !== undefined) state.activeSlotByWireIndex.set(wireIndex, slot);
  state.lastSlot = slot;
  let entry = state.toolCalls.get(slot);
  if (!entry) {
    if (state.toolCalls.size >= MAX_TOOL_CALLS) {
      throw new AgentProviderError(
        `${provider} exceeded maximum tool calls per step (${MAX_TOOL_CALLS})`,
        { provider },
      );
    }
    const id = rawId && !state.seenIds.has(rawId) ? rawId : crypto.randomUUID();
    state.seenIds.add(id);
    entry = { id, ...(rawId && { rawId }), name: name ?? '', arguments: '', started: false };
    state.toolCalls.set(slot, entry);
  } else {
    if (rawId && !entry.rawId) entry.rawId = rawId;
    if (name && !entry.name) entry.name = name;
  }
  if (isRecord(tc.extra_content))
    entry.extraContent = mergeChatRecord(entry.extraContent, tc.extra_content);
  if (state.streamDeltas && !entry.started && entry.name.trim()) {
    entry.started = true;
    yield { type: 'tool-input-start', toolCallId: entry.id, toolName: entry.name };
    if (entry.arguments)
      yield { type: 'tool-input-delta', toolCallId: entry.id, delta: entry.arguments };
  }
  if (arg) {
    entry.arguments += arg;
    if (state.streamDeltas && entry.started)
      yield { type: 'tool-input-delta', toolCallId: entry.id, delta: arg };
  }
}

function* decodeChunk(
  chunk: unknown,
  s: DecodeState,
  opts: OpenAiChatDecodeOptions,
): Generator<AgentModelStreamPart> {
  if (!isRecord(chunk)) return;
  s.responseId = nonEmptyString(chunk.id) ?? s.responseId;
  s.responseModelId = nonEmptyString(chunk.model) ?? s.responseModelId;
  if (
    s.responseTimestamp === undefined &&
    typeof chunk.created === 'number' &&
    Number.isFinite(chunk.created) &&
    chunk.created >= 0
  ) {
    s.responseTimestamp = new Date(chunk.created * 1000);
  }
  s.responseProvider = nonEmptyString(chunk.provider) ?? s.responseProvider;
  if (chunk.usage !== undefined && chunk.usage !== null) s.rawUsage = chunk.usage;
  if ('error' in chunk && chunk.error !== undefined && chunk.error !== null) {
    s.sawError = true;
    s.finishReason = 'error';
    yield { type: 'error', error: makeProviderError(opts.provider, opts.parseError(chunk)) };
    return;
  }
  if (!s.metadataEmitted && (s.responseId || s.responseModelId || s.responseTimestamp)) {
    s.metadataEmitted = true;
    yield {
      type: 'response-metadata',
      ...(s.responseId && { id: s.responseId }),
      ...(s.responseModelId && { modelId: s.responseModelId }),
      ...(s.responseTimestamp && { timestamp: s.responseTimestamp }),
    };
  }
  const choice =
    Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
  if (!choice) return;
  const finish = nonEmptyString(choice.finish_reason);
  if (finish) {
    s.rawFinishReason = finish;
    s.finishReason = mapOpenAiChatFinishReason(finish);
    s.sawFinish = true;
  }
  s.nativeFinishReason = nonEmptyString(choice.native_finish_reason) ?? s.nativeFinishReason;
  const delta = isRecord(choice.delta) ? choice.delta : null;
  if (!delta) return;

  const rChunks: string[] = [];
  for (const item of Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []) {
    if (!isRecord(item)) continue;
    mergeReasoningDetail(s.reasoningDetails, item);
    s.reasoningDirty = true;
    const text =
      item.type === 'reasoning.text'
        ? nonEmptyString(item.text)
        : item.type === 'reasoning.summary'
          ? nonEmptyString(item.summary)
          : undefined;
    if (text) rChunks.push(text);
  }
  if (rChunks.length === 0) {
    const plain = nonEmptyString(delta.reasoning) ?? nonEmptyString(delta.reasoning_content);
    if (plain) rChunks.push(plain);
  }
  for (const text of rChunks) {
    const id = `reasoning-${s.reasoningBlock}`;
    if (!s.reasoningOpen) {
      s.reasoningOpen = true;
      yield { type: 'reasoning-start', id };
    }
    yield { type: 'reasoning-delta', id, delta: text };
  }

  if (nonEmptyString(delta.refusal) !== undefined) {
    s.sawRefusal = true;
  }
  const content = nonEmptyString(delta.content);
  if (content) {
    yield* closeReasoning(s, opts.provider);
    s.producedOutput = true;
    if (!s.textOpen) {
      s.textOpen = true;
      yield { type: 'text-start', id: 'text-0' };
    }
    yield { type: 'text-delta', id: 'text-0', delta: content };
  }
  yield* decodeChatMediaAndSources(delta, () => {
    s.producedOutput = true;
  });
  if (Array.isArray(delta.tool_calls)) {
    yield* closeReasoning(s, opts.provider);
    yield* closeText(s);
    for (const tc of delta.tool_calls)
      if (isRecord(tc)) yield* processToolCallDelta(tc, s, opts.provider);
  }
}

function finishPart(
  s: DecodeState,
  finishReason: AgentModelFinishReason,
  ur: OpenAiChatUsageResult,
  env?: AgentProviderEnvelope,
): AgentModelStreamPart {
  const rawFinishReason = s.nativeFinishReason ?? s.rawFinishReason;
  const response =
    s.responseId || s.responseModelId || s.responseTimestamp
      ? {
          ...(s.responseId && { id: s.responseId }),
          ...(s.responseModelId && { modelId: s.responseModelId }),
          ...(s.responseTimestamp && { timestamp: s.responseTimestamp }),
        }
      : undefined;
  return {
    type: 'finish',
    finishReason,
    ...(rawFinishReason && { rawFinishReason }),
    usage: ur.usage,
    ...(ur.costDetails && { costDetails: ur.costDetails }),
    ...(s.responseProvider && { responseProvider: s.responseProvider }),
    ...(response && { response }),
    ...(env && { provider: env }),
  };
}

function* flushState(
  s: DecodeState,
  opts: OpenAiChatDecodeOptions,
): Generator<AgentModelStreamPart> {
  if (!s.sawDone && !s.sawFinish && !s.sawError) {
    throw new AgentProviderStreamCutError(
      `${opts.provider} SSE stream ended before completion`,
      { provider: opts.provider },
    );
  }
  const meta = s.explicitUsageMeta ?? { [opts.provider]: { usage: s.rawUsage } };
  if (s.sawError) {
    if (s.rawUsage === undefined) return;
    if (s.reasoningOpen) yield { type: 'reasoning-end', id: `reasoning-${s.reasoningBlock}` };
    yield* closeText(s);
    yield finishPart(s, 'error', opts.normalizeUsage(s.rawUsage, meta));
    return;
  }
  yield* closeText(s);
  yield* closeReasoning(s, opts.provider);
  const calls = [...s.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
    .filter((c) => c.name.trim().length > 0);
  let attached = false;
  for (const call of calls) {
    if (call.started) yield { type: 'tool-input-end', toolCallId: call.id };
    const env = buildChatEnvelope(
      opts.provider,
      attached ? [] : s.reasoningDetails,
      call.extraContent,
    );
    if (!attached && s.reasoningDetails.length > 0) attached = true;
    yield {
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments.trim().length > 0 ? call.arguments : '{}',
      ...(env && { provider: env }),
    };
  }
  const usageResult = opts.normalizeUsage(s.rawUsage, meta);
  const native = s.nativeFinishReason;
  if (
    !s.producedOutput &&
    !s.sawRefusal &&
    calls.length === 0 &&
    s.finishReason === 'stop' &&
    isAbnormalNativeFinishReason(native)
  ) {
    yield {
      type: 'error',
      error: new AgentProviderError(
        `${opts.provider} returned an empty response with native_finish_reason "${native}"`,
        {
          provider: opts.provider,
          code: native,
          failureReason: 'stream-cut',
          metadata: { native_finish_reason: native },
        },
      ),
    };
    if (s.rawUsage !== undefined && s.rawUsage !== null)
      yield finishPart(s, 'error', usageResult);
    return;
  }
  const reason: AgentModelFinishReason =
    calls.length > 0 && (s.finishReason === 'stop' || s.finishReason === 'other')
      ? 'tool-calls'
      : s.sawRefusal && !s.producedOutput && calls.length === 0
        ? 'content-filter'
        : s.finishReason;
  yield finishPart(
    s,
    reason,
    usageResult,
    buildChatEnvelope(opts.provider, s.reasoningDetails),
  );
}

/** Stream-decode an OpenAI Chat Completions SSE response into `AgentModelStreamPart`s. */
export async function* decodeOpenAiChatSseStream(
  body: ReadableStream<Uint8Array>,
  options: OpenAiChatDecodeOptions,
): AsyncGenerator<AgentModelStreamPart> {
  const state = new DecodeState(true);
  try {
    for await (const frame of parseSseStream(body, {
      provider: options.provider,
      ...(options.signal && { signal: options.signal }),
    })) {
      if (frame.kind === 'ping') yield { type: 'ping' };
      else if (frame.data.trim() === '[DONE]') state.sawDone = true;
      else
        yield* decodeChunk(parseSseJson(options.provider, frame.data.trim()), state, options);
    }
  } catch (error) {
    if (
      options.signal?.aborted ||
      error instanceof AgentProviderError ||
      error instanceof AgentProviderStreamCutError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new AgentProviderStreamCutError(
      `${options.provider} SSE stream disconnected before completion`,
      { provider: options.provider, cause: error },
    );
  }
  yield* flushState(state, options);
}

/** Decode a non-streaming `200 OK` OpenAI Chat Completions JSON response into `AgentModelStreamPart`s. */
export async function* decodeOpenAiChatJsonResponse(
  body: unknown,
  options: OpenAiChatDecodeOptions,
): AsyncGenerator<AgentModelStreamPart> {
  if (!isRecord(body)) {
    throw new AgentProviderError(`${options.provider} returned an invalid JSON response`, {
      provider: options.provider,
    });
  }
  if ('error' in body && body.error !== undefined && body.error !== null) {
    throw makeProviderError(options.provider, options.parseError(body));
  }
  const first =
    Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : null;
  const state = new DecodeState(false, body);
  state.finishReason = 'stop';
  state.sawDone = true;
  const normalizedMessage = isRecord(first?.message) ? { ...first.message } : {};
  if (Array.isArray(normalizedMessage.tool_calls)) {
    normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((tc, idx) =>
      isRecord(tc) && typeof tc.index !== 'number' ? { ...tc, index: idx } : tc,
    );
  }
  const choices = first
    ? [
        {
          delta: normalizedMessage,
          finish_reason: first.finish_reason,
          native_finish_reason: first.native_finish_reason,
        },
      ]
    : [];
  yield* decodeChunk(
    {
      id: body.id,
      model: body.model,
      created: body.created,
      provider: body.provider,
      usage: body.usage,
      choices,
    },
    state,
    options,
  );
  yield* flushState(state, options);
}
