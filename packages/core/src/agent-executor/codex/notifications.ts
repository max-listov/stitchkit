import { z } from 'zod';
import { JsonRpcValueSchema } from '../json-rpc-peer';
import type { CodexNotificationEvent } from './handlers';
import {
  CodexThreadItemSchema,
  CodexThreadStatusSchema,
  CodexTurnSchema,
  parseCodexResponse,
} from './protocol';

const CodexTokenUsageBreakdownSchema = z.looseObject({
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  cacheWriteInputTokens: z.int().nonnegative().optional(),
  reasoningOutputTokens: z.int().nonnegative().optional(),
  totalTokens: z.int().nonnegative().optional(),
});

/**
 * Zod schemas for typed Codex app-server notifications, covering both delta-producing
 * notifications and quiet lifecycle notifications (`thread/status/changed`, `turn/started`,
 * `item/plan/delta`, `thread/settings/updated`, `model/rerouted`).
 */
export const CodexNotificationParams = {
  'item/agentMessage/delta': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
  }),
  'item/reasoning/textDelta': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
  }),
  'item/reasoning/summaryTextDelta': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
    summaryIndex: z.number().int().optional(),
  }),
  'item/plan/delta': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
  }),
  'item/started': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    item: CodexThreadItemSchema,
  }),
  'item/completed': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    item: CodexThreadItemSchema,
  }),
  'turn/started': z.looseObject({
    threadId: z.string().optional(),
    turn: CodexTurnSchema,
  }),
  'turn/completed': z.looseObject({
    threadId: z.string().optional(),
    turn: CodexTurnSchema,
  }),
  'thread/status/changed': z.looseObject({
    threadId: z.string(),
    status: CodexThreadStatusSchema,
  }),
  'thread/settings/updated': z.looseObject({
    threadId: z.string(),
    threadSettings: z.looseObject({}),
  }),
  'model/rerouted': z.looseObject({
    threadId: z.string(),
    turnId: z.string(),
    fromModel: z.string(),
    toModel: z.string(),
    reason: z.string().optional(),
  }),
  'thread/tokenUsage/updated': z.looseObject({
    threadId: z.string().optional(),
    turnId: z.string().optional(),
    tokenUsage: z.looseObject({
      last: z.looseObject({
        inputTokens: z.int().nonnegative(),
        outputTokens: z.int().nonnegative(),
        cachedInputTokens: z.int().nonnegative().optional(),
        cacheWriteInputTokens: z.int().nonnegative().optional(),
        reasoningOutputTokens: z.int().nonnegative().optional(),
        totalTokens: z.int().nonnegative().optional(),
      }),
      total: CodexTokenUsageBreakdownSchema.optional(),
      modelContextWindow: z.int().nonnegative().nullable().optional(),
    }),
  }),
  'serverRequest/resolved': z.looseObject({
    threadId: z.string().optional(),
    requestId: z.union([z.string(), z.int()]),
  }),
  'account/rateLimits/updated': z.looseObject({
    rateLimits: JsonRpcValueSchema,
    rateLimitsByLimitId: JsonRpcValueSchema.optional(),
  }),
} as const;

/** Union of Codex notification method names with typed schemas in {@link CodexNotificationParams}. */
export type CodexNotificationMethod = keyof typeof CodexNotificationParams;

/** Discriminated union of parsed Codex app-server notifications returned by {@link parseCodexNotification}. */
export type CodexParsedNotification = {
  [M in CodexNotificationMethod]: {
    readonly method: M;
    readonly params: z.infer<(typeof CodexNotificationParams)[M]>;
  };
}[CodexNotificationMethod];

/** Quiet notifications that stay `ignore` in delta classification while offering typed schemas in {@link CodexNotificationParams}. */
export const CODEX_PARSED_QUIET_NOTIFICATIONS = [
  'thread/status/changed',
  'turn/started',
  'item/plan/delta',
  'thread/settings/updated',
  'model/rerouted',
] as const;

/** Notifications the driver asks the server not to send: noise for a turn. */
export const CODEX_OPTED_OUT_NOTIFICATIONS = [
  'app/list/updated',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'turn/diff/updated',
  'mcpServer/startupStatus/updated',
  'remoteControl/status/changed',
  'skills/changed',
];

/** Notifications a turn sees and that carry nothing for it. */
export const CODEX_QUIET_NOTIFICATIONS = new Set([
  ...CODEX_OPTED_OUT_NOTIFICATIONS,
  'thread/started',
  'thread/status/changed',
  'thread/readState/changed',
  'thread/archived',
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'thread/reverted',
  'thread/name/updated',
  'thread/section/changed',
  'thread/attachment/updated',
  'thread/goal/updated',
  'thread/prediction/updated',
  'thread/goal/cleared',
  'thread/queue/changed',
  'project/changed',
  'thread/project/updated',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/settings/updated',
  'thread/compacted',
  'turn/started',
  'turn/plan/updated',
  'turn/moderationMetadata',
  'item/plan/delta',
  'item/commandExecution/terminalInteraction',
  'item/mcpToolCall/progress',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'autoApprovalReview/strictReviewRequired',
  'item/reasoning/summaryPartAdded',
  'hook/started',
  'hook/completed',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'windows/worldWritableWarning',
  'account/updated',
  'account/gatewayOAuth/changed',
  'model/rerouted',
  'model/verification',
  'model/safetyBuffering/updated',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  // The failure arrives again, final, with the turn: `turn/completed` carries it.
  'error',
]);

/**
 * Parse a raw Codex notification event into a discriminated union by `method`.
 * Returns `null` for methods not listed in {@link CodexNotificationParams}; throws
 * {@link CodexProtocolError} when a known method carries malformed params.
 */
export function parseCodexNotification(
  event: Pick<CodexNotificationEvent, 'method' | 'params'>,
): CodexParsedNotification | null {
  const { method, params } = event;
  switch (method) {
    case 'item/agentMessage/delta':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'item/reasoning/textDelta':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'item/reasoning/summaryTextDelta':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'item/plan/delta':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'item/started':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'item/completed':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'turn/started':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'turn/completed':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'thread/status/changed':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'thread/settings/updated':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'model/rerouted':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'thread/tokenUsage/updated':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'serverRequest/resolved':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    case 'account/rateLimits/updated':
      return {
        method,
        params: parseCodexResponse(
          method,
          CodexNotificationParams[method],
          params,
          'notification',
        ),
      };
    default:
      return null;
  }
}
