import { z } from 'zod';
import { isRecord } from '../../internal/typed';
import { JsonRpcRecordSchema, JsonRpcValueSchema } from '../json-rpc-peer';

/**
 * The slice of Codex's app-server protocol (0.171.0, JSON-RPC over stdio or
 * WebSocket-over-Unix-socket without the `jsonrpc` header) the driver reads.
 * Every schema lets fields it does not use through; a test checks each against
 * the JSON Schema the pinned CLI generates, so a renamed field fails there and
 * not in a turn.
 */

/** Typed protocol error raised when a Codex app-server response or notification violates its schema. */
export class CodexProtocolError extends Error {
  override readonly cause: z.ZodError;

  constructor(
    readonly method: string,
    cause: z.ZodError,
    message?: string,
  ) {
    super(
      message ??
        `[stitchkit] Codex ${method} response did not match schema: ${cause.issues[0]?.message ?? cause.message}`,
      { cause },
    );
    this.name = 'CodexProtocolError';
    this.cause = cause;
  }
}

/** Parse a Codex JSON-RPC payload with `schema`, wrapping any `ZodError` in {@link CodexProtocolError}. */
export function parseCodexResponse<T>(
  method: string,
  schema: z.ZodType<T>,
  raw: unknown,
  kind: 'response' | 'notification' = 'response',
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CodexProtocolError(
      method,
      parsed.error,
      `[stitchkit] Codex ${method} ${kind} did not match schema: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data;
}

const KNOWN_SANDBOX_POLICY_TYPES = new Set([
  'dangerFullAccess',
  'readOnly',
  'externalSandbox',
  'workspaceWrite',
]);

const KNOWN_THREAD_STATUS_TYPES = new Set(['notLoaded', 'idle', 'systemError', 'active']);

/** Fallback schema for open-variant unions (`{ type: string }`) preserving TS narrowing. */
export function unknownTypedRecordSchema<
  TDisallowed extends Record<string, never | undefined>,
>(knownTypes: ReadonlySet<string>) {
  return z.custom<{ readonly type: string } & TDisallowed>(
    (value) =>
      isRecord(value) &&
      typeof value.type === 'string' &&
      value.type.length > 0 &&
      !knownTypes.has(value.type),
    { message: 'Expected an object with an unknown non-empty type discriminator' },
  );
}

/** Zod schema for approval policies accepted by Codex `thread/start`, `thread/resume`, `thread/fork`, and `turn/start`. */
export const CodexApprovalPolicySchema = z.union([
  z.enum(['untrusted', 'on-failure', 'on-request', 'never']),
  JsonRpcRecordSchema,
]);

/** Approval policy values accepted by Codex `thread/start`, `thread/resume`, `thread/fork`, and `turn/start`. */
export type CodexApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | Readonly<z.infer<typeof JsonRpcRecordSchema>>;

/** Zod schema for sandbox modes accepted by Codex `thread/start`, `thread/resume`, and `thread/fork`. */
export const CodexSandboxModeSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/** Sandbox mode values accepted by Codex `thread/start`, `thread/resume`, and `thread/fork`. */
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

/** Open-variant Zod schema for Codex `SandboxPolicy` (known 0.171.0 variants strictly validated; unknown future `type` passes through). */
export const CodexSandboxPolicySchema = z.union([
  z.looseObject({ type: z.literal('dangerFullAccess') }),
  z.looseObject({
    type: z.literal('readOnly'),
    networkAccess: z.boolean().optional(),
  }),
  z.looseObject({
    type: z.literal('externalSandbox'),
    networkAccess: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(z.string()).optional(),
    networkAccess: z.boolean().optional(),
    excludeTmpdirEnvVar: z.boolean().optional(),
    excludeSlashTmp: z.boolean().optional(),
  }),
  unknownTypedRecordSchema<{
    readonly writableRoots?: never;
    readonly networkAccess?: never;
    readonly excludeTmpdirEnvVar?: never;
    readonly excludeSlashTmp?: never;
  }>(KNOWN_SANDBOX_POLICY_TYPES),
]);

/** Applied or per-turn Codex sandbox policy inferred from {@link CodexSandboxPolicySchema}. */
export type CodexSandboxPolicy = z.infer<typeof CodexSandboxPolicySchema>;

/** Open-variant Zod schema for Codex `ThreadStatus` (`notLoaded`, `idle`, `systemError`, `active`, or future variants). */
export const CodexThreadStatusSchema = z.union([
  z.looseObject({ type: z.literal('notLoaded') }),
  z.looseObject({ type: z.literal('idle') }),
  z.looseObject({ type: z.literal('systemError') }),
  z.looseObject({
    type: z.literal('active'),
    activeFlags: z.array(z.string()),
  }),
  unknownTypedRecordSchema<{ readonly activeFlags?: never }>(KNOWN_THREAD_STATUS_TYPES),
]);

/** Runtime thread status inferred from {@link CodexThreadStatusSchema}. */
export type CodexThreadStatus = z.infer<typeof CodexThreadStatusSchema>;

/** Zod schema for Codex turn lifecycle status (`completed`, `interrupted`, `failed`, `inProgress`). */
export const CodexTurnStatusSchema = z.enum([
  'completed',
  'interrupted',
  'failed',
  'inProgress',
]);

/** Turn lifecycle status inferred from {@link CodexTurnStatusSchema}. */
export type CodexTurnStatus = z.infer<typeof CodexTurnStatusSchema>;

/** Open-variant Zod schema for Codex `TurnItemsView` (`notLoaded`, `summary`, `full`, or future views). */
export const CodexTurnItemsViewSchema = z.union([
  z.enum(['notLoaded', 'summary', 'full']),
  z.custom<string & Record<never, never>>(
    (value) => typeof value === 'string' && value.length > 0,
    {
      message: 'Expected a non-empty TurnItemsView string',
    },
  ),
]);

/** Turn items hydration level inferred from {@link CodexTurnItemsViewSchema}. */
export type CodexTurnItemsView = z.infer<typeof CodexTurnItemsViewSchema>;

/** Known `ThreadSourceKind` filter values accepted by Codex `thread/list` (`0.171.0`). */
export const CODEX_THREAD_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
] as const;

/** Zod schema for Codex `ThreadSourceKind` filter values accepted by `thread/list`. */
export const CodexThreadSourceKindSchema = z.enum(CODEX_THREAD_SOURCE_KINDS);

/** Thread source kind filter accepted by Codex `thread/list`. */
export type CodexThreadSourceKind = z.infer<typeof CodexThreadSourceKindSchema>;

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

/** Loose Zod schema for a Codex `ThreadItem` emitted in notifications and `thread/items/list`. */
export const CodexThreadItemSchema = z.looseObject({
  type: z.string(),
  id: z.string().min(1),
});

/** Thread item inferred from {@link CodexThreadItemSchema}. */
export type CodexThreadItem = z.infer<typeof CodexThreadItemSchema>;

/** Loose Zod schema for a Codex `Turn` returned by turn lifecycle notifications. */
export const CodexTurnSchema = z.looseObject({
  id: z.string().min(1),
  status: CodexTurnStatusSchema,
  error: z
    .looseObject({
      message: z.string(),
      codexErrorInfo: JsonRpcValueSchema.nullable().optional(),
    })
    .nullable()
    .optional(),
  items: z
    .array(z.looseObject({ type: z.string(), clientId: z.string().nullable().optional() }))
    .optional(),
  startedAt: z.number().int().nullable().optional(),
  completedAt: z.number().int().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  rootTurnId: z.string().nullable().optional(),
});

/** Loose Zod schema for one item entry embedded inside a {@link CodexListedTurn}. */
export const CodexListedTurnItemSchema = z.looseObject({
  type: z.string(),
  clientId: z.string().nullable().optional(),
});

/** Loose Zod schema for a turn returned by `thread/turns/list` or embedded in `Thread.turns`. */
export const CodexListedTurnSchema = CodexTurnSchema.extend({
  items: z.array(CodexListedTurnItemSchema),
  itemsView: CodexTurnItemsViewSchema.optional(),
});

/** Listed turn inferred from {@link CodexListedTurnSchema}. */
export type CodexListedTurn = z.infer<typeof CodexListedTurnSchema>;

/** Loose Zod schema for a page returned by Codex `thread/turns/list`. */
export const CodexTurnsPageSchema = z.looseObject({
  data: z.array(CodexListedTurnSchema),
  nextCursor: z.string().nullable().optional(),
  backwardsCursor: z.string().nullable().optional(),
});

/** Paginated turns response inferred from {@link CodexTurnsPageSchema}. */
export type CodexTurnsPage = z.infer<typeof CodexTurnsPageSchema>;

/** Loose Zod schema for a Codex `Thread` returned across `thread/*` RPCs. */
export const CodexThreadSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  preview: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().nullable().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  status: CodexThreadStatusSchema.optional(),
  canAcceptDirectInput: z.boolean().nullable().optional(),
  cliVersion: z.string().optional(),
  createdAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
  recencyAt: z.number().int().nullable().optional(),
  ephemeral: z.boolean().optional(),
  path: z.string().nullable().optional(),
  source: JsonRpcValueSchema.optional(),
  sessionId: z.string().optional(),
  projectId: z.string().nullable().optional(),
  forkedFromId: z.string().nullable().optional(),
  parentThreadId: z.string().nullable().optional(),
  attachedToThreadId: z.string().nullable().optional(),
  originator: z.string().nullable().optional(),
  agentNickname: z.string().nullable().optional(),
  agentRole: z.string().nullable().optional(),
  gitInfo: JsonRpcValueSchema.nullable().optional(),
  turns: z.array(CodexListedTurnSchema).optional(),
});

/** Codex thread metadata inferred from {@link CodexThreadSchema}. */
export type CodexThread = z.infer<typeof CodexThreadSchema>;

/** Applied thread policy and runtime context returned by `thread/start`, `thread/resume`, or `thread/fork`. */
export const CodexThreadContextSchema = z.object({
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  approvalPolicy: CodexApprovalPolicySchema.optional(),
  sandbox: CodexSandboxPolicySchema.optional(),
  cwd: z.string().optional(),
  runtimeWorkspaceRoots: z.array(z.string()).readonly().optional(),
  thread: CodexThreadSchema.optional(),
});

/** Applied policy and model context reported by Codex when opening, resuming, or forking a thread. */
export type CodexThreadContext = Readonly<z.infer<typeof CodexThreadContextSchema>>;

/** Loose Zod schema for Codex `initialize` response. */
export const CodexInitializeResponseSchema = z.looseObject({
  userAgent: z.string().nullable().optional(),
});

const CodexInboundCollaborationModeSchema = z.looseObject({
  mode: z.string(),
  settings: z
    .looseObject({
      model: z.string().optional(),
      reasoning_effort: z.string().nullable().optional(),
      developer_instructions: z.string().nullable().optional(),
    })
    .optional(),
});

/** Loose Zod schema for responses returned by `thread/start`, `thread/resume`, and `thread/fork`. */
export const CodexStartedThreadSchema = CodexThreadContextSchema.extend({
  thread: CodexThreadSchema,
  approvalsReviewer: z.string().optional(),
  collaborationMode: CodexInboundCollaborationModeSchema.nullable().optional(),
  turnsBackwardsCursor: z.string().nullable().optional(),
  itemsBackwardsCursor: z.string().nullable().optional(),
  serviceTier: z.string().nullable().optional(),
  disabledPluginIds: z.array(z.string()).optional(),
  instructionSources: z.array(z.string()).optional(),
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
    thread: parsed.thread,
  };
}

/** Loose Zod schema for Codex `turn/start` response. */
export const CodexStartedTurnSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});

/** Loose Zod schema for Codex `turn/steer` response. */
export const CodexTurnSteerResponseSchema = z.looseObject({
  turnId: z.string().min(1),
});

/** Loose Zod schema for Codex `thread/revert` response. */
export const CodexThreadRevertResponseSchema = z.looseObject({
  thread: CodexThreadSchema,
  turnsBackwardsCursor: z.string().nullable().optional(),
  itemsBackwardsCursor: z.string().nullable().optional(),
});

/** Loose Zod schema for `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` params. */
export const CodexApprovalParamsSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  grantRoot: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  approvalId: z.string().nullable().optional(),
  startedAtMs: z.number().int().nullable().optional(),
  commandActions: z.array(JsonRpcValueSchema).nullable().optional(),
  availableDecisions: z.array(JsonRpcValueSchema).nullable().optional(),
});

/** Loose Zod schema for one option inside a `item/tool/requestUserInput` question. */
export const CodexUserInputOptionSchema = z.looseObject({
  label: z.string(),
  description: z.string(),
});

/** Loose Zod schema for one question inside `item/tool/requestUserInput`. */
export const CodexUserInputQuestionSchema = z.looseObject({
  id: z.string(),
  question: z.string(),
  header: z.string(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(CodexUserInputOptionSchema).nullable().optional(),
});

/** Loose Zod schema for `item/tool/requestUserInput` server request params. */
export const CodexUserInputParamsSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
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
  fileSystem: JsonRpcValueSchema.nullable().optional(),
  network: JsonRpcValueSchema.nullable().optional(),
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
  _meta: JsonRpcValueSchema.optional(),
};

const CodexMcpElicitationFormSchemaSchema = z.looseObject({
  type: z.literal('object'),
  properties: z.record(z.string(), JsonRpcValueSchema),
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
    requestedSchema: JsonRpcValueSchema,
  }),
  z.looseObject({
    ...CodexMcpElicitationBaseFields,
    mode: z.literal('openaiForm'),
    requestedSchema: JsonRpcValueSchema,
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
  content: JsonRpcValueSchema.optional(),
  _meta: JsonRpcValueSchema.optional(),
});

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
