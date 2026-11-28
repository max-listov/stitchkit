import { isRecord } from '../internal/typed';
import type { AgentModelFinishReason, AgentModelStreamPart } from './models-driver';
import { AgentProviderError, type AgentProviderFailureReason } from './provider-failure';
import {
  nonEmptyString,
  type ParsedProviderError,
  recordField,
  redactProviderFailureText,
} from './provider-http';
import { buildProviderUsage, computedInt, reportedInt } from './provider-usage';
import type { AgentUsage, AgentUsageValue } from './schemas-usage';

const CREDIT_BALANCE_PATTERN = /credit balance is too low/i;

function resolveCacheWriteTokens(source: Record<string, unknown>): AgentUsageValue {
  const direct = reportedInt(source.cache_creation_input_tokens);
  if (direct.value !== undefined) return direct;

  const breakdown = recordField(source, 'cache_creation');
  if (!breakdown) return { provenance: 'unavailable' };

  const ttl1h = reportedInt(breakdown.ephemeral_1h_input_tokens);
  const ttl5m = reportedInt(breakdown.ephemeral_5m_input_tokens);
  if (ttl1h.value !== undefined && ttl5m.value !== undefined) {
    const total = ttl1h.value + ttl5m.value;
    return ttl1h.value > 0 && ttl5m.value > 0 ? computedInt(total) : reportedInt(total);
  }
  if (ttl1h.value !== undefined) return ttl1h;
  if (ttl5m.value !== undefined) return ttl5m;
  return { provenance: 'unavailable' };
}

/**
 * Normalize an Anthropic Messages `usage` object into provenance-honest `AgentUsage`.
 *
 * Anthropic reports uncached `input_tokens` separately from `cache_read_input_tokens`
 * and `cache_creation_input_tokens`. When either cache counter is positive, total
 * `inputTokens` is computed (`provenance: 'computed'`) as the sum of all three;
 * otherwise `inputTokens` remains `'provider-reported'`. → ADR 0109.
 */
export function normalizeAnthropicUsage(rawUsage: unknown): AgentUsage {
  if (!isRecord(rawUsage)) {
    return buildProviderUsage({
      inputTokens: { provenance: 'unavailable' },
      outputTokens: { provenance: 'unavailable' },
    });
  }

  const baseInput = reportedInt(rawUsage.input_tokens);
  const cacheReadTokens = reportedInt(rawUsage.cache_read_input_tokens);
  const cacheWriteTokens = resolveCacheWriteTokens(rawUsage);

  const cacheReadVal = cacheReadTokens.value ?? 0;
  const cacheWriteVal = cacheWriteTokens.value ?? 0;
  const inputTokens: AgentUsageValue =
    baseInput.value === undefined
      ? { provenance: 'unavailable' }
      : cacheReadVal > 0 || cacheWriteVal > 0
        ? computedInt(baseInput.value + cacheReadVal + cacheWriteVal)
        : baseInput;

  const outputTokens = reportedInt(rawUsage.output_tokens);
  const outputDetails = recordField(rawUsage, 'output_tokens_details');
  const reasoningTokens = reportedInt(outputDetails?.thinking_tokens);

  return buildProviderUsage({
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost: { provenance: 'unavailable' },
  });
}

/** Map an Anthropic Messages `stop_reason` string into a canonical `AgentModelFinishReason`. */
export function mapAnthropicStopReason(raw: unknown): AgentModelFinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    case 'refusal':
      return 'content-filter';
    default:
      return 'other';
  }
}

/** Classify an Anthropic HTTP or mid-stream error payload into structured provider error details. */
export function parseAnthropicError(
  payload: unknown,
  rawText: string,
  status: number,
): ParsedProviderError {
  const errObj = recordField(payload, 'error') ?? (isRecord(payload) ? payload : undefined);
  const rawType = nonEmptyString(errObj?.type);
  const errorType = rawType === 'error' ? undefined : rawType;
  const message =
    nonEmptyString(errObj?.message) ??
    (rawText.trim().length > 0 ? rawText.trim() : `anthropic HTTP ${status}`);

  let failureReason: AgentProviderFailureReason | undefined;
  if (errorType === 'overloaded_error') {
    failureReason = 'overloaded';
  } else if (errorType === 'rate_limit_error') {
    failureReason = 'rate-limited';
  } else if (errorType === 'api_error') {
    failureReason = 'server-error';
  } else if (errorType === 'request_too_large') {
    failureReason = 'context-overflow';
  } else if (errorType === 'invalid_request_error' && CREDIT_BALANCE_PATTERN.test(message)) {
    failureReason = 'insufficient-credits';
  }

  return {
    message,
    ...(errorType !== undefined && { errorType, code: errorType }),
    ...(failureReason !== undefined && { failureReason }),
  };
}

/** Decode a non-streaming `200 OK` Anthropic JSON message (or error envelope) into stream parts. */
export async function* decodeAnthropicJsonResponse(
  body: unknown,
  responseTimestamp?: Date,
): AsyncGenerator<AgentModelStreamPart> {
  if (!isRecord(body)) {
    throw new AgentProviderError('anthropic returned an invalid JSON response', {
      provider: 'anthropic',
    });
  }
  if (
    body.type === 'error' ||
    ('error' in body && body.error !== undefined && body.error !== null)
  ) {
    const parsed = parseAnthropicError(body, '', 200);
    throw new AgentProviderError(redactProviderFailureText(parsed.message), {
      provider: 'anthropic',
      ...(parsed.code !== undefined && { code: parsed.code }),
      ...(parsed.errorType !== undefined && { errorType: parsed.errorType }),
      ...(parsed.failureReason !== undefined && { failureReason: parsed.failureReason }),
    });
  }

  const id = nonEmptyString(body.id);
  const modelId = nonEmptyString(body.model);
  if (id !== undefined || modelId !== undefined || responseTimestamp !== undefined) {
    yield {
      type: 'response-metadata',
      ...(id !== undefined && { id }),
      ...(modelId !== undefined && { modelId }),
      ...(responseTimestamp !== undefined && { timestamp: responseTimestamp }),
    };
  }

  const content = Array.isArray(body.content) ? body.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!isRecord(block)) continue;

    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      const blockId = `text-${index}`;
      yield { type: 'text-start', id: blockId };
      if (text.length > 0) yield { type: 'text-delta', id: blockId, delta: text };
      yield { type: 'text-end', id: blockId };
      continue;
    }

    if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      const signature = typeof block.signature === 'string' ? block.signature : '';
      const blockId = `reasoning-${index}`;
      yield { type: 'reasoning-start', id: blockId };
      if (thinking.length > 0) yield { type: 'reasoning-delta', id: blockId, delta: thinking };
      yield {
        type: 'reasoning-end',
        id: blockId,
        provider: {
          schemaVersion: 1,
          provider: 'anthropic',
          data: { type: 'thinking', signature },
        },
      };
      continue;
    }

    if (block.type === 'redacted_thinking') {
      const data = typeof block.data === 'string' ? block.data : '';
      const blockId = `reasoning-${index}`;
      yield { type: 'reasoning-start', id: blockId };
      yield {
        type: 'reasoning-end',
        id: blockId,
        provider: {
          schemaVersion: 1,
          provider: 'anthropic',
          data: { type: 'redacted_thinking', data },
        },
      };
      continue;
    }

    if (block.type === 'tool_use') {
      const toolCallId = nonEmptyString(block.id) ?? crypto.randomUUID();
      const toolName = typeof block.name === 'string' ? block.name : '';
      const input = block.input !== undefined ? JSON.stringify(block.input) : '{}';
      yield { type: 'tool-input-start', toolCallId, toolName };
      yield { type: 'tool-input-delta', toolCallId, delta: input };
      yield { type: 'tool-input-end', toolCallId };
      yield { type: 'tool-call', toolCallId, toolName, input };
    }
  }

  const rawFinishReason = nonEmptyString(body.stop_reason);
  yield {
    type: 'finish',
    finishReason: mapAnthropicStopReason(rawFinishReason),
    ...(rawFinishReason !== undefined && { rawFinishReason }),
    usage: normalizeAnthropicUsage(body.usage),
    ...((id !== undefined || modelId !== undefined || responseTimestamp !== undefined) && {
      response: {
        ...(id !== undefined && { id }),
        ...(modelId !== undefined && { modelId }),
        ...(responseTimestamp !== undefined && { timestamp: responseTimestamp }),
      },
    }),
  };
}
