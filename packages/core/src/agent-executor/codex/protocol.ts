import { z } from 'zod';

/**
 * The slice of Codex's app-server protocol (0.162.1, JSON-RPC over stdio
 * without the `jsonrpc` header) the driver reads. Every schema lets fields
 * it does not use through; a test checks each against the JSON Schema the
 * pinned CLI generates, so a renamed field fails there and not in a turn.
 */
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
      }),
    }),
  }),
  'serverRequest/resolved': z.looseObject({ requestId: z.union([z.string(), z.int()]) }),
  'account/rateLimits/updated': z.looseObject({ rateLimits: z.json() }),
} as const;

export const CodexApprovalParamsSchema = z.looseObject({
  itemId: z.string(),
  command: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

export const CodexUserInputParamsSchema = z.looseObject({
  itemId: z.string(),
  questions: z.array(
    z.looseObject({ id: z.string(), question: z.string(), header: z.string() }),
  ),
});

/** Answers to `item/tool/requestUserInput`: question id → the chosen answers. */
export const CodexUserInputAnswersSchema = z.record(
  z.string(),
  z.strictObject({ answers: z.array(z.string()) }),
);

export const CodexStartedThreadSchema = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
});
export const CodexStartedTurnSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
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

/** Notifications the driver asks the server not to send: noise for a turn. */
export const CODEX_OPTED_OUT_NOTIFICATIONS = [
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
  'turn/started',
  'turn/plan/updated',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'hook/started',
  'hook/completed',
  'warning',
  'account/updated',
  'thread/name/updated',
  'thread/settings/updated',
  'thread/compacted',
  'model/rerouted',
  // The failure arrives again, final, with the turn: `turn/completed` carries it.
  'error',
]);

/** Server requests the driver answers; every other is refused `-32601`. */
export const CODEX_APPROVAL_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
export const CODEX_INPUT_REQUEST = 'item/tool/requestUserInput';
/**
 * The decisions the driver answers an approval with, the same for a command and a file
 * change: `deny` lets the agent continue the turn, `interrupted` interrupts it at once.
 */
export const CODEX_APPROVAL_DECISION = {
  approve: 'accept',
  deny: 'decline',
  interrupted: 'cancel',
} as const;
