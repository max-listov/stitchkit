import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { ExecutorDelta, ExecutorErrorKind } from '../vocabulary';
import { type ClaudeRecord, ClaudeRecordSchema, ClaudeUnknownRecordSchema } from './protocol';

/** What one turn has seen so far: which tool each call named, and whether it was asked to stop. */
export interface ClaudeTurnState {
  readonly turnId: string;
  readonly toolNames: Map<string, string>;
  interruptRequested: boolean;
}

export function newClaudeTurnState(turnId: string): ClaudeTurnState {
  return { turnId, toolNames: new Map(), interruptRequested: false };
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
    }
  | { kind: 'end'; deltas: ExecutorDelta[]; outcome: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'limits'; info: Record<string, unknown> }
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
const QUIET_SYSTEM = new Set([
  'hook_started',
  'hook_response',
  'status',
  'thinking_tokens',
  'compact_boundary',
  'api_retry',
]);
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
    case 'result': {
      const outcome = outcomeOf(record, state);
      const usage = record.usage;
      const deltas: ExecutorDelta[] = [
        {
          type: 'usage',
          turnId: state.turnId,
          itemId: 'usage',
          raw: raw('result', record.subtype),
          ...(usage?.input_tokens !== undefined && { inputTokens: usage.input_tokens }),
          ...(usage?.output_tokens !== undefined && { outputTokens: usage.output_tokens }),
          ...(usage?.cache_read_input_tokens !== undefined && {
            cachedInputTokens: usage.cache_read_input_tokens,
          }),
          ...(record.total_cost_usd !== undefined && { costUsd: record.total_cost_usd }),
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
      return {
        kind: 'request',
        input: request.input ?? null,
        delta: {
          type: 'request',
          turnId: state.turnId,
          itemId: `request:${record.request_id}`,
          raw: raw('control_request', 'can_use_tool'),
          interactionId: record.request_id,
          kind: 'approval',
          toolName: nonEmptyString(request.tool_name) ?? 'tool',
          ...(callId !== undefined && { callId }),
          ...(request.input !== undefined && { input: request.input }),
        },
      };
    }
    case 'control_response':
      return { kind: 'ignore', reason: 'the answer to a request the executor sent' };
    case 'command_lifecycle':
      return { kind: 'ignore', reason: `the input's own lifecycle (${record.state})` };
  }
}
