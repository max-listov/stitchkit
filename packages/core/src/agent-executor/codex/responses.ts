import { z } from 'zod';
import { JsonRpcValueSchema } from '../json-rpc-peer';
import {
  CodexApprovalPolicySchema,
  CodexStartedThreadSchema,
  CodexThreadItemSchema,
  CodexThreadSchema,
  unknownTypedRecordSchema,
} from './protocol';

const KNOWN_ACCOUNT_TYPES = new Set(['apiKey', 'chatgpt', 'amazonBedrock', 'gcp']);

/** Loose Zod schema for empty-object Codex RPC responses (`thread/archive`, `thread/name/set`, `thread/inject_items`). */
export const CodexEmptyResponseSchema = z.looseObject({});

/** Loose Zod schema for Codex `thread/read` response. */
export const CodexReadThreadResponseSchema = z.looseObject({
  thread: CodexThreadSchema,
  readState: JsonRpcValueSchema.nullable().optional(),
});

/** Response returned by Codex `thread/read`, inferred from {@link CodexReadThreadResponseSchema}. */
export type CodexReadThreadResponse = z.infer<typeof CodexReadThreadResponseSchema>;

/** Loose Zod schema for Codex `thread/resume` response. */
export const CodexResumeThreadResponseSchema = CodexStartedThreadSchema;

/** Response returned by Codex `thread/resume`, inferred from {@link CodexResumeThreadResponseSchema}. */
export type CodexResumeThreadResponse = z.infer<typeof CodexResumeThreadResponseSchema>;

/** Loose Zod schema for one item entry returned by Codex `thread/items/list`. */
export const CodexThreadItemEntrySchema = z.looseObject({
  turnId: z.string(),
  item: CodexThreadItemSchema,
  outputDeferred: z.boolean().optional(),
  startedAtMs: z.number().int().nullable().optional(),
  completedAtMs: z.number().int().nullable().optional(),
});

/** Single item entry in {@link CodexItemsPage}, inferred from {@link CodexThreadItemEntrySchema}. */
export type CodexThreadItemEntry = z.infer<typeof CodexThreadItemEntrySchema>;

/** Loose Zod schema for Codex `thread/items/list` response. */
export const CodexItemsPageSchema = z.looseObject({
  data: z.array(CodexThreadItemEntrySchema),
  nextCursor: z.string().nullable().optional(),
  backwardsCursor: z.string().nullable().optional(),
});

/** Paginated items response returned by Codex `thread/items/list`. */
export type CodexItemsPage = z.infer<typeof CodexItemsPageSchema>;

/** Loose Zod schema for Codex `thread/list` response. */
export const CodexThreadsPageSchema = z.looseObject({
  data: z.array(CodexThreadSchema),
  nextCursor: z.string().nullable().optional(),
  backwardsCursor: z.string().nullable().optional(),
  readStates: z.record(z.string(), JsonRpcValueSchema.nullable()).nullable().optional(),
});

/** Paginated thread list response returned by Codex `thread/list`. */
export type CodexThreadsPage = z.infer<typeof CodexThreadsPageSchema>;

/** Loose Zod schema for Codex `thread/loaded/list` response. */
export const CodexLoadedThreadsPageSchema = z.looseObject({
  data: z.array(z.string()),
  nextCursor: z.string().nullable().optional(),
});

/** Paginated loaded thread id list returned by Codex `thread/loaded/list`. */
export type CodexLoadedThreadsPage = z.infer<typeof CodexLoadedThreadsPageSchema>;

/** Loose Zod schema for a reasoning effort option advertised on a Codex model entry. */
export const CodexReasoningEffortOptionSchema = z.looseObject({
  reasoningEffort: z.string(),
  description: z.string().optional(),
});

/** Loose Zod schema for one model entry returned by Codex `model/list`. */
export const CodexModelSchema = z.looseObject({
  id: z.string().min(1),
  model: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(CodexReasoningEffortOptionSchema).optional(),
  inputModalities: z.array(z.string()).optional(),
  upgrade: z.string().nullable().optional(),
  defaultServiceTier: z.string().nullable().optional(),
  modelSpecialty: z.string().nullable().optional(),
});

/** Model catalog entry inferred from {@link CodexModelSchema}. */
export type CodexModel = z.infer<typeof CodexModelSchema>;

/** Loose Zod schema for Codex `model/list` response. */
export const CodexModelsPageSchema = z.looseObject({
  data: z.array(CodexModelSchema),
  nextCursor: z.string().nullable().optional(),
});

/** Paginated model catalog returned by Codex `model/list`. */
export type CodexModelsPage = z.infer<typeof CodexModelsPageSchema>;

/** Loose Zod schema for one discovered skill in Codex `skills/list`. */
export const CodexSkillMetadataSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  path: z.string().optional(),
  scope: z.string().optional(),
  enabled: z.boolean().optional(),
  pluginId: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  interface: JsonRpcValueSchema.nullable().optional(),
  dependencies: JsonRpcValueSchema.nullable().optional(),
});

/** Loose Zod schema for a skill loading error in Codex `skills/list`. */
export const CodexSkillErrorInfoSchema = z.looseObject({
  path: z.string(),
  message: z.string(),
});

/** Loose Zod schema for one workspace entry in Codex `skills/list`. */
export const CodexSkillsListEntrySchema = z.looseObject({
  cwd: z.string(),
  skills: z.array(CodexSkillMetadataSchema),
  errors: z.array(CodexSkillErrorInfoSchema).optional(),
});

/** Loose Zod schema for Codex `skills/list` response. */
export const CodexSkillsListResponseSchema = z.looseObject({
  data: z.array(CodexSkillsListEntrySchema),
});

/** Skills catalog returned by Codex `skills/list`. */
export type CodexSkillsListResponse = z.infer<typeof CodexSkillsListResponseSchema>;

/** Loose Zod schema for one preset returned by Codex `collaborationMode/list`. */
export const CodexCollaborationModePresetSchema = z.looseObject({
  name: z.string(),
  mode: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reasoning_effort: z.string().nullable().optional(),
});

/** Loose Zod schema for Codex `collaborationMode/list` response. */
export const CodexCollaborationModesResponseSchema = z.looseObject({
  data: z.array(CodexCollaborationModePresetSchema),
});

/** Collaboration mode presets returned by Codex `collaborationMode/list`. */
export type CodexCollaborationModesResponse = z.infer<
  typeof CodexCollaborationModesResponseSchema
>;

/** Loose Zod schema for one MCP server status returned by Codex `mcpServerStatus/list`. */
export const CodexMcpServerStatusSchema = z.looseObject({
  name: z.string(),
  authStatus: z.string().optional(),
  runtimeStatus: z
    .union([z.string(), z.looseObject({ type: z.string() })])
    .nullable()
    .optional(),
  tools: z.record(z.string(), JsonRpcValueSchema).optional(),
  resources: z.array(JsonRpcValueSchema).optional(),
  resourceTemplates: z.array(JsonRpcValueSchema).optional(),
  environmentId: z.string().nullable().optional(),
  httpOrigin: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  serverInfo: JsonRpcValueSchema.nullable().optional(),
  serverCapabilities: JsonRpcValueSchema.optional(),
  toolListMeta: JsonRpcValueSchema.optional(),
  toolsError: z.string().nullable().optional(),
});

/** Loose Zod schema for Codex `mcpServerStatus/list` response. */
export const CodexMcpServerStatusPageSchema = z.looseObject({
  data: z.array(CodexMcpServerStatusSchema),
  nextCursor: z.string().nullable().optional(),
});

/** Paginated MCP server status list returned by Codex `mcpServerStatus/list`. */
export type CodexMcpServerStatusPage = z.infer<typeof CodexMcpServerStatusPageSchema>;

/** Loose Zod schema for the effective `config` object returned by Codex `config/read`. */
export const CodexConfigSchema = z.looseObject({
  model: z.string().nullable().optional(),
  model_provider: z.string().nullable().optional(),
  model_reasoning_effort: z.string().nullable().optional(),
  model_reasoning_summary: z.string().nullable().optional(),
  model_verbosity: z.string().nullable().optional(),
  model_context_window: z.number().int().nullable().optional(),
  approval_policy: CodexApprovalPolicySchema.nullable().optional(),
  approvals_reviewer: z.string().nullable().optional(),
  sandbox_mode: z.string().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  review_model: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  developer_instructions: z.string().nullable().optional(),
  compact_prompt: z.string().nullable().optional(),
});

/** Loose Zod schema for one origin metadata entry in Codex `config/read`. */
export const CodexConfigLayerMetadataSchema = z.looseObject({
  name: JsonRpcValueSchema,
  version: z.string(),
});

/** Loose Zod schema for Codex `config/read` response. */
export const CodexConfigReadResponseSchema = z.looseObject({
  config: CodexConfigSchema,
  origins: z.record(z.string(), CodexConfigLayerMetadataSchema).optional(),
  layers: z.array(JsonRpcValueSchema).nullable().optional(),
});

/** Effective configuration returned by Codex `config/read`. */
export type CodexConfigReadResponse = z.infer<typeof CodexConfigReadResponseSchema>;

/** Open-variant Zod schema for a Codex `Account` returned by `account/read`. */
export const CodexAccountSchema = z.union([
  z.looseObject({ type: z.literal('apiKey') }),
  z.looseObject({
    type: z.literal('chatgpt'),
    email: z.string().nullable().optional(),
    planType: z.string().nullable().optional(),
    workspaceName: z.string().nullable().optional(),
  }),
  z.looseObject({
    type: z.literal('amazonBedrock'),
    usesCodexManagedCredentials: z.boolean().optional(),
  }),
  z.looseObject({ type: z.literal('gcp') }),
  unknownTypedRecordSchema<{
    readonly email?: never;
    readonly planType?: never;
    readonly workspaceName?: never;
    readonly usesCodexManagedCredentials?: never;
  }>(KNOWN_ACCOUNT_TYPES),
]);

/** Account identity inferred from {@link CodexAccountSchema}. */
export type CodexAccount = z.infer<typeof CodexAccountSchema>;

/** Loose Zod schema for Codex `account/read` response. */
export const CodexAccountReadResponseSchema = z.looseObject({
  account: CodexAccountSchema.nullable().optional(),
  requiresOpenaiAuth: z.boolean(),
  userId: z.string().nullable().optional(),
  workspaceRouting: JsonRpcValueSchema.nullable().optional(),
});

/** Account metadata returned by Codex `account/read`. */
export type CodexAccountReadResponse = z.infer<typeof CodexAccountReadResponseSchema>;

/** Loose Zod schema for one rate-limit window inside `account/rateLimits/read`. */
export const CodexRateLimitWindowSchema = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().int().nullable().optional(),
  resetsAt: z.number().int().nullable().optional(),
});

/** Loose Zod schema for one `RateLimitSnapshot` inside `account/rateLimits/read`. */
export const CodexRateLimitSnapshotSchema = z.looseObject({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  normalModelSlug: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  primary: CodexRateLimitWindowSchema.nullable().optional(),
  secondary: CodexRateLimitWindowSchema.nullable().optional(),
  credits: JsonRpcValueSchema.nullable().optional(),
  individualLimit: JsonRpcValueSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
  spendControlReached: z.boolean().nullable().optional(),
});

/** Loose Zod schema for Codex `account/rateLimits/read` response. */
export const CodexRateLimitsResponseSchema = z.looseObject({
  rateLimits: CodexRateLimitSnapshotSchema,
  rateLimitsByLimitId: z
    .record(z.string(), CodexRateLimitSnapshotSchema)
    .nullable()
    .optional(),
  accountId: z.string().nullable().optional(),
  ordinaryUsageAllowed: z.boolean().nullable().optional(),
  rateLimitResetCredits: JsonRpcValueSchema.nullable().optional(),
  rateLimitUpsell: JsonRpcValueSchema.optional(),
});

/** Raw rate-limits envelope returned by Codex `account/rateLimits/read`. */
export type CodexRateLimitsResponse = z.infer<typeof CodexRateLimitsResponseSchema>;

/** Open-variant Zod schema for `ThreadUnsubscribeStatus`. */
export const CodexThreadUnsubscribeStatusSchema = z.union([
  z.enum(['notLoaded', 'notSubscribed', 'unsubscribed']),
  z.custom<string & Record<never, never>>(
    (value) => typeof value === 'string' && value.length > 0,
    {
      message: 'Expected a non-empty ThreadUnsubscribeStatus string',
    },
  ),
]);

/** Loose Zod schema for Codex `thread/unsubscribe` response. */
export const CodexThreadUnsubscribeResponseSchema = z.looseObject({
  status: CodexThreadUnsubscribeStatusSchema,
});

/** Response returned by Codex `thread/unsubscribe`. */
export type CodexThreadUnsubscribeResponse = z.infer<
  typeof CodexThreadUnsubscribeResponseSchema
>;

/** Loose Zod schema for Codex `thread/unarchive` response. */
export const CodexThreadUnarchiveResponseSchema = z.looseObject({
  thread: CodexThreadSchema,
});

/** Response returned by Codex `thread/unarchive`. */
export type CodexThreadUnarchiveResponse = z.infer<typeof CodexThreadUnarchiveResponseSchema>;

/** Loose Zod schema for Codex `thread/metadata/update` response. */
export const CodexThreadMetadataUpdateResponseSchema = z.looseObject({
  thread: CodexThreadSchema,
});

/** Response returned by Codex `thread/metadata/update`. */
export type CodexThreadMetadataUpdateResponse = z.infer<
  typeof CodexThreadMetadataUpdateResponseSchema
>;
