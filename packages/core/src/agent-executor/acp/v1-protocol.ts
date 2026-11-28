import { z } from 'zod';

/**
 * The slice of the Agent Client Protocol, version 1 (JSON-RPC 2.0 over
 * stdio), the driver reads. Agents add vendor fields beside the standard
 * ones — e.g. `load_session` / `session_capabilities` beside `loadSession` /
 * `sessionCapabilities`, and `name`/`args` beside `title`/`rawInput` — so
 * every inbound schema lets unknown keys through while keeping the keys the
 * driver reads strictly typed.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP v1 agent-side JSON-RPC methods this driver calls or recognizes. */
export const ACP_V1_AGENT_METHODS = z.enum([
  'initialize',
  'session/new',
  'session/load',
  'session/resume',
  'session/list',
  'session/close',
  'session/delete',
  'session/prompt',
  'session/cancel',
  'session/set_config_option',
  'session/set_model',
]).options;

/** ACP v1 client-side JSON-RPC methods this driver handles. */
export const ACP_V1_CLIENT_METHODS = z.enum([
  'session/update',
  'session/request_permission',
]).options;

/** ACP v1 `session/update` discriminators recognized by this driver. */
export const ACP_V1_UPDATE_KINDS = z.enum([
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
  'compaction_update',
  'compaction_summary_chunk',
]).options;

/** ACP v1 permission option kinds defined by the protocol. */
export const ACP_V1_PERMISSION_OPTION_KINDS = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]).options;

/** ACP v1 prompt stop reasons defined by the protocol. */
export const ACP_V1_STOP_REASONS = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]).options;

/** ACP v1 prompt `usage` token counter field names preserved by this driver. */
export const ACP_V1_USAGE_FIELDS = z.enum([
  'inputTokens',
  'outputTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
  'thoughtTokens',
  'totalTokens',
]).options;

/** Client identity optionally sent on ACP `initialize`. */
export const AcpClientInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  title: z.string().min(1).optional(),
});
/** ACP client implementation metadata inferred from `AcpClientInfoSchema`. */
export type AcpClientInfo = z.infer<typeof AcpClientInfoSchema>;

/** A capability is declared by its presence: `{}` or `true`; `false`, `null`, or absence is none. */
const CapabilitySchema = z.union([z.boolean(), z.looseObject({})]).nullish();

/** Loose Zod schema for ACP v1 `initialize` response. */
export const AcpInitializeResultSchema = z.looseObject({
  protocolVersion: z.int(),
  agentCapabilities: z
    .looseObject({
      loadSession: z.boolean().optional(),
      promptCapabilities: z.looseObject({ image: z.boolean().optional() }).optional(),
      sessionCapabilities: z
        .looseObject({
          resume: CapabilitySchema,
          load: CapabilitySchema,
          list: CapabilitySchema,
          close: CapabilitySchema,
          delete: CapabilitySchema,
        })
        .optional(),
    })
    .optional(),
  agentInfo: z
    .looseObject({
      name: z.string().optional(),
      title: z.string().nullish(),
      version: z.string().optional(),
    })
    .nullish(),
  authMethods: z.array(z.looseObject({ id: z.string() })).optional(),
});
/** ACP v1 `initialize` response inferred from `AcpInitializeResultSchema`. */
export type AcpInitializeResult = z.infer<typeof AcpInitializeResultSchema>;

const ChoiceSchema = z.looseObject({ value: z.string(), name: z.string().optional() });
const GroupSchema = z.looseObject({
  group: z.string().optional(),
  options: z.array(ChoiceSchema),
});

/** A setting the agent offers on a session: a select of values, flat or grouped. */
export const AcpConfigOptionSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  /** `model`, `thought_level`, `mode` — or a category of the agent's own. */
  category: z.string().optional(),
  type: z.string().optional(),
  currentValue: z.string().optional(),
  options: z.array(z.union([ChoiceSchema, GroupSchema])).optional(),
});
/** ACP session configuration option inferred from `AcpConfigOptionSchema`. */
export type AcpConfigOption = z.infer<typeof AcpConfigOptionSchema>;

/** Flattened choice extracted from a flat or grouped {@link AcpConfigOption}. */
export interface AcpConfigOptionChoice {
  /** Selectable option value passed to `session/set_config_option`. */
  readonly value: string;
  /** Human-readable display label when advertised by the agent. */
  readonly name?: string | undefined;
  /** Parent group label when the choice came from a grouped option list. */
  readonly group?: string | undefined;
}

/** Flatten a flat or grouped {@link AcpConfigOption} into selectable choices preserving `name` and `group`. */
export function acpOptionChoices(option: AcpConfigOption): AcpConfigOptionChoice[] {
  return (option.options ?? []).flatMap((choice) => {
    const group = GroupSchema.safeParse(choice);
    if (group.success) {
      return group.data.options.map((inner) => ({
        value: inner.value,
        ...(inner.name !== undefined && { name: inner.name }),
        ...(group.data.group !== undefined && { group: group.data.group }),
      }));
    }
    const parsed = ChoiceSchema.parse(choice);
    return [
      {
        value: parsed.value,
        ...(parsed.name !== undefined && { name: parsed.name }),
      },
    ];
  });
}

/** Every value an option accepts, its groups flattened. */
export function acpOptionValues(option: AcpConfigOption): string[] {
  return acpOptionChoices(option).map((choice) => choice.value);
}

/** What `session/new`, `session/load` and `session/resume` answer about the session. */
export const AcpSessionStateSchema = z.looseObject({
  models: z
    .looseObject({
      currentModelId: z.string().optional(),
      availableModels: z.array(z.looseObject({ modelId: z.string() })).optional(),
    })
    .nullish(),
  modes: z
    .looseObject({
      currentModeId: z.string().optional(),
      availableModes: z.array(z.looseObject({ id: z.string() })).optional(),
    })
    .nullish(),
  configOptions: z.array(AcpConfigOptionSchema).nullish(),
  _meta: z.unknown().optional(),
});

export const AcpNewSessionResultSchema = AcpSessionStateSchema.extend({
  sessionId: z.string().min(1),
});

export const AcpSetConfigOptionResultSchema = z.looseObject({
  configOptions: z.array(AcpConfigOptionSchema).optional(),
});

export const AcpSessionListResultSchema = z.looseObject({
  sessions: z.array(
    z.looseObject({
      sessionId: z.string().min(1),
      cwd: z.string().optional(),
      title: z.string().nullish(),
      updatedAt: z.string().nullish(),
    }),
  ),
  nextCursor: z.string().nullish(),
});

const NameValueSchema = z.strictObject({ name: z.string(), value: z.string() });

/** An MCP server the agent connects to for the session, as ACP v1 names it. */
export const AcpMcpServerSchema = z.union([
  z.strictObject({
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.array(NameValueSchema),
  }),
  z.strictObject({
    type: z.enum(['http', 'sse']),
    name: z.string().min(1),
    url: z.url(),
    headers: z.array(NameValueSchema),
  }),
]);
/** ACP v1 MCP server connection descriptor inferred from `AcpMcpServerSchema`. */
export type AcpMcpServer = z.infer<typeof AcpMcpServerSchema>;

const ContentSchema = z.looseObject({ type: z.string(), text: z.string().optional() });

/** Loose Zod schema for one ACP v1 tool call file location (`path`, optional `line`/`column`). */
export const AcpToolLocationSchema = z.looseObject({
  path: z.string().min(1),
  line: z.int().nonnegative().nullish(),
  column: z.int().nonnegative().nullish(),
});
/** One ACP v1 tool call location inferred from `AcpToolLocationSchema`. */
export type AcpToolLocation = z.infer<typeof AcpToolLocationSchema>;

/** Loose Zod schema for one ACP v1 plan entry (`content`, optional `status` and `priority`). */
export const AcpPlanEntrySchema = z.looseObject({
  content: z.string(),
  status: z.string().optional(),
  priority: z.string().optional(),
});
/** One ACP v1 plan entry inferred from `AcpPlanEntrySchema`. */
export type AcpPlanEntry = z.infer<typeof AcpPlanEntrySchema>;

const AcpPlanContainerSchema = z.looseObject({
  id: z.string().optional(),
  entries: z.array(AcpPlanEntrySchema).optional(),
});

/** Loose Zod schema for one ACP v1 `session/update` payload. */
export const AcpSessionUpdateSchema = z.looseObject({
  sessionUpdate: z.string(),
  content: z.union([ContentSchema, z.array(z.json())]).optional(),
  toolCallId: z.string().optional(),
  title: z.string().nullish(),
  kind: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.json().optional(),
  args: z.json().optional(),
  rawOutput: z.json().optional(),
  locations: z.array(AcpToolLocationSchema).optional(),
  entries: z.array(AcpPlanEntrySchema).optional(),
  plan: AcpPlanContainerSchema.nullish(),
  planId: z.string().optional(),
  used: z.int().nonnegative().optional(),
  size: z.int().nonnegative().optional(),
  configOptions: z.array(AcpConfigOptionSchema).optional(),
  availableCommands: z.array(z.looseObject({ name: z.string() })).optional(),
});
/** One `session/update` payload emitted by an ACP v1 agent. */
export type AcpSessionUpdate = z.infer<typeof AcpSessionUpdateSchema>;

export const AcpUpdateNotificationSchema = z.looseObject({
  sessionId: z.string(),
  update: AcpSessionUpdateSchema,
});

export const AcpPromptUsageSchema = z.looseObject({
  inputTokens: z.int().nonnegative().nullish(),
  outputTokens: z.int().nonnegative().nullish(),
  cachedReadTokens: z.int().nonnegative().nullish(),
  cachedWriteTokens: z.int().nonnegative().nullish(),
  thoughtTokens: z.int().nonnegative().nullish(),
  totalTokens: z.int().nonnegative().nullish(),
});
/** ACP v1 prompt token counters inferred from `AcpPromptUsageSchema`. */
export type AcpPromptUsage = z.infer<typeof AcpPromptUsageSchema>;

export const AcpPromptResultSchema = z.looseObject({
  stopReason: z.string(),
  usage: AcpPromptUsageSchema.nullish(),
});
/** ACP v1 `session/prompt` response inferred from `AcpPromptResultSchema`. */
export type AcpPromptResult = z.infer<typeof AcpPromptResultSchema>;

/** Loose Zod schema for one selectable permission option on ACP `session/request_permission`. */
export const AcpPermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  kind: z.string(),
  name: z.string().optional(),
  _meta: z.record(z.string(), z.json()).nullish(),
});
/** One selectable option on `session/request_permission`, inferred from `AcpPermissionOptionSchema`. */
export type AcpPermissionOption = z.infer<typeof AcpPermissionOptionSchema>;

/** Loose Zod schema for ACP v1 `session/request_permission` request params. */
export const AcpPermissionRequestSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().nullish(),
    name: z.string().optional(),
    kind: z.string().optional(),
    rawInput: z.json().optional(),
    args: z.json().optional(),
    locations: z.array(AcpToolLocationSchema).optional(),
  }),
  options: z.array(AcpPermissionOptionSchema),
});
/** ACP v1 `session/request_permission` payload inferred from `AcpPermissionRequestSchema`. */
export type AcpPermissionRequest = z.infer<typeof AcpPermissionRequestSchema>;
