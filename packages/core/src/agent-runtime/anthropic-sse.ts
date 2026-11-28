import { isRecord } from '../internal/typed';
import {
  mapAnthropicStopReason,
  normalizeAnthropicUsage,
  parseAnthropicError,
} from './anthropic-response';
import type { AgentModelStreamPart } from './models-driver';
import { AgentProviderError, AgentProviderStreamCutError } from './provider-failure';
import { nonEmptyString, recordField, redactProviderFailureText } from './provider-http';
import { parseSseJson, parseSseStream } from './provider-sse';

type ActiveBlock =
  | { readonly kind: 'text'; readonly id: string }
  | { readonly kind: 'thinking'; readonly id: string; text: string; signature: string }
  | { readonly kind: 'redacted_thinking'; readonly id: string }
  | {
      readonly kind: 'tool_use';
      readonly callId: string;
      readonly toolName: string;
      readonly initialInput?: string;
      partialJson: string;
    };

interface AnthropicSseState {
  readonly blocks: Map<number, ActiveBlock>;
  readonly mergedUsage: Record<string, unknown>;
  responseId?: string;
  responseModelId?: string;
  rawStopReason?: string;
  sawMessageStop: boolean;
  sawError: boolean;
}

function mergeRawUsage(target: Record<string, unknown>, incoming: unknown): void {
  if (!isRecord(incoming)) return;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue;
    if (isRecord(value)) {
      const existing = target[key];
      const mergedNested: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue !== undefined && nestedValue !== null) {
          mergedNested[nestedKey] = nestedValue;
        }
      }
      target[key] = mergedNested;
      continue;
    }
    target[key] = value;
  }
}

function readBlockIndex(payload: Record<string, unknown>): number | undefined {
  return typeof payload.index === 'number' && Number.isInteger(payload.index)
    ? payload.index
    : undefined;
}

function* handleBlockStart(
  payload: Record<string, unknown>,
  state: AnthropicSseState,
): Generator<AgentModelStreamPart> {
  const index = readBlockIndex(payload);
  const block = recordField(payload, 'content_block');
  if (index === undefined || !block) return;

  if (block.type === 'text') {
    const id = `text-${index}`;
    state.blocks.set(index, { kind: 'text', id });
    yield { type: 'text-start', id };
    if (typeof block.text === 'string' && block.text.length > 0) {
      yield { type: 'text-delta', id, delta: block.text };
    }
    return;
  }

  if (block.type === 'thinking') {
    const id = `reasoning-${index}`;
    const initialText = typeof block.thinking === 'string' ? block.thinking : '';
    const initialSignature = typeof block.signature === 'string' ? block.signature : '';
    state.blocks.set(index, {
      kind: 'thinking',
      id,
      text: initialText,
      signature: initialSignature,
    });
    yield { type: 'reasoning-start', id };
    if (initialText.length > 0) yield { type: 'reasoning-delta', id, delta: initialText };
    return;
  }

  if (block.type === 'redacted_thinking') {
    const id = `reasoning-${index}`;
    const data = typeof block.data === 'string' ? block.data : '';
    state.blocks.set(index, { kind: 'redacted_thinking', id });
    yield { type: 'reasoning-start', id };
    yield {
      type: 'reasoning-end',
      id,
      provider: {
        schemaVersion: 1,
        provider: 'anthropic',
        data: { type: 'redacted_thinking', data },
      },
    };
    return;
  }

  if (block.type === 'tool_use') {
    const toolCallId = nonEmptyString(block.id) ?? crypto.randomUUID();
    const toolName = typeof block.name === 'string' ? block.name : '';
    const initialInput =
      isRecord(block.input) && Object.keys(block.input).length > 0
        ? JSON.stringify(block.input)
        : undefined;
    state.blocks.set(index, {
      kind: 'tool_use',
      callId: toolCallId,
      toolName,
      ...(initialInput !== undefined && { initialInput }),
      partialJson: '',
    });
    yield { type: 'tool-input-start', toolCallId, toolName };
    if (initialInput !== undefined) {
      yield { type: 'tool-input-delta', toolCallId, delta: initialInput };
    }
  }
}

function* handleBlockDelta(
  payload: Record<string, unknown>,
  state: AnthropicSseState,
): Generator<AgentModelStreamPart> {
  const index = readBlockIndex(payload);
  const delta = recordField(payload, 'delta');
  if (index === undefined || !delta) return;
  const active = state.blocks.get(index);
  if (!active) return;

  if (delta.type === 'text_delta' && active.kind === 'text') {
    if (typeof delta.text === 'string' && delta.text.length > 0) {
      yield { type: 'text-delta', id: active.id, delta: delta.text };
    }
    return;
  }

  if (delta.type === 'thinking_delta' && active.kind === 'thinking') {
    if (typeof delta.thinking === 'string' && delta.thinking.length > 0) {
      active.text += delta.thinking;
      yield { type: 'reasoning-delta', id: active.id, delta: delta.thinking };
    }
    return;
  }

  if (delta.type === 'signature_delta' && active.kind === 'thinking') {
    if (typeof delta.signature === 'string') {
      active.signature += delta.signature;
    }
    return;
  }

  if (delta.type === 'input_json_delta' && active.kind === 'tool_use') {
    if (typeof delta.partial_json === 'string') {
      active.partialJson += delta.partial_json;
      if (delta.partial_json.length > 0) {
        yield {
          type: 'tool-input-delta',
          toolCallId: active.callId,
          delta: delta.partial_json,
        };
      }
    }
  }
}

function* handleBlockStop(
  payload: Record<string, unknown>,
  state: AnthropicSseState,
): Generator<AgentModelStreamPart> {
  const index = readBlockIndex(payload);
  if (index === undefined) return;
  const active = state.blocks.get(index);
  if (!active) return;
  state.blocks.delete(index);

  if (active.kind === 'text') {
    yield { type: 'text-end', id: active.id };
    return;
  }

  if (active.kind === 'thinking') {
    yield {
      type: 'reasoning-end',
      id: active.id,
      provider: {
        schemaVersion: 1,
        provider: 'anthropic',
        data: { type: 'thinking', signature: active.signature },
      },
    };
    return;
  }

  if (active.kind === 'tool_use') {
    yield { type: 'tool-input-end', toolCallId: active.callId };
    const input =
      active.partialJson.trim().length > 0
        ? active.partialJson
        : (active.initialInput ?? '{}');
    yield {
      type: 'tool-call',
      toolCallId: active.callId,
      toolName: active.toolName,
      input,
    };
  }
}

/** Stream-decode an Anthropic Messages API SSE response into `AgentModelStreamPart`s. */
export async function* decodeAnthropicSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  responseTimestamp?: Date,
): AsyncGenerator<AgentModelStreamPart> {
  const state: AnthropicSseState = {
    blocks: new Map(),
    mergedUsage: {},
    sawMessageStop: false,
    sawError: false,
  };

  try {
    for await (const frame of parseSseStream(body, { provider: 'anthropic', signal })) {
      if (frame.kind === 'ping') {
        yield { type: 'ping' };
        continue;
      }

      const payload = parseSseJson('anthropic', frame.data);
      if (!isRecord(payload)) continue;
      const eventType = nonEmptyString(payload.type) ?? frame.event;

      if (eventType === 'ping') {
        yield { type: 'ping' };
        continue;
      }

      if (eventType === 'message_start') {
        const message = recordField(payload, 'message');
        const id = nonEmptyString(message?.id);
        const modelId = nonEmptyString(message?.model);
        if (id !== undefined) state.responseId = id;
        if (modelId !== undefined) state.responseModelId = modelId;
        mergeRawUsage(state.mergedUsage, message?.usage);
        if (
          state.responseId !== undefined ||
          state.responseModelId !== undefined ||
          responseTimestamp !== undefined
        ) {
          yield {
            type: 'response-metadata',
            ...(state.responseId !== undefined && { id: state.responseId }),
            ...(state.responseModelId !== undefined && { modelId: state.responseModelId }),
            ...(responseTimestamp !== undefined && { timestamp: responseTimestamp }),
          };
        }
        continue;
      }

      if (eventType === 'content_block_start') {
        yield* handleBlockStart(payload, state);
        continue;
      }

      if (eventType === 'content_block_delta') {
        yield* handleBlockDelta(payload, state);
        continue;
      }

      if (eventType === 'content_block_stop') {
        yield* handleBlockStop(payload, state);
        continue;
      }

      if (eventType === 'message_delta') {
        const delta = recordField(payload, 'delta');
        const stopReason = nonEmptyString(delta?.stop_reason);
        if (stopReason !== undefined) state.rawStopReason = stopReason;
        mergeRawUsage(state.mergedUsage, payload.usage);
        continue;
      }

      if (eventType === 'message_stop') {
        state.sawMessageStop = true;
        for (const active of state.blocks.values()) {
          if (active.kind === 'text') {
            yield { type: 'text-end', id: active.id };
          } else if (active.kind === 'thinking') {
            yield {
              type: 'reasoning-end',
              id: active.id,
              provider: {
                schemaVersion: 1,
                provider: 'anthropic',
                data: { type: 'thinking', signature: active.signature },
              },
            };
          }
        }
        state.blocks.clear();
        yield {
          type: 'finish',
          finishReason: mapAnthropicStopReason(state.rawStopReason),
          ...(state.rawStopReason !== undefined && { rawFinishReason: state.rawStopReason }),
          usage: normalizeAnthropicUsage(state.mergedUsage),
          ...((state.responseId !== undefined ||
            state.responseModelId !== undefined ||
            responseTimestamp !== undefined) && {
            response: {
              ...(state.responseId !== undefined && { id: state.responseId }),
              ...(state.responseModelId !== undefined && { modelId: state.responseModelId }),
              ...(responseTimestamp !== undefined && { timestamp: responseTimestamp }),
            },
          }),
        };
        continue;
      }

      if (eventType === 'error') {
        state.sawError = true;
        state.blocks.clear();
        const parsed = parseAnthropicError(payload, frame.data, 200);
        yield {
          type: 'error',
          error: new AgentProviderError(redactProviderFailureText(parsed.message), {
            provider: 'anthropic',
            ...(parsed.code !== undefined && { code: parsed.code }),
            ...(parsed.errorType !== undefined && { errorType: parsed.errorType }),
            ...(parsed.failureReason !== undefined && { failureReason: parsed.failureReason }),
          }),
        };
        return;
      }
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
      'Anthropic SSE stream disconnected before message_stop',
      { provider: 'anthropic', cause: error },
    );
  }

  if (!state.sawMessageStop && !state.sawError) {
    throw new AgentProviderStreamCutError(
      'Anthropic SSE stream ended before message_stop or error',
      { provider: 'anthropic' },
    );
  }
}
