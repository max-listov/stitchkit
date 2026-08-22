import { z } from 'zod';
import {
  AgentAssistantPlaceholderSchema,
  AgentMessageSchema,
  AgentProviderEnvelopeSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  AgentRunMetricsSchema,
  AgentRunSchema,
  AgentRunStateSchema,
  AgentTerminalReasonSchema,
  AgentTimestampSchema,
} from './schemas';

export const AgentAdmissionEventSchema = z.object({
  type: z.literal('admission'),
  eventId: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  input: AgentMessageSchema,
  run: AgentRunSchema,
  assistant: z.union([AgentAssistantPlaceholderSchema, AgentMessageSchema]),
  emittedAt: AgentTimestampSchema,
});

const EventIdentitySchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  emittedAt: AgentTimestampSchema,
});

export const AgentTransientDeltaEventSchema = EventIdentitySchema.extend({
  type: z.literal('assistant-delta'),
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  textDelta: z.string(),
});

const AgentTransientReasoningIdentitySchema = EventIdentitySchema.extend({
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentReasoningStartEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-start'),
});

export const AgentReasoningDeltaEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-delta'),
  textDelta: z.string(),
});

export const AgentReasoningEndEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-end'),
});

export const AgentCheckpointEventSchema = EventIdentitySchema.extend({
  type: z.literal('assistant-checkpoint'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  message: AgentMessageSchema,
  metrics: AgentRunMetricsSchema.optional(),
});

export const AgentRunStateEventSchema = EventIdentitySchema.extend({
  type: z.literal('run-state'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  state: AgentRunStateSchema,
});

export const AgentToolStatusEventSchema = EventIdentitySchema.extend({
  type: z.literal('tool-status'),
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  callId: AgentRecordIdSchema,
  toolName: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed', 'interrupted']),
  input: z.json().optional(),
  output: z.json().optional(),
});

export const AgentTerminalEventSchema = EventIdentitySchema.extend({
  type: z.literal('terminal'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  reason: AgentTerminalReasonSchema,
  policyName: z.string().min(1).optional(),
  message: AgentMessageSchema,
  metrics: AgentRunMetricsSchema.optional(),
});

export const AgentRuntimeEventSchema = z.discriminatedUnion('type', [
  AgentAdmissionEventSchema,
  AgentTransientDeltaEventSchema,
  AgentReasoningStartEventSchema,
  AgentReasoningDeltaEventSchema,
  AgentReasoningEndEventSchema,
  AgentCheckpointEventSchema,
  AgentRunStateEventSchema,
  AgentToolStatusEventSchema,
  AgentTerminalEventSchema,
]);

export type AgentRuntimeEvent = z.infer<typeof AgentRuntimeEventSchema>;
export type AgentRuntimePublisher = (event: AgentRuntimeEvent) => void | Promise<void>;
