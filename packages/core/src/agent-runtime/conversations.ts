import { z } from 'zod';
import { AgentMessageSchema, AgentRecordIdSchema, AgentRecordVersionSchema } from './schemas';

export const AgentConversationSummarySchema = z
  .object({
    conversationId: AgentRecordIdSchema,
    version: AgentRecordVersionSchema,
    updatedAt: z.iso.datetime({ offset: true }),
    preview: z.string(),
    activeRuns: z.int().nonnegative(),
  })
  .strict();

export const AgentConversationPageSchema = z
  .object({
    items: z.array(AgentConversationSummarySchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export const AgentConversationMessagePageSchema = z
  .object({
    items: z.array(AgentMessageSchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export type AgentConversationSummary = z.infer<typeof AgentConversationSummarySchema>;
export type AgentConversationPage = z.infer<typeof AgentConversationPageSchema>;
export type AgentConversationMessagePage = z.infer<typeof AgentConversationMessagePageSchema>;

export interface AgentConversationReader {
  list(input: {
    cursor?: string;
    limit: number;
    search?: string;
  }): Promise<AgentConversationPage>;
  messages(input: {
    conversationId: string;
    cursor?: string;
    limit: number;
    direction: 'before' | 'after';
  }): Promise<AgentConversationMessagePage>;
}
