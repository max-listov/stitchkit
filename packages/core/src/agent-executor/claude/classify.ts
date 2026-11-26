import { z } from 'zod';
import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { ExecutorDelta, ExecutorErrorKind, ExecutorModelUsage } from '../vocabulary';
import {
  type ClaudeRuntimeEvent,
  isClaudeRuntimeSystemSubtype,
  parseClaudeRuntimeEvent,
} from './events';
import { type ClaudeRecord, ClaudeRecordSchema, ClaudeUnknownRecordSchema } from './protocol';

const MAX_MODEL_USAGE_ENTRIES = 64;
const MAX_MODEL_KEY_CHARS = 256;
const MAX_PROVIDER_CHARS = 128;

const ClaudeWireModelUsageSchema = z.looseObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative().nullish(),
  cacheCreationInputTokens: z.int().nonnegative().nullish(),
  thinkingTokens: z.int().nonnegative().nullish(),
  cacheCreationEphemeral5mInputTokens: z.int().nonnegative().nullish(),
  cacheCreationEphemeral1hInputTokens: z.int().nonnegative().nullish(),
  webSearchRequests: z.int().nonnegative().nullish(),
  costUSD: z.number().nonnegative().nullish(),
  contextWindow: z.int().nonnegative().nullish(),
  maxOutputTokens: z.int().nonnegative().nullish(),
  canonicalModel: z.string().nullish(),
  provider: z.string().nullish(),
  costBasis: z.string().nullish(),
});

/** What one turn has seen so far: which tool each call named, and whether it was asked to stop. */
export interface ClaudeTurnState {
  readonly turnId: string;
  readonly toolNames: Map<string, string>;
  interruptRequested: boolean;
  compactCount: number;
  primaryModel?: string;
}

export function newClaudeTurnState(turnId: string): ClaudeTurnState {
  return { turnId, toolNames: new Map(), interruptRequested: false, compactCount: 0 };
}

/**
 * What a record means for the turn. Every record type and every system
 * subtype the driver knows has its verdict here; anything else is
 * `unhandled`, carried as an error delta with its type, never dropped
 * silently and never guessed at.
 */
export type ClaudeVerdict =
  | { kind: 'deltas'; deltas: ExecutorDelta[] }
  | {
      kind: 'request';
      delta: Extract<ExecutorDelta, { type: 'request' }>;
      input: unknown;
      /** Validated raw tool name when non-empty; `undefined` refuses session-scoped rules. */
      toolName: string | undefined;
      /** When `true`, the engine asked not to persist a session-scoped allow rule. */
      suppressSessionRule: boolean;
    }
  | { kind: 'end'; deltas: ExecutorDelta[]; outcome: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'limits'; info: Record<string, unknown> }
  | { kind: 'event'; event: ClaudeRuntimeEvent }
  | { kind: 'session'; sessionId: string; model?: string }
  | { kind: 'ignore'; reason: string }
  | UnhandledClaudeVerdict;

/**
 * A record this driver does not know. `refuse` names a control request the CLI waits on:
 * the session answers it with an error, so the CLI is never left waiting for an answer
 * nobody will give.
 */
interface UnhandledClaudeVerdict {
  kind: 'unhandled';
  delta: ExecutorDelta;
  refuse?: { requestId: string; message: string };
}

/** System subtypes that carry nothing for the turn. */
const QUIET_SYSTEM = new Set(['hook_started', 'hook_response', 'status', 'thinking_tokens']);
/** Stream events whose content arrives in a delta or the final message. */
const QUIET_STREAM = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_stop',
]);

function raw(type: string, subtype?: string) {
  return { source: 'claude', type: subtype === undefined ? type : `${type}/${subtype}` };
}

function unhandled(
  state: ClaudeTurnState,
  type: string,
  subtype?: string,
): UnhandledClaudeVerdict {
  return {
    kind: 'unhandled',
    delta: {
      type: 'error',
      turnId: state.turnId,
      itemId: `unhandled:${type}${subtype === undefined ? '' : `/${subtype}`}`,
      raw: raw(type, subtype),
      kind: 'unhandled',
      message: `Claude record ${type}${subtype === undefined ? '' : `/${subtype}`} is not known to this driver`,
    },
  };
}

function failureKind(status: unknown): ExecutorErrorKind {
  const code = Number(status);
  if (code === 401 || code === 403) return 'authRequired';
  if (code === 429) return 'rateLimited';
  return 'restartRecommended';
}

/**
 * How a turn ended. Asked to stop, a turn that the CLI then reports as an
 * error — `error_during_execution`, an aborted stream — was interrupted, not
 * failed; and a turn asked to stop never reads as `completed` because a late
 * record said so.
 */
function outcomeOf(
  record: Extract<ClaudeRecord, { type: 'result' }>,
  state: ClaudeTurnState,
): 'completed' | 'interrupted' | 'failed' {
  if (state.interruptRequested) return 'interrupted';
  return record.is_error ? 'failed' : 'completed';
}

function normalizeCostBasis(
  value: string | null | undefined,
): ExecutorModelUsage['costBasis'] {
  return value === 'list' || value === 'managed' || value === 'unknown' ? value : undefined;
}

function extractClaudeModelUsage(
  rawMap: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, ExecutorModelUsage> | undefined {
  if (rawMap === null || rawMap === undefined) return undefined;
  const entries = new Map<string, ExecutorModelUsage>();
  for (const key of Object.keys(rawMap).sort((a, b) => a.localeCompare(b))) {
    if (entries.size >= MAX_MODEL_USAGE_ENTRIES) break;
    const trimmedKey = nonEmptyString(key)?.trim();
    if (trimmedKey === undefined) continue;
    const normalizedKey = trimmedKey.slice(0, MAX_MODEL_KEY_CHARS);
    if (normalizedKey === '__proto__' || entries.has(normalizedKey)) continue;
    const parsed = ClaudeWireModelUsageSchema.safeParse(rawMap[key]);
    if (!parsed.success) continue;
    const row = parsed.data;
    const canonicalModel = nonEmptyString(row.canonicalModel)
      ?.trim()
      .slice(0, MAX_MODEL_KEY_CHARS);
    const provider = nonEmptyString(row.provider)?.trim().slice(0, MAX_PROVIDER_CHARS);
    const costBasis = normalizeCostBasis(row.costBasis);
    entries.set(normalizedKey, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      ...(row.cacheReadInputTokens != null && {
        cacheReadInputTokens: row.cacheReadInputTokens,
      }),
      ...(row.cacheCreationInputTokens != null && {
        cacheCreationInputTokens: row.cacheCreationInputTokens,
      }),
      ...(row.thinkingTokens != null && { thinkingTokens: row.thinkingTokens }),
      ...(row.cacheCreationEphemeral5mInputTokens != null && {
        cacheCreationEphemeral5mInputTokens: row.cacheCreationEphemeral5mInputTokens,
      }),
      ...(row.cacheCreationEphemeral1hInputTokens != null && {
        cacheCreationEphemeral1hInputTokens: row.cacheCreationEphemeral1hInputTokens,
      }),
      ...(row.webSearchRequests != null && { webSearchRequests: row.webSearchRequests }),
      ...(row.costUSD != null && Number.isFinite(row.costUSD) && { costUsd: row.costUSD }),
      ...(row.contextWindow != null && { contextWindow: row.contextWindow }),
      ...(row.maxOutputTokens != null && { maxOutputTokens: row.maxOutputTokens }),
      ...(canonicalModel !== undefined && { canonicalModel }),
      ...(provider !== undefined && { provider }),
      ...(costBasis !== undefined && { costBasis }),
    });
  }
  return entries.size > 0 ? Object.fromEntries(entries) : undefined;
}

function classifyClaudeResult(
  record: Extract<ClaudeRecord, { type: 'result' }>,
  state: ClaudeTurnState,
): Extract<ClaudeVerdict, { kind: 'end' }> {
  const outcome = outcomeOf(record, state);
  const usage = record.usage;
  const thinkingTokens = usage?.output_tokens_details?.thinking_tokens;
  const modelUsage = extractClaudeModelUsage(record.modelUsage);
  const deltas: ExecutorDelta[] = [
    {
      type: 'usage',
      turnId: state.turnId,
      itemId: 'usage',
      raw: raw('result', record.subtype),
      ...(usage?.input_tokens != null && { inputTokens: usage.input_tokens }),
      ...(usage?.output_tokens != null && { outputTokens: usage.output_tokens }),
      ...(usage?.cache_read_input_tokens != null && {
        cachedInputTokens: usage.cache_read_input_tokens,
      }),
      ...(usage?.cache_creation_input_tokens != null && {
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
      }),
      ...(thinkingTokens != null && { thinkingTokens }),
      ...(record.total_cost_usd !== undefined && { costUsd: record.total_cost_usd }),
      ...(modelUsage !== undefined && { modelUsage }),
    },
  ];
  if (outcome === 'failed') {
    deltas.push({
      type: 'error',
      turnId: state.turnId,
      itemId: 'failure',
      raw: raw('result', record.subtype),
      kind: failureKind(record.api_error_status),
      message: record.result?.trim() || `Claude ended the turn with ${record.subtype}`,
    });
  }
  deltas.push({
    type: 'turn-end',
    turnId: state.turnId,
    itemId: 'end',
    raw: raw('result', record.subtype),
    outcome,
  });
  return { kind: 'end', deltas, outcome };
}

export function classifyClaudeRecord(value: unknown, state: ClaudeTurnState): ClaudeVerdict {
  const parsed = ClaudeRecordSchema.safeParse(value);
  if (!parsed.success) {
    const shape = ClaudeUnknownRecordSchema.safeParse(value);
    return unhandled(state, shape.success ? shape.data.type : 'invalid');
  }
  const record = parsed.data;
  switch (record.type) {
    case 'system':
      if (record.subtype === 'init' && record.session_id !== undefined) {
        return {
          kind: 'session',
          sessionId: record.session_id,
          ...(record.model !== undefined && { model: record.model }),
        };
      }
      if (record.subtype === 'compact_boundary') {
        state.compactCount += 1;
        const compactId =
          nonEmptyString(record.uuid) ?? `${state.turnId}:${state.compactCount}`;
        return {
          kind: 'deltas',
          deltas: [
            {
              type: 'window',
              turnId: state.turnId,
              itemId: `compact:${compactId}`,
              raw: raw('system', 'compact_boundary'),
              reset: 'context',
            },
          ],
        };
      }
      if (isClaudeRuntimeSystemSubtype(record.subtype)) {
        const event = parseClaudeRuntimeEvent(record);
        return event !== undefined
          ? { kind: 'event', event }
          : unhandled(state, 'system', record.subtype);
      }
      return QUIET_SYSTEM.has(record.subtype)
        ? { kind: 'ignore', reason: `system/${record.subtype}` }
        : unhandled(state, 'system', record.subtype);
    case 'user': {
      if (record.isReplay) return { kind: 'ignore', reason: 'the echo of the input' };
      const content = record.message.content;
      if (typeof content === 'string')
        return { kind: 'ignore', reason: 'a note the CLI addressed to itself' };
      const deltas: ExecutorDelta[] = [];
      content.forEach((block, index) => {
        if (block.type !== 'tool_result' || !('tool_use_id' in block)) return;
        const callId = nonEmptyString(block.tool_use_id) ?? `result-${index}`;
        deltas.push({
          type: 'tool-result',
          turnId: state.turnId,
          itemId: `result:${callId}`,
          raw: raw('user', 'tool_result'),
          callId,
          toolName: state.toolNames.get(callId) ?? 'unknown',
          outcome: 'is_error' in block && block.is_error === true ? 'error' : 'success',
          ...('content' in block &&
            block.content !== undefined && {
              output: safeJsonValue(block.content),
            }),
        });
      });
      return { kind: 'deltas', deltas };
    }
    case 'assistant': {
      if (record.parent_tool_use_id == null) {
        const rootModel = nonEmptyString(record.message.model)
          ?.trim()
          .slice(0, MAX_MODEL_KEY_CHARS);
        if (rootModel !== undefined) state.primaryModel = rootModel;
      }
      const deltas: ExecutorDelta[] = [];
      record.message.content.forEach((block, index) => {
        if (block.type !== 'tool_use' || !('id' in block) || !('name' in block)) return;
        const itemId = `${record.message.id}:${index}`;
        const callId = nonEmptyString(block.id) ?? itemId;
        const toolName = nonEmptyString(block.name) ?? 'unknown';
        state.toolNames.set(callId, toolName);
        deltas.push({
          type: 'tool-call',
          turnId: state.turnId,
          itemId,
          raw: raw('assistant', 'tool_use'),
          callId,
          toolName,
          input: safeJsonValue(
            'input' in block && block.input !== undefined ? block.input : null,
          ),
        });
      });
      return { kind: 'deltas', deltas };
    }
    case 'stream_event': {
      const event = record.event;
      if (event.type === 'content_block_delta' && event.delta !== undefined) {
        const itemId = `${record.api_message_id ?? 'message'}:${event.index ?? 0}`;
        const delta = event.delta;
        if (delta.type === 'text_delta' && 'text' in delta) {
          return {
            kind: 'deltas',
            deltas: [
              {
                type: 'text',
                turnId: state.turnId,
                itemId,
                raw: raw('stream_event', 'text_delta'),
                text: String(delta.text),
              },
            ],
          };
        }
        if (delta.type === 'thinking_delta' && 'thinking' in delta) {
          return {
            kind: 'deltas',
            deltas: [
              {
                type: 'reasoning',
                turnId: state.turnId,
                itemId,
                raw: raw('stream_event', 'thinking_delta'),
                text: String(delta.thinking),
              },
            ],
          };
        }
        return {
          kind: 'ignore',
          reason: `stream_event/${delta.type}: arrives in the final message`,
        };
      }
      return QUIET_STREAM.has(event.type)
        ? { kind: 'ignore', reason: `stream_event/${event.type}` }
        : unhandled(state, 'stream_event', event.type);
    }
    case 'result':
      return classifyClaudeResult(record, state);
    case 'rate_limit_event':
      return { kind: 'limits', info: record.rate_limit_info };
    case 'control_request': {
      const request = record.request;
      if (request.subtype !== 'can_use_tool' || request.tool_name === undefined) {
        return {
          ...unhandled(state, 'control_request', request.subtype),
          refuse: {
            requestId: record.request_id,
            message: `Claude control request ${request.subtype} is not known to this driver`,
          },
        };
      }
      const callId = nonEmptyString(request.tool_use_id);
      const rawToolName = nonEmptyString(request.tool_name);
      return {
        kind: 'request',
        input: request.input ?? null,
        toolName: rawToolName,
        suppressSessionRule: request.suppress_always_allow_rule === true,
        delta: {
          type: 'request',
          turnId: state.turnId,
          itemId: `request:${record.request_id}`,
          raw: raw('control_request', 'can_use_tool'),
          interactionId: record.request_id,
          kind: 'approval',
          toolName: rawToolName ?? 'tool',
          ...(callId !== undefined && { callId }),
          ...(request.input !== undefined && { input: request.input }),
        },
      };
    }
    case 'control_response':
      return { kind: 'ignore', reason: 'the answer to a request the executor sent' };
    case 'command_lifecycle':
      return { kind: 'ignore', reason: `the input's own lifecycle (${record.state})` };
    case 'tool_progress': {
      const event = parseClaudeRuntimeEvent(record);
      return event !== undefined
        ? { kind: 'event', event }
        : unhandled(state, 'tool_progress');
    }
  }
}
