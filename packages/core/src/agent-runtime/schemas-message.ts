import { z } from 'zod';
import { AgentMessagePartSchema } from '../agent-parts/parts';
import { AgentRecordIdSchema } from '../durability/events';
import { AgentJsonObjectSchema, AgentTimestampSchema } from './schemas-records';

export const AgentMessageRoleSchema = z.enum([
  'user',
  'assistant',
  'tool',
  'system',
  'summary',
]);
export const AgentMessageStatusSchema = z.enum([
  'committed',
  'streaming',
  'completed',
  'interrupted',
  'superseded',
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
