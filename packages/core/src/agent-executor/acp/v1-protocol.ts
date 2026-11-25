import { z } from 'zod';

/**
 * The slice of the Agent Client Protocol, version 1 (JSON-RPC 2.0 over
 * stdio), the driver reads. Agents add vendor fields beside the standard
 * ones — `agy` 1.5.14 answers `initialize` with `load_session` and
 * `session_capabilities` too, and a tool call with `name`/`args` beside
 * `title`/`rawInput` — so every schema lets unknown keys through rather than
 * refusing the real agent; the keys the driver reads are typed.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** A capability is declared by its presence: `{}` or `true`; `false` or absence is none. */
const CapabilitySchema = z.union([z.boolean(), z.looseObject({})]).optional();

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
        })
        .optional(),
    })
    .optional(),
  agentInfo: z
    .looseObject({ name: z.string().optional(), version: z.string().optional() })
    .optional(),
  authMethods: z.array(z.looseObject({ id: z.string() })).optional(),
});

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

/** Every value an option accepts, its groups flattened. */
export function acpOptionValues(option: AcpConfigOption): string[] {
  return (option.options ?? []).flatMap((choice) => {
    const group = GroupSchema.safeParse(choice);
    return group.success
      ? group.data.options.map((inner) => inner.value)
      : [ChoiceSchema.parse(choice).value];
  });
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
  used: z.int().nonnegative().optional(),
  size: z.int().nonnegative().optional(),
  configOptions: z.array(AcpConfigOptionSchema).optional(),
  availableCommands: z.array(z.looseObject({ name: z.string() })).optional(),
});
export type AcpSessionUpdate = z.infer<typeof AcpSessionUpdateSchema>;

export const AcpUpdateNotificationSchema = z.looseObject({
  sessionId: z.string(),
  update: AcpSessionUpdateSchema,
});

export const AcpPromptResultSchema = z.looseObject({
  stopReason: z.string(),
  usage: z
    .looseObject({
      inputTokens: z.int().nonnegative().nullish(),
      outputTokens: z.int().nonnegative().nullish(),
      cachedReadTokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
});

export const AcpPermissionRequestSchema = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().nullish(),
    name: z.string().optional(),
    rawInput: z.json().optional(),
    args: z.json().optional(),
  }),
  options: z.array(z.looseObject({ optionId: z.string(), kind: z.string() })),
});
