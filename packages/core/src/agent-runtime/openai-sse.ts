import { isRecord } from '../internal/typed';
import type { AgentModelStreamPart } from './models-driver';
import {
  buildOpenAiFinishPart,
  buildOpenAiToolCallEnvelope,
  createOpenAiStreamError,
  extractOpenAiReasoningSummary,
  extractOpenAiUrlCitation,
  scanOpenAiMessageContent,
} from './openai-response';
import {
  closeReasoningItem,
  closeTextItem,
  closeTextSegment,
  emitMetadata,
  emitReasoningDelta,
  ensureReasoningItem,
  ensureTextItem,
  intField,
  lookupItem,
  type OpenAiSseState,
  resolveSummary,
  setItem,
} from './openai-sse-state';
import { AgentProviderError, AgentProviderStreamCutError } from './provider-failure';
import { nonEmptyString } from './provider-http';
import { parseSseJson, parseSseStream } from './provider-sse';

function* handleOutputItemAdded(
  state: OpenAiSseState,
  payload: Record<string, unknown>,
): Generator<AgentModelStreamPart> {
  const item = isRecord(payload.item) ? payload.item : undefined;
  if (!item) return;
  const outputIndex = intField(payload, 'output_index');
  const rawItemId = nonEmptyString(item.id);

  if (item.type === 'message') {
    const entry = ensureTextItem(state, rawItemId, outputIndex);
    const phase = nonEmptyString(item.phase);
    if (phase !== undefined) entry.phase = phase;
    return;
  }
  if (item.type === 'reasoning') {
    const entry = ensureReasoningItem(state, rawItemId, outputIndex);
    const initial = extractOpenAiReasoningSummary(item.summary);
    const encrypted = nonEmptyString(item.encrypted_content);
    if (rawItemId !== undefined) entry.itemId = rawItemId;
    if (initial.length > 0) {
      entry.finalSummary = initial;
      entry.summaryTexts = initial.map((s) => s.text);
    }
    if (encrypted !== undefined) entry.encryptedContent = encrypted;
    if (!entry.opened) {
      entry.opened = true;
      yield { type: 'reasoning-start', id: entry.id };
    }
    return;
  }
  if (item.type === 'function_call') {
    const key = rawItemId ?? `function_call-${outputIndex ?? state.itemsById.size}`;
    const toolCallId = nonEmptyString(item.call_id) ?? crypto.randomUUID();
    const name = typeof item.name === 'string' ? item.name : '';
    const args = typeof item.arguments === 'string' ? item.arguments : '';
    setItem(state, key, outputIndex, {
      kind: 'function_call',
      ...(rawItemId !== undefined && { itemId: rawItemId }),
      callId: toolCallId,
      name,
      arguments: args,
      started: true,
    });
    yield { type: 'tool-input-start', toolCallId, toolName: name };
    if (args.length > 0) yield { type: 'tool-input-delta', toolCallId, delta: args };
  }
}

function* handleOutputItemDone(
  state: OpenAiSseState,
  payload: Record<string, unknown>,
): Generator<AgentModelStreamPart> {
  const item = isRecord(payload.item) ? payload.item : undefined;
  if (!item) return;
  const outputIndex = intField(payload, 'output_index');
  const rawItemId = nonEmptyString(item.id);

  if (item.type === 'message') {
    const entry = ensureTextItem(state, rawItemId, outputIndex);
    const phase = nonEmptyString(item.phase);
    if (phase !== undefined) entry.phase = phase;
    const scanned = scanOpenAiMessageContent(item.content);
    if (scanned.sawRefusal) state.sawRefusal = true;
    if (entry.segmentCount === 0 && scanned.text.length > 0) {
      entry.segmentCount = 1;
      entry.openSegments.add(entry.id);
      state.sawText = true;
      yield { type: 'text-start', id: entry.id };
      yield { type: 'text-delta', id: entry.id, delta: scanned.text };
    }
    yield* closeTextItem(entry);
    return;
  }
  if (item.type === 'reasoning') {
    const entry = ensureReasoningItem(state, rawItemId, outputIndex);
    if (rawItemId !== undefined) entry.itemId = rawItemId;
    const summary = resolveSummary(entry, item.summary);
    entry.finalSummary = summary;
    const encrypted = nonEmptyString(item.encrypted_content) ?? entry.encryptedContent;
    if (encrypted !== undefined) {
      yield* closeReasoningItem(entry, summary, encrypted);
    } else {
      if (!entry.opened) {
        entry.opened = true;
        yield { type: 'reasoning-start', id: entry.id };
      }
      entry.pendingDone = true;
    }
    return;
  }
  if (item.type === 'function_call') {
    const found = lookupItem(state, rawItemId, outputIndex);
    const entry = found?.kind === 'function_call' ? found : undefined;
    const toolCallId = nonEmptyString(item.call_id) ?? entry?.callId ?? crypto.randomUUID();
    const itemId = rawItemId ?? entry?.itemId;
    const toolName = nonEmptyString(item.name) ?? entry?.name ?? '';
    const args =
      typeof item.arguments === 'string' && item.arguments.trim().length > 0
        ? item.arguments
        : (entry?.arguments ?? '');
    state.hasToolCalls = true;
    if (!entry?.started) yield { type: 'tool-input-start', toolCallId, toolName };
    yield { type: 'tool-input-end', toolCallId };
    yield {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: args.trim().length > 0 ? args : '{}',
      ...(itemId !== undefined && { provider: buildOpenAiToolCallEnvelope(itemId) }),
    };
  }
}

function* flushAndBackfill(
  state: OpenAiSseState,
  response: Record<string, unknown> | undefined,
): Generator<AgentModelStreamPart> {
  for (const item of state.itemsById.values()) {
    if (item.kind === 'message') yield* closeTextItem(item);
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  for (let index = 0; index < output.length; index += 1) {
    const rawItem = output[index];
    if (!isRecord(rawItem)) continue;
    if (rawItem.type === 'message') {
      if (scanOpenAiMessageContent(rawItem.content).sawRefusal) state.sawRefusal = true;
      continue;
    }
    if (rawItem.type !== 'reasoning') continue;
    const itemId = nonEmptyString(rawItem.id);
    const encrypted = nonEmptyString(rawItem.encrypted_content);
    const rawSummary = extractOpenAiReasoningSummary(rawItem.summary);
    const existing = lookupItem(state, itemId, index);
    if (existing?.kind === 'reasoning') {
      if (itemId !== undefined) existing.itemId = itemId;
      const summary = rawSummary.length > 0 ? rawSummary : resolveSummary(existing, undefined);
      const merged = encrypted ?? existing.encryptedContent;
      if (!existing.closed) yield* closeReasoningItem(existing, summary, merged);
      continue;
    }
    const created = ensureReasoningItem(state, itemId, index);
    const summaryText = rawSummary.map((s) => s.text).join('\n');
    if (summaryText.length > 0) yield* emitReasoningDelta(created, summaryText);
    yield* closeReasoningItem(created, rawSummary, encrypted);
  }
  for (const item of state.itemsById.values()) {
    if (item.kind === 'reasoning' && (item.opened || item.pendingDone) && !item.closed) {
      yield* closeReasoningItem(item, resolveSummary(item, undefined), item.encryptedContent);
    }
  }
}

function* decodeOpenAiEvent(
  state: OpenAiSseState,
  eventType: string | undefined,
  payload: Record<string, unknown>,
): Generator<AgentModelStreamPart> {
  const itemId = nonEmptyString(payload.item_id);
  const outputIndex = intField(payload, 'output_index');

  switch (eventType) {
    case 'response.created':
    case 'response.in_progress':
      yield* emitMetadata(state, isRecord(payload.response) ? payload.response : undefined);
      return;
    case 'response.output_item.added':
      yield* handleOutputItemAdded(state, payload);
      return;
    case 'response.output_text.delta': {
      const entry = ensureTextItem(state, itemId, outputIndex);
      const contentIndex = intField(payload, 'content_index');
      const segmentId =
        contentIndex !== undefined
          ? `${entry.id}:${contentIndex}`
          : (entry.activeSegmentId ??
            (entry.segmentCount === 0 ? entry.id : `${entry.id}:${entry.segmentCount}`));
      if (!entry.openSegments.has(segmentId)) {
        entry.openSegments.add(segmentId);
        entry.activeSegmentId = segmentId;
        entry.segmentCount += 1;
        yield { type: 'text-start', id: segmentId };
      }
      if (typeof payload.delta === 'string' && payload.delta.length > 0) {
        state.sawText = true;
        yield { type: 'text-delta', id: segmentId, delta: payload.delta };
      }
      return;
    }
    case 'response.output_text.done': {
      const found = lookupItem(state, itemId, outputIndex);
      if (found?.kind === 'message') {
        const phase = nonEmptyString(payload.phase);
        if (phase !== undefined) found.phase = phase;
        const contentIndex = intField(payload, 'content_index');
        const targetId =
          contentIndex !== undefined ? `${found.id}:${contentIndex}` : found.activeSegmentId;
        if (targetId !== undefined) yield* closeTextSegment(found, targetId);
      }
      return;
    }
    case 'response.output_text.annotation.added': {
      const source = extractOpenAiUrlCitation(payload.annotation);
      if (source !== undefined) yield { type: 'source', source };
      return;
    }
    case 'response.refusal.delta':
    case 'response.refusal.done':
      state.sawRefusal = true;
      return;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const entry = ensureReasoningItem(state, itemId, outputIndex);
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (eventType === 'response.reasoning_summary_text.delta' && delta.length > 0) {
        const idx = intField(payload, 'summary_index') ?? 0;
        entry.summaryTexts[idx] = `${entry.summaryTexts[idx] ?? ''}${delta}`;
      }
      yield* emitReasoningDelta(entry, delta);
      return;
    }
    case 'response.reasoning_summary_text.done': {
      const entry = ensureReasoningItem(state, itemId, outputIndex);
      const idx = intField(payload, 'summary_index') ?? 0;
      if (typeof payload.text === 'string') {
        if ((entry.summaryTexts[idx] ?? '').length === 0 && payload.text.length > 0) {
          yield* emitReasoningDelta(entry, payload.text);
        }
        entry.summaryTexts[idx] = payload.text;
      }
      return;
    }
    case 'response.function_call_arguments.delta':
    case 'response.function_call_arguments.done': {
      const found = lookupItem(state, itemId, outputIndex);
      if (found?.kind !== 'function_call') return;
      if (eventType === 'response.function_call_arguments.delta') {
        const delta = typeof payload.delta === 'string' ? payload.delta : '';
        if (delta.length > 0) {
          found.arguments += delta;
          yield { type: 'tool-input-delta', toolCallId: found.callId, delta };
        }
      } else if (typeof payload.arguments === 'string' && found.arguments.length === 0) {
        found.arguments = payload.arguments;
      }
      return;
    }
    case 'response.output_item.done':
      yield* handleOutputItemDone(state, payload);
      return;
    case 'response.completed':
    case 'response.incomplete': {
      const response = isRecord(payload.response) ? payload.response : undefined;
      state.sawTerminal = true;
      yield* emitMetadata(state, response);
      yield* flushAndBackfill(state, response);
      yield buildOpenAiFinishPart({
        status: eventType === 'response.completed' ? 'completed' : 'incomplete',
        incompleteDetails: response?.incomplete_details,
        usage: response?.usage,
        hasToolCalls: state.hasToolCalls,
        sawText: state.sawText,
        sawRefusal: state.sawRefusal,
        ...(state.responseId !== undefined && { responseId: state.responseId }),
        ...(state.responseModelId !== undefined && { responseModelId: state.responseModelId }),
        ...(state.responseTimestamp !== undefined && {
          responseTimestamp: state.responseTimestamp,
        }),
      });
      return;
    }
    case 'response.failed':
    case 'error':
      state.sawTerminal = true;
      yield {
        type: 'error',
        error: createOpenAiStreamError(payload, 'OpenAI Responses stream failed'),
      };
      return;
  }
}

/** Stream-parse an OpenAI Responses API SSE stream into `AgentModelStreamPart`s. */
export async function* decodeOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<AgentModelStreamPart> {
  const state: OpenAiSseState = {
    metadataEmitted: false,
    sawText: false,
    sawRefusal: false,
    hasToolCalls: false,
    sawTerminal: false,
    itemsById: new Map(),
    keyByOutputIndex: new Map(),
  };
  try {
    for await (const frame of parseSseStream(body, {
      provider: 'openai',
      ...(signal !== undefined && { signal }),
    })) {
      if (frame.kind === 'ping') {
        yield { type: 'ping' };
        continue;
      }
      if (frame.data.trim() === '[DONE]') continue;
      const parsed = parseSseJson('openai', frame.data);
      if (!isRecord(parsed)) continue;
      yield* decodeOpenAiEvent(state, nonEmptyString(parsed.type) ?? frame.event, parsed);
    }
  } catch (error) {
    if (
      signal?.aborted ||
      error instanceof AgentProviderError ||
      error instanceof AgentProviderStreamCutError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    throw new AgentProviderStreamCutError(
      'OpenAI Responses SSE stream disconnected before a terminal event',
      { provider: 'openai', cause: error },
    );
  }
  if (!state.sawTerminal) {
    throw new AgentProviderStreamCutError(
      'OpenAI Responses SSE stream ended before a terminal event',
      { provider: 'openai' },
    );
  }
}
