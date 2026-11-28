import type { AgentModelJsonValue } from '../agent-parts/model';
import type { AgentProviderEnvelope, AgentSourcePart } from '../agent-parts/parts';
import { isRecord } from '../internal/typed';
import type { AgentModelFinishReason, AgentModelStreamPart } from './models-driver';
import { AgentProviderError, type AgentProviderFailureReason } from './provider-failure';
import {
  nonEmptyString,
  type ParsedProviderError,
  redactProviderFailureText,
} from './provider-http';
import { buildProviderUsage, reportedInt } from './provider-usage';
import type { AgentUsage } from './schemas-usage';

const OPENAI_CODE_TO_REASON: ReadonlyMap<string, AgentProviderFailureReason> = new Map([
  ['insufficient_quota', 'insufficient-credits'],
  ['billing_hard_limit_reached', 'insufficient-credits'],
  ['context_length_exceeded', 'context-overflow'],
  ['model_context_window_exceeded', 'context-overflow'],
  ['string_above_max_length', 'context-overflow'],
  ['rate_limit_exceeded', 'rate-limited'],
  ['rate_limit_error', 'rate-limited'],
  ['server_error', 'server-error'],
  ['internal_server_error', 'server-error'],
  ['api_error', 'server-error'],
  ['service_unavailable', 'server-error'],
  ['model_not_found', 'model-unavailable'],
]);

export interface OpenAiReasoningSummaryEntry {
  readonly type: 'summary_text';
  readonly text: string;
}

/**
 * Normalize an OpenAI Responses `usage` payload into provenance-honest `AgentUsage`.
 *
 * OpenAI's `input_tokens` already includes `input_tokens_details.cached_tokens`, and
 * `output_tokens` already includes `output_tokens_details.reasoning_tokens`.
 * Cache write counts and USD cost are not reported on the Responses wire format and
 * stay `unavailable` rather than being fabricated as zero.
 */
export function normalizeOpenAiUsage(rawUsage: unknown): AgentUsage {
  const raw = isRecord(rawUsage) ? rawUsage : {};
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  return buildProviderUsage({
    inputTokens: reportedInt(raw.input_tokens),
    outputTokens: reportedInt(raw.output_tokens),
    cacheReadTokens: reportedInt(inputDetails.cached_tokens),
    reasoningTokens: reportedInt(outputDetails.reasoning_tokens),
    cacheWriteTokens: { provenance: 'unavailable' },
    cost: { provenance: 'unavailable' },
  });
}

function unwrapOpenAiErrorObject(payload: unknown): {
  readonly object: Record<string, unknown> | undefined;
  readonly unwrapped: boolean;
} {
  if (!isRecord(payload)) return { object: undefined, unwrapped: false };
  if (isRecord(payload.error)) return { object: payload.error, unwrapped: true };
  if (isRecord(payload.response) && isRecord(payload.response.error)) {
    return { object: payload.response.error, unwrapped: true };
  }
  return { object: payload, unwrapped: false };
}

/**
 * Parse an OpenAI HTTP or Responses SSE error payload into structured failure metadata.
 *
 * Maps `insufficient_quota` explicitly to `'insufficient-credits'` so HTTP 429 quota
 * exhaustion is never misclassified as transient `'rate-limited'`.
 */
export function parseOpenAiError(
  payload: unknown,
  rawText: string,
  status: number,
): ParsedProviderError {
  const { object: err, unwrapped } = unwrapOpenAiErrorObject(payload);
  const code =
    typeof err?.code === 'string' && err.code.length > 0
      ? err.code
      : typeof err?.code === 'number'
        ? err.code
        : undefined;
  const rawType = nonEmptyString(err?.type);
  const errorType =
    rawType !== undefined && (unwrapped || rawType !== 'error') ? rawType : undefined;
  const param = nonEmptyString(err?.param);

  const byCode =
    typeof code === 'string' ? OPENAI_CODE_TO_REASON.get(code.toLowerCase()) : undefined;
  const byType =
    errorType !== undefined ? OPENAI_CODE_TO_REASON.get(errorType.toLowerCase()) : undefined;
  const failureReason = byCode ?? byType;

  const message =
    nonEmptyString(err?.message) ??
    (rawText.trim().length > 0 ? rawText.trim() : `openai HTTP ${status}`);

  return {
    message,
    ...(code !== undefined && { code }),
    ...(errorType !== undefined && { errorType }),
    ...(failureReason !== undefined && { failureReason }),
    ...(param !== undefined && { metadata: { param } }),
  };
}

/** Construct a redacted `AgentProviderError` from a mid-stream or JSON-body OpenAI failure. */
export function createOpenAiStreamError(
  payload: unknown,
  fallbackMessage: string,
  statusCode?: number,
): AgentProviderError {
  const details = parseOpenAiError(payload, fallbackMessage, statusCode ?? 500);
  const message = redactProviderFailureText(details.message || fallbackMessage);
  return new AgentProviderError(message, {
    provider: 'openai',
    ...(statusCode !== undefined && { statusCode }),
    ...(details.code !== undefined && { code: details.code }),
    ...(details.errorType !== undefined && { errorType: details.errorType }),
    ...(details.failureReason !== undefined && { failureReason: details.failureReason }),
    ...(details.metadata !== undefined && { metadata: details.metadata }),
  });
}

/** Map `response.incomplete.incomplete_details.reason` to a canonical finish reason. */
export function mapOpenAiIncompleteReason(reason: unknown): AgentModelFinishReason {
  switch (reason) {
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'other';
  }
}

/** Compute canonical `finishReason` and `rawFinishReason` for a completed or incomplete response. */
export function resolveOpenAiFinishReason(input: {
  readonly status: string | undefined;
  readonly incompleteDetails: unknown;
  readonly hasToolCalls: boolean;
  readonly sawText: boolean;
  readonly sawRefusal: boolean;
}): { readonly finishReason: AgentModelFinishReason; readonly rawFinishReason: string } {
  if (input.status === 'incomplete') {
    const details = isRecord(input.incompleteDetails) ? input.incompleteDetails : undefined;
    const reason = nonEmptyString(details?.reason);
    return {
      finishReason: mapOpenAiIncompleteReason(reason),
      rawFinishReason: reason ?? 'incomplete',
    };
  }
  const finishReason: AgentModelFinishReason = input.hasToolCalls
    ? 'tool-calls'
    : input.sawRefusal && !input.sawText
      ? 'content-filter'
      : 'stop';
  return { finishReason, rawFinishReason: input.status ?? 'completed' };
}

/** Extract a `url_citation` annotation into a canonical `AgentSourcePart`, when valid. */
export function extractOpenAiUrlCitation(annotation: unknown): AgentSourcePart | undefined {
  if (!isRecord(annotation) || annotation.type !== 'url_citation') return undefined;
  const url = nonEmptyString(annotation.url);
  if (url === undefined || !URL.canParse(url)) return undefined;
  const title = nonEmptyString(annotation.title);
  return {
    type: 'source',
    sourceId: crypto.randomUUID(),
    url,
    ...(title !== undefined && { title }),
  };
}

/** Extract structured `summary_text` entries from a Responses reasoning item's `summary`. */
export function extractOpenAiReasoningSummary(raw: unknown): OpenAiReasoningSummaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: OpenAiReasoningSummaryEntry[] = [];
  for (const item of raw) {
    if (isRecord(item) && typeof item.text === 'string') {
      entries.push({ type: 'summary_text', text: item.text });
    }
  }
  return entries;
}

/** Build the opaque OpenAI reasoning envelope persisted for stateless (`store: false`) round-trip. */
export function buildOpenAiReasoningEnvelope(item: {
  readonly id?: string;
  readonly summary: readonly OpenAiReasoningSummaryEntry[];
  readonly encryptedContent?: string;
}): AgentProviderEnvelope {
  const summaryJson: AgentModelJsonValue[] = item.summary.map((entry) => ({
    type: entry.type,
    text: entry.text,
  }));
  const data: Record<string, AgentModelJsonValue> = {
    type: 'reasoning',
    ...(item.id !== undefined && item.id.length > 0 && { id: item.id }),
    summary: summaryJson,
    ...(item.encryptedContent !== undefined &&
      item.encryptedContent.length > 0 && {
        encrypted_content: item.encryptedContent,
      }),
  };
  return { schemaVersion: 1, provider: 'openai', data };
}

/** Build the opaque OpenAI phase envelope for assistant messages (`commentary` / `final_answer`). */
export function buildOpenAiPhaseEnvelope(phase: string): AgentProviderEnvelope {
  return { schemaVersion: 1, provider: 'openai', data: { phase } };
}

/** Build the opaque OpenAI tool-call envelope carrying the Responses item id (`fc_*`). */
export function buildOpenAiToolCallEnvelope(itemId: string): AgentProviderEnvelope {
  return { schemaVersion: 1, provider: 'openai', data: { itemId } };
}

/** Extract combined `output_text`, `url_citation` sources, and refusal presence from a message's `content`. */
export function scanOpenAiMessageContent(content: unknown): {
  readonly text: string;
  readonly sawRefusal: boolean;
  readonly sources: AgentSourcePart[];
} {
  let text = '';
  let sawRefusal = false;
  const sources: AgentSourcePart[] = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!isRecord(part)) continue;
    if (part.type === 'output_text' && typeof part.text === 'string') {
      text += part.text;
      if (Array.isArray(part.annotations)) {
        for (const annotation of part.annotations) {
          const source = extractOpenAiUrlCitation(annotation);
          if (source !== undefined) sources.push(source);
        }
      }
    } else if (part.type === 'refusal') {
      sawRefusal = true;
    }
  }
  return { text, sawRefusal, sources };
}

/** Build the terminal `finish` stream part shared by SSE and non-streaming JSON decoders. */
export function buildOpenAiFinishPart(input: {
  readonly status: string | undefined;
  readonly incompleteDetails: unknown;
  readonly usage: unknown;
  readonly hasToolCalls: boolean;
  readonly sawText: boolean;
  readonly sawRefusal: boolean;
  readonly responseId?: string;
  readonly responseModelId?: string;
  readonly responseTimestamp?: Date;
}): Extract<AgentModelStreamPart, { type: 'finish' }> {
  const { finishReason, rawFinishReason } = resolveOpenAiFinishReason(input);
  return {
    type: 'finish',
    finishReason,
    rawFinishReason,
    usage: normalizeOpenAiUsage(input.usage),
    ...((input.responseId !== undefined ||
      input.responseModelId !== undefined ||
      input.responseTimestamp !== undefined) && {
      response: {
        ...(input.responseId !== undefined && { id: input.responseId }),
        ...(input.responseModelId !== undefined && { modelId: input.responseModelId }),
        ...(input.responseTimestamp !== undefined && { timestamp: input.responseTimestamp }),
      },
    }),
  };
}

function* decodeMessageOutputItem(
  item: Record<string, unknown>,
  index: number,
  flags: { sawText: boolean; sawRefusal: boolean },
): Generator<AgentModelStreamPart> {
  const textId = nonEmptyString(item.id) ?? `text-${index}`;
  const phase = nonEmptyString(item.phase);
  const scanned = scanOpenAiMessageContent(item.content);
  if (scanned.sawRefusal) flags.sawRefusal = true;
  if (scanned.text.length > 0) {
    flags.sawText = true;
    yield { type: 'text-start', id: textId };
    yield { type: 'text-delta', id: textId, delta: scanned.text };
    yield {
      type: 'text-end',
      id: textId,
      ...(phase !== undefined && { provider: buildOpenAiPhaseEnvelope(phase) }),
    };
  }
  for (const source of scanned.sources) yield { type: 'source', source };
}

/** Decode a non-streaming `200 OK` OpenAI Responses JSON payload (or JSON error envelope). */
export async function* decodeOpenAiJsonResponse(
  body: unknown,
): AsyncGenerator<AgentModelStreamPart> {
  if (!isRecord(body)) {
    throw new AgentProviderError('openai returned an invalid JSON response', {
      provider: 'openai',
      statusCode: 200,
    });
  }
  if (
    ('error' in body && body.error !== undefined && body.error !== null) ||
    body.status === 'failed'
  ) {
    throw createOpenAiStreamError(body, 'OpenAI response failed', 200);
  }

  const id = nonEmptyString(body.id);
  const modelId = nonEmptyString(body.model);
  const timestamp =
    typeof body.created_at === 'number' &&
    Number.isFinite(body.created_at) &&
    body.created_at >= 0
      ? new Date(body.created_at * 1000)
      : undefined;
  if (id !== undefined || modelId !== undefined || timestamp !== undefined) {
    yield {
      type: 'response-metadata',
      ...(id !== undefined && { id }),
      ...(modelId !== undefined && { modelId }),
      ...(timestamp !== undefined && { timestamp }),
    };
  }

  const output = Array.isArray(body.output) ? body.output : [];
  const flags = { sawText: false, sawRefusal: false };
  let hasToolCalls = false;

  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (!isRecord(item)) continue;
    if (item.type === 'reasoning') {
      const itemId = nonEmptyString(item.id);
      const reasoningId = itemId ?? `reasoning-${index}`;
      const summary = extractOpenAiReasoningSummary(item.summary);
      const encryptedContent = nonEmptyString(item.encrypted_content);
      const summaryText = summary.map((entry) => entry.text).join('\n');
      yield { type: 'reasoning-start', id: reasoningId };
      if (summaryText.length > 0) {
        yield { type: 'reasoning-delta', id: reasoningId, delta: summaryText };
      }
      yield {
        type: 'reasoning-end',
        id: reasoningId,
        provider: buildOpenAiReasoningEnvelope({
          ...(itemId !== undefined && { id: itemId }),
          summary,
          ...(encryptedContent !== undefined && { encryptedContent }),
        }),
      };
      continue;
    }
    if (item.type === 'message') {
      yield* decodeMessageOutputItem(item, index, flags);
      continue;
    }
    if (item.type === 'function_call') {
      hasToolCalls = true;
      const toolCallId = nonEmptyString(item.call_id) ?? crypto.randomUUID();
      const itemId = nonEmptyString(item.id);
      const toolName = typeof item.name === 'string' ? item.name : '';
      const args =
        typeof item.arguments === 'string' && item.arguments.trim().length > 0
          ? item.arguments
          : '{}';
      yield { type: 'tool-input-start', toolCallId, toolName };
      yield { type: 'tool-input-delta', toolCallId, delta: args };
      yield { type: 'tool-input-end', toolCallId };
      yield {
        type: 'tool-call',
        toolCallId,
        toolName,
        input: args,
        ...(itemId !== undefined && { provider: buildOpenAiToolCallEnvelope(itemId) }),
      };
    }
  }

  yield buildOpenAiFinishPart({
    status: nonEmptyString(body.status),
    incompleteDetails: body.incomplete_details,
    usage: body.usage,
    hasToolCalls,
    sawText: flags.sawText,
    sawRefusal: flags.sawRefusal,
    ...(id !== undefined && { responseId: id }),
    ...(modelId !== undefined && { responseModelId: modelId }),
    ...(timestamp !== undefined && { responseTimestamp: timestamp }),
  });
}
