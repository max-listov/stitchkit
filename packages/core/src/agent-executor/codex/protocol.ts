import { z } from 'zod';
import type { JsonRpcValue } from '../json-rpc-peer';
import { safeJsonValue } from '../session-primitives';

/**
 * The slice of Codex's app-server protocol (0.171.0, JSON-RPC over stdio or
 * WebSocket-over-Unix-socket without the `jsonrpc` header) the driver reads.
 * Every schema lets fields it does not use through; a test checks each against
 * the JSON Schema the pinned CLI generates, so a renamed field fails there and
 * not in a turn.
 */

/** Approval policy values accepted by Codex `thread/start`, `thread/resume`, `thread/fork`, and `turn/start`. */
export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | Readonly<Record<string, JsonRpcValue>>;

/** Sandbox mode values accepted by Codex `thread/start`, `thread/resume`, and `thread/fork`. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Collaboration mode settings passed on `turn/start`. */
export const CodexCollaborationModeSchema = z.strictObject({
  mode: z.enum(['plan', 'default']),
  settings: z.strictObject({
    model: z.string().min(1),
    reasoning_effort: z.string().min(1).nullable().optional(),
    developer_instructions: z.string().nullable().optional(),
  }),
});
/** Collaboration mode override accepted by Codex `turn/start`. */
export type CodexCollaborationMode = z.infer<typeof CodexCollaborationModeSchema>;

export const CodexThreadItemSchema = z.looseObject({
  type: z.string(),
  id: z.string().min(1),
});
export type CodexThreadItem = z.infer<typeof CodexThreadItemSchema>;

export const CodexTurnSchema = z.looseObject({
  id: z.string().min(1),
  status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
  error: z
    .looseObject({ message: z.string(), codexErrorInfo: z.json().nullable().optional() })
    .nullable()
    .optional(),
  items: z
    .array(z.looseObject({ type: z.string(), clientId: z.string().nullable().optional() }))
    .optional(),
});

const CodexTokenUsageBreakdownSchema = z.looseObject({
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cachedInputTokens: z.int().nonnegative().optional(),
  cacheWriteInputTokens: z.int().nonnegative().optional(),
  reasoningOutputTokens: z.int().nonnegative().optional(),
  totalTokens: z.int().nonnegative().optional(),
});

export const CodexNotificationParams = {
  'item/agentMessage/delta': z.looseObject({ itemId: z.string(), delta: z.string() }),
  'item/reasoning/textDelta': z.looseObject({ itemId: z.string(), delta: z.string() }),
  'item/reasoning/summaryTextDelta': z.looseObject({ itemId: z.string(), delta: z.string() }),
  'item/started': z.looseObject({ item: CodexThreadItemSchema }),
  'item/completed': z.looseObject({ item: CodexThreadItemSchema }),
  'turn/completed': z.looseObject({ turn: CodexTurnSchema }),
  'thread/tokenUsage/updated': z.looseObject({
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
  'serverRequest/resolved': z.looseObject({ requestId: z.union([z.string(), z.int()]) }),
  'account/rateLimits/updated': z.looseObject({
    rateLimits: z.json(),
    rateLimitsByLimitId: z.json().optional(),
  }),
} as const;

export const CodexApprovalParamsSchema = z.looseObject({
  itemId: z.string(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  grantRoot: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  approvalId: z.string().nullable().optional(),
  commandActions: z.array(z.json()).nullable().optional(),
  availableDecisions: z.array(z.json()).nullable().optional(),
});

export const CodexUserInputOptionSchema = z.looseObject({
  label: z.string(),
  description: z.string(),
});

export const CodexUserInputQuestionSchema = z.looseObject({
  id: z.string(),
  question: z.string(),
  header: z.string(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(CodexUserInputOptionSchema).nullable().optional(),
});

export const CodexUserInputParamsSchema = z.looseObject({
  itemId: z.string(),
  questions: z.array(CodexUserInputQuestionSchema),
});

/** Answers to `item/tool/requestUserInput`: question id → the chosen answers. */
export const CodexUserInputAnswersSchema = z.record(
  z.string(),
  z.strictObject({ answers: z.array(z.string()) }),
);

/** Permission profile requested or granted on `item/permissions/requestApproval`. */
export const CodexPermissionProfileSchema = z.looseObject({
  fileSystem: z.json().nullable().optional(),
  network: z.json().nullable().optional(),
});

/** Parameters of Codex `item/permissions/requestApproval` (0.171.0). */
export const CodexPermissionsApprovalParamsSchema = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  cwd: z.string(),
  permissions: CodexPermissionProfileSchema,
  startedAtMs: z.number().int(),
  reason: z.string().nullable().optional(),
  environmentId: z.string().nullable().optional(),
});

const CodexMcpElicitationBaseFields = {
  serverName: z.string(),
  threadId: z.string(),
  turnId: z.string().nullable().optional(),
  environmentId: z.string().nullable().optional(),
  message: z.string(),
  _meta: z.json().optional(),
};

const CodexMcpElicitationFormSchemaSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), z.json()),
  required: z.array(z.string()).nullable().optional(),
  $schema: z.string().nullable().optional(),
});

/** Parameters of Codex `mcpServer/elicitation/request` across all four `oneOf` modes (0.171.0). */
export const CodexMcpElicitationParamsSchema = z.discriminatedUnion('mode', [
  z.looseObject({
    ...CodexMcpElicitationBaseFields,
    mode: z.literal('form'),
    requestedSchema: CodexMcpElicitationFormSchemaSchema,
  }),
  z.looseObject({
    ...CodexMcpElicitationBaseFields,
    mode: z.literal('openai/form'),
    requestedSchema: z.json(),
  }),
  z.looseObject({
    ...CodexMcpElicitationBaseFields,
    mode: z.literal('openaiForm'),
    requestedSchema: z.json(),
  }),
  z.looseObject({
    ...CodexMcpElicitationBaseFields,
    mode: z.literal('url'),
    elicitationId: z.string(),
    url: z.string(),
  }),
]);

/** Elicitation request mode discriminated by Codex `mcpServer/elicitation/request`. */
export type CodexMcpElicitationMode = z.infer<typeof CodexMcpElicitationParamsSchema>['mode'];

/** Answer payload for `mcpServer/elicitation/request`, matching `McpServerElicitationRequestResponse`. */
export const CodexMcpElicitationAnswerSchema = z.strictObject({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.json().optional(),
  _meta: z.json().optional(),
});

/** Applied thread policy and runtime context returned by `thread/start`, `thread/resume`, or `thread/fork`. */
export const CodexThreadContextSchema = z.object({
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  approvalPolicy: z.json().optional(),
  sandbox: z.json().optional(),
  cwd: z.string().optional(),
  runtimeWorkspaceRoots: z.array(z.string()).readonly().optional(),
  thread: z.json().optional(),
});
/** Applied policy and model context reported by Codex when opening, resuming, or forking a thread. */
export type CodexThreadContext = Readonly<z.infer<typeof CodexThreadContextSchema>>;

export const CodexInitializeResponseSchema = z.looseObject({
  userAgent: z.string().nullable().optional(),
});

export const CodexStartedThreadSchema = CodexThreadContextSchema.extend({
  thread: z.looseObject({ id: z.string().min(1) }),
}).loose();

/** Extract the normalized applied thread context from a parsed `thread/start`, `thread/resume`, or `thread/fork` reply. */
export function extractCodexThreadContext(
  parsed: z.infer<typeof CodexStartedThreadSchema>,
): CodexThreadContext {
  return {
    ...(parsed.model !== undefined && { model: parsed.model }),
    ...(parsed.modelProvider !== undefined && { modelProvider: parsed.modelProvider }),
    ...(parsed.reasoningEffort !== undefined && { reasoningEffort: parsed.reasoningEffort }),
    ...(parsed.approvalPolicy !== undefined && { approvalPolicy: parsed.approvalPolicy }),
    ...(parsed.sandbox !== undefined && { sandbox: parsed.sandbox }),
    ...(parsed.cwd !== undefined && { cwd: parsed.cwd }),
    ...(parsed.runtimeWorkspaceRoots !== undefined && {
      runtimeWorkspaceRoots: parsed.runtimeWorkspaceRoots,
    }),
    thread: safeJsonValue(parsed.thread),
  };
}

export const CodexStartedTurnSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});
export const CodexTurnSteerResponseSchema = z.looseObject({
  turnId: z.string().min(1),
});
export const CodexListedTurnItemSchema = z.looseObject({
  type: z.string(),
  clientId: z.string().nullable().optional(),
});
export const CodexListedTurnSchema = CodexTurnSchema.extend({
  items: z.array(CodexListedTurnItemSchema),
  itemsView: z.literal('full').optional(),
});
export const CodexTurnsPageSchema = z.looseObject({
  data: z.array(CodexListedTurnSchema),
  nextCursor: z.string().nullable().optional(),
});

export const CodexThreadRevertResponseSchema = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
  turnsBackwardsCursor: z.string().nullable().optional(),
  itemsBackwardsCursor: z.string().nullable().optional(),
});

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

/** Server requests the driver answers; every other is refused `-32601`. */
export const CODEX_APPROVAL_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
export const CODEX_PERMISSIONS_APPROVAL_REQUEST = 'item/permissions/requestApproval';
export const CODEX_INPUT_REQUEST = 'item/tool/requestUserInput';
export const CODEX_ELICITATION_REQUEST = 'mcpServer/elicitation/request';
/**
 * The decisions the driver answers an approval with, the same for a command and a file
 * change: `deny` lets the agent continue the turn, `interrupted` interrupts it at once.
 */
export const CODEX_APPROVAL_DECISION = {
  approve: 'accept',
  approveForSession: 'acceptForSession',
  deny: 'decline',
  interrupted: 'cancel',
} as const;
