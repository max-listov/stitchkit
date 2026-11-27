import type { z } from 'zod';
import { nonEmptyString, safeJsonValue } from '../session-primitives';
import type { ExecutorDelta, ExecutorErrorKind, ExecutorTokenUsage } from '../vocabulary';
import { CODEX_QUIET_NOTIFICATIONS, CodexNotificationParams } from './notifications';
import type { CodexThreadItem, CodexTurnSchema } from './protocol';

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
export const CODEX_TOOL_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'functionCallOutput',
]);
/** Tool items whose 0.171.0 schema carries no `status` field (completion implies success). */
const STATUSLESS_TOOL_ITEMS = new Set([
  'webSearch',
  'imageView',
  'sleep',
  'functionCallOutput',
]);
/** Items whose content streams as deltas, or lifecycle markers that emit no tool call. */
export const CODEX_CONTENT_ITEMS = new Set([
  'agentMessage',
  'reasoning',
  'userMessage',
  'plan',
  'contextCompaction',
  'hookPrompt',
  'subAgentActivity',
  'enteredReviewMode',
  'exitedReviewMode',
]);

/** Known string codes in `codex-cli 0.171.0` `CodexErrorInfo`. */
const KNOWN_CODEX_ERROR_CODES = new Set([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'modelNotFound',
  'policyCapacityUnavailable',
  'cyberPolicy',
  'bioPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
  'inferenceHookDenied',
]);
/** Known tagged object keys in `codex-cli 0.171.0` `CodexErrorInfo`. */
const KNOWN_CODEX_ERROR_OBJECT_KEYS = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
]);
const MAX_ERROR_INFO_SUMMARY_CHARS = 512;

function toolName(item: CodexThreadItem): string {
  if (
    item.type === 'mcpToolCall' ||
    item.type === 'dynamicToolCall' ||
    item.type === 'collabAgentToolCall'
  ) {
    return nonEmptyString(Reflect.get(item, 'tool')) ?? item.type;
  }
  if (item.type === 'functionCallOutput') {
    return nonEmptyString(Reflect.get(item, 'name')) ?? item.type;
  }
  return item.type;
}

function toolInput(item: CodexThreadItem): z.infer<ReturnType<typeof z.json>> {
  const { id: _id, type: _type, status: _status, aggregatedOutput: _output, ...rest } = item;
  return safeJsonValue(rest);
}

function isKnownCodexErrorInfo(info: unknown): boolean {
  if (typeof info === 'string') return KNOWN_CODEX_ERROR_CODES.has(info);
  if (typeof info === 'object' && info !== null && !Array.isArray(info)) {
    const keys = Object.keys(info);
    return (
      keys.length === 1 && keys[0] !== undefined && KNOWN_CODEX_ERROR_OBJECT_KEYS.has(keys[0])
    );
  }
  return false;
}

function formatCodexErrorInfo(info: unknown): string | undefined {
  if (info === null || info === undefined) return undefined;
  if (typeof info === 'string') {
    const trimmed = info.trim();
    return trimmed.length > 0 ? trimmed.slice(0, MAX_ERROR_INFO_SUMMARY_CHARS) : undefined;
  }
  try {
    const serialized = JSON.stringify(safeJsonValue(info));
    if (serialized === undefined || serialized.length === 0) return undefined;
    return serialized.length > MAX_ERROR_INFO_SUMMARY_CHARS
      ? `${serialized.slice(0, MAX_ERROR_INFO_SUMMARY_CHARS - 1)}…`
      : serialized;
  } catch {
    return String(info).slice(0, MAX_ERROR_INFO_SUMMARY_CHARS);
  }
}

function codexFailureMessage(turn: z.infer<typeof CodexTurnSchema>): string {
  const rawMessage = turn.error?.message.trim() ?? '';
  const info = turn.error?.codexErrorInfo;
  const infoSummary = formatCodexErrorInfo(info);
  if (rawMessage.length > 0) {
    if (
      infoSummary !== undefined &&
      !isKnownCodexErrorInfo(info) &&
      !rawMessage.includes(infoSummary)
    ) {
      return `${rawMessage} (${infoSummary})`;
    }
    return rawMessage;
  }
  if (infoSummary !== undefined) {
    return `Codex ended the turn ${turn.status} (${infoSummary})`;
  }
  return `Codex ended the turn ${turn.status}`;
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

function normalizeCodexTokenTotals(
  rawTotals:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        cacheWriteInputTokens?: number;
        reasoningOutputTokens?: number;
        totalTokens?: number;
      }
    | undefined,
): ExecutorTokenUsage | undefined {
  if (rawTotals === undefined) return undefined;
  const normalized: ExecutorTokenUsage = {
    ...(rawTotals.inputTokens !== undefined && { inputTokens: rawTotals.inputTokens }),
    ...(rawTotals.outputTokens !== undefined && { outputTokens: rawTotals.outputTokens }),
    ...(rawTotals.cachedInputTokens !== undefined && {
      cachedInputTokens: rawTotals.cachedInputTokens,
    }),
    ...(rawTotals.cacheWriteInputTokens !== undefined && {
      cacheCreationInputTokens: rawTotals.cacheWriteInputTokens,
    }),
    ...(rawTotals.reasoningOutputTokens !== undefined && {
      thinkingTokens: rawTotals.reasoningOutputTokens,
    }),
    ...(rawTotals.totalTokens !== undefined && { totalTokens: rawTotals.totalTokens }),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function classifyCodexTokenUsage(params: unknown, base: { turnId: string }): CodexVerdict {
  const { last, total } =
    CodexNotificationParams['thread/tokenUsage/updated'].parse(params).tokenUsage;
  const normalizedTotal = normalizeCodexTokenTotals(total);
  return {
    kind: 'deltas',
    deltas: [
      {
        type: 'usage',
        ...base,
        itemId: 'usage',
        raw: raw('thread/tokenUsage/updated'),
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        ...(last.cachedInputTokens !== undefined && {
          cachedInputTokens: last.cachedInputTokens,
        }),
        ...(last.cacheWriteInputTokens !== undefined && {
          cacheCreationInputTokens: last.cacheWriteInputTokens,
        }),
        ...(last.reasoningOutputTokens !== undefined && {
          thinkingTokens: last.reasoningOutputTokens,
        }),
        ...(last.totalTokens !== undefined && { totalTokens: last.totalTokens }),
        ...(normalizedTotal !== undefined && { total: normalizedTotal }),
      },
    ],
  };
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
      if (CODEX_CONTENT_ITEMS.has(item.type))
        return { kind: 'ignore', reason: `${method} ${item.type}` };
      if (!CODEX_TOOL_ITEMS.has(item.type)) {
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
      const failure = Reflect.get(item, 'failure');
      const output =
        failure ??
        Reflect.get(item, 'aggregatedOutput') ??
        Reflect.get(item, 'output') ??
        Reflect.get(item, 'savedPath') ??
        Reflect.get(item, 'fileId') ??
        Reflect.get(item, 'result') ??
        Reflect.get(item, 'results') ??
        Reflect.get(item, 'contentItems') ??
        Reflect.get(item, 'changes') ??
        Reflect.get(item, 'agentsStates') ??
        Reflect.get(item, 'error');
      const hasFailure = failure !== undefined && failure !== null;
      const outcome =
        !hasFailure &&
        (status === 'completed' ||
          (STATUSLESS_TOOL_ITEMS.has(item.type) && status === undefined))
          ? 'success'
          : status === 'declined' || status === 'interrupted'
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
          message: codexFailureMessage(turn),
        });
      }
      deltas.push({ type: 'turn-end', ...base, itemId: 'end', raw: raw(method), outcome });
      return { kind: 'end', deltas, outcome };
    }
    case 'thread/tokenUsage/updated':
      return classifyCodexTokenUsage(params, base);
    case 'serverRequest/resolved':
      return {
        kind: 'resolved',
        requestId: String(CodexNotificationParams[method].parse(params).requestId),
      };
    case 'account/rateLimits/updated': {
      const parsed = CodexNotificationParams[method].parse(params);
      return {
        kind: 'limits',
        rateLimits:
          parsed.rateLimitsByLimitId !== undefined
            ? {
                rateLimits: parsed.rateLimits,
                rateLimitsByLimitId: parsed.rateLimitsByLimitId,
              }
            : parsed.rateLimits,
      };
    }
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
