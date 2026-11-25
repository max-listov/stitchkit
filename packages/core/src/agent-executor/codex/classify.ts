import type { z } from 'zod';
import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { ExecutorDelta, ExecutorErrorKind } from '../vocabulary';
import {
  CODEX_QUIET_NOTIFICATIONS,
  CodexNotificationParams,
  type CodexThreadItem,
} from './protocol';

export interface CodexTurnState {
  readonly turnId: string;
  interruptRequested: boolean;
}

export type CodexVerdict =
  | { kind: 'deltas'; deltas: ExecutorDelta[] }
  | { kind: 'end'; deltas: ExecutorDelta[]; outcome: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'limits'; rateLimits: unknown }
  | { kind: 'resolved'; requestId: string }
  | { kind: 'ignore'; reason: string }
  | { kind: 'unhandled'; delta: ExecutorDelta };

const raw = (type: string) => ({ source: 'codex', type });
/** Items that are a tool call: started is the call, completed its result. */
const TOOL_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
]);
/** Items whose content streams as deltas, or that the executor itself wrote. */
const CONTENT_ITEMS = new Set([
  'agentMessage',
  'reasoning',
  'userMessage',
  'plan',
  'contextCompaction',
  'hookPrompt',
]);

function toolName(item: CodexThreadItem): string {
  const tool = Reflect.get(item, 'tool');
  return item.type === 'mcpToolCall' || item.type === 'dynamicToolCall'
    ? (nonEmptyString(tool) ?? item.type)
    : item.type;
}

function toolInput(item: CodexThreadItem): z.infer<ReturnType<typeof z.json>> {
  const { id: _id, type: _type, status: _status, aggregatedOutput: _output, ...rest } = item;
  return safeJsonValue(rest);
}

function httpStatusOf(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || typeof value !== 'object' || value === null) return undefined;
  const direct = Reflect.get(value, 'httpStatusCode');
  if (typeof direct === 'number') return direct;
  for (const nested of Object.values(value)) {
    const found = httpStatusOf(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function failureKind(info: unknown): ExecutorErrorKind {
  if (info === 'unauthorized') return 'authRequired';
  if (
    info === 'usageLimitExceeded' ||
    info === 'rateLimitExceeded' ||
    info === 'sessionBudgetExceeded'
  )
    return 'rateLimited';
  const status = httpStatusOf(info);
  if (status === 401 || status === 403) return 'authRequired';
  if (status === 429) return 'rateLimited';
  return 'restartRecommended';
}

/** One notification's meaning for the turn; a method this table does not name is `unhandled`. */
export function classifyCodexNotification(
  method: string,
  params: unknown,
  state: CodexTurnState,
): CodexVerdict {
  const base = { turnId: state.turnId };
  switch (method) {
    case 'item/agentMessage/delta': {
      const p = CodexNotificationParams[method].parse(params);
      return {
        kind: 'deltas',
        deltas: [{ type: 'text', ...base, itemId: p.itemId, raw: raw(method), text: p.delta }],
      };
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const p = CodexNotificationParams[method].parse(params);
      return {
        kind: 'deltas',
        deltas: [
          { type: 'reasoning', ...base, itemId: p.itemId, raw: raw(method), text: p.delta },
        ],
      };
    }
    case 'item/started':
    case 'item/completed': {
      const { item } = CodexNotificationParams[method].parse(params);
      if (CONTENT_ITEMS.has(item.type))
        return { kind: 'ignore', reason: `${method} ${item.type}` };
      if (!TOOL_ITEMS.has(item.type)) {
        return {
          kind: 'unhandled',
          delta: {
            type: 'error',
            ...base,
            itemId: `unhandled:${item.id}`,
            raw: raw(`${method}/${item.type}`),
            kind: 'unhandled',
            message: `Codex item ${item.type} is not known to this driver`,
          },
        };
      }
      if (method === 'item/started') {
        return {
          kind: 'deltas',
          deltas: [
            {
              type: 'tool-call',
              ...base,
              itemId: `call:${item.id}`,
              raw: raw(method),
              callId: item.id,
              toolName: toolName(item),
              input: toolInput(item),
            },
          ],
        };
      }
      const status = Reflect.get(item, 'status');
      const output =
        Reflect.get(item, 'aggregatedOutput') ??
        Reflect.get(item, 'result') ??
        Reflect.get(item, 'results') ??
        Reflect.get(item, 'contentItems') ??
        Reflect.get(item, 'changes') ??
        Reflect.get(item, 'error');
      const outcome =
        status === 'completed' || (item.type === 'webSearch' && status === undefined)
          ? 'success'
          : status === 'declined'
            ? 'interrupted'
            : 'error';
      return {
        kind: 'deltas',
        deltas: [
          {
            type: 'tool-result',
            ...base,
            itemId: `result:${item.id}`,
            raw: raw(method),
            callId: item.id,
            toolName: toolName(item),
            outcome,
            ...(output !== undefined &&
              output !== null && {
                output: safeJsonValue(output),
              }),
          },
        ],
      };
    }
    case 'turn/completed': {
      const { turn } = CodexNotificationParams[method].parse(params);
      const outcome = state.interruptRequested
        ? 'interrupted'
        : turn.status === 'completed'
          ? 'completed'
          : turn.status === 'interrupted'
            ? 'interrupted'
            : 'failed';
      const deltas: ExecutorDelta[] = [];
      if (outcome === 'failed') {
        deltas.push({
          type: 'error',
          ...base,
          itemId: 'failure',
          raw: raw(method),
          kind: failureKind(turn.error?.codexErrorInfo),
          message: turn.error?.message || `Codex ended the turn ${turn.status}`,
        });
      }
      deltas.push({ type: 'turn-end', ...base, itemId: 'end', raw: raw(method), outcome });
      return { kind: 'end', deltas, outcome };
    }
    case 'thread/tokenUsage/updated': {
      const { last } = CodexNotificationParams[method].parse(params).tokenUsage;
      return {
        kind: 'deltas',
        deltas: [
          {
            type: 'usage',
            ...base,
            itemId: 'usage',
            raw: raw(method),
            inputTokens: last.inputTokens,
            outputTokens: last.outputTokens,
            ...(last.cachedInputTokens !== undefined && {
              cachedInputTokens: last.cachedInputTokens,
            }),
          },
        ],
      };
    }
    case 'serverRequest/resolved':
      return {
        kind: 'resolved',
        requestId: String(CodexNotificationParams[method].parse(params).requestId),
      };
    case 'account/rateLimits/updated':
      return {
        kind: 'limits',
        rateLimits: CodexNotificationParams[method].parse(params).rateLimits,
      };
    default:
      if (CODEX_QUIET_NOTIFICATIONS.has(method)) return { kind: 'ignore', reason: method };
      return {
        kind: 'unhandled',
        delta: {
          type: 'error',
          ...base,
          itemId: `unhandled:${method}`,
          raw: raw(method),
          kind: 'unhandled',
          message: `Codex notification ${method} is not known to this driver`,
        },
      };
  }
}
