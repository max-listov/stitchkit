import { z } from 'zod';

export const AgentRecordIdSchema = z.string().min(1);
export const AgentRecordVersionSchema = z.int().nonnegative();
export const AgentTimestampSchema = z.iso.datetime({ offset: true });
export const AgentJsonObjectSchema = z.record(z.string(), z.json());

export const AgentProviderEnvelopeSchema = z.object({
  schemaVersion: z.int().positive(),
  provider: z.string().min(1),
  data: AgentJsonObjectSchema,
});

export type AgentProviderEnvelope = z.infer<typeof AgentProviderEnvelopeSchema>;

export const AgentTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const AgentReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentFilePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().min(1),
  reference: z.string().min(1),
  filename: z.string().min(1).optional(),
});

export const AgentSourcePartSchema = z.object({
  type: z.literal('source'),
  sourceId: z.string().min(1),
  url: z.url().optional(),
  title: z.string().optional(),
});

export const AgentToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.json(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentToolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  outcome: z.enum(['success', 'error', 'interrupted']),
  output: z.json().optional(),
});

export const AgentOpaquePartSchema = z.object({
  type: z.literal('provider'),
  envelope: AgentProviderEnvelopeSchema,
});

export const AgentControlPartSchema = z.object({
  type: z.literal('control'),
  reason: z.enum(['run-interrupted', 'stale-run']),
});

export const AgentMessagePartSchema = z.discriminatedUnion('type', [
  AgentTextPartSchema,
  AgentReasoningPartSchema,
  AgentFilePartSchema,
  AgentSourcePartSchema,
  AgentToolCallPartSchema,
  AgentToolResultPartSchema,
  AgentOpaquePartSchema,
  AgentControlPartSchema,
]);

export type AgentMessagePart = z.infer<typeof AgentMessagePartSchema>;

export const AgentMessageRoleSchema = z.enum(['user', 'assistant', 'system', 'summary']);
export const AgentMessageStatusSchema = z.enum([
  'committed',
  'streaming',
  'completed',
  'interrupted',
  'failed',
]);

export const AgentMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema.optional(),
  role: AgentMessageRoleSchema,
  status: AgentMessageStatusSchema,
  parts: z.array(AgentMessagePartSchema),
  metadata: AgentJsonObjectSchema.optional(),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentAssistantPlaceholderSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  status: z.literal('pending'),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

export type AgentAssistantPlaceholder = z.infer<typeof AgentAssistantPlaceholderSchema>;

export const AgentRunStateSchema = z.enum([
  'queued',
  'running',
  'interrupt_requested',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'abandoned',
]);

export const AgentTerminalReasonSchema = z.enum([
  'success',
  'policy_stop',
  'interrupted',
  'cancelled',
  'timeout',
  'shutdown',
  'provider_failure',
  'tool_failure',
  'abandoned',
]);

export type AgentTerminalReason = z.infer<typeof AgentTerminalReasonSchema>;

export const AgentRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  inputMessageIds: z.array(AgentRecordIdSchema).min(1),
  assistantMessageId: AgentRecordIdSchema,
  state: AgentRunStateSchema,
  revision: AgentRecordVersionSchema,
  /**
   * Which runtime instance holds this run.
   *
   * The same value a runtime publishes as `runtimeEpoch` on its events — one
   * identity generated per `createAgentRuntime()`, named for its role in each
   * place: on a run it answers "who owns this", on an event "which runtime
   * produced this". Fencing compares the two: `run.ownerId !== runtimeEpoch`
   * means another instance took the run over.
   */
  ownerId: z.string().min(1).optional(),
  fencingToken: AgentRecordVersionSchema.optional(),
  terminalReason: AgentTerminalReasonSchema.optional(),
  terminalPolicyName: z.string().min(1).optional(),
  createdAt: AgentTimestampSchema,
  updatedAt: AgentTimestampSchema,
});

export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AgentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  version: AgentRecordVersionSchema,
  /** In history order, oldest first. */
  messages: z.array(AgentMessageSchema),
  /**
   * Oldest first — by creation time, and within one millisecond by the
   * position of the earliest message the run owns.
   *
   * The second key exists because the first cannot separate a successor from
   * the run it queues behind: coalescing creates both inside one millisecond,
   * and an ISO timestamp has nothing finer. Position therefore carries
   * meaning, and a reader may rely on it.
   */
  runs: z.array(AgentRunSchema),
});

export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;

export const AgentUsageValueSchema = z.object({
  value: z.number().nonnegative().optional(),
  provenance: z.enum(['provider-reported', 'computed', 'estimated', 'unavailable']),
});

export const AgentCostValueSchema = z.object({
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  provenance: z.enum(['provider-reported', 'computed', 'estimated', 'unavailable']),
});

export const AgentUsageSchema = z.object({
  inputTokens: AgentUsageValueSchema,
  outputTokens: AgentUsageValueSchema,
  reasoningTokens: AgentUsageValueSchema.optional(),
  cacheReadTokens: AgentUsageValueSchema.optional(),
  cacheWriteTokens: AgentUsageValueSchema.optional(),
  cost: AgentCostValueSchema.optional(),
});

export type AgentUsage = z.infer<typeof AgentUsageSchema>;

export const AgentRunMetricsSchema = z.object({
  partial: z.boolean(),
  usage: AgentUsageSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  ttftMs: z.number().nonnegative().optional(),
});

export type AgentRunMetrics = z.infer<typeof AgentRunMetricsSchema>;
