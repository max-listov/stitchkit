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
    /**
     * Which of `items` compaction took out of the model's history.
     *
     * Always present and empty unless the page was asked for compacted
     * messages, so a caller reads one field rather than branching on whether
     * it asked. The messages themselves stay in `items`, in the order the
     * person saw them: a conversation is one sequence, and the boundary
     * compaction drew through it is a mark on that sequence, not a second one.
     */
    compacted: z.array(z.string().min(1)),
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
    /**
     * Include the messages compaction removed from the model's history.
     *
     * Off by default: the model's view is what most callers page. A person
     * reading back their own conversation needs the other one — the store
     * keeps those rows, and without this they were reachable by no public
     * read, which left an application keeping a second copy of its own
     * history beside the store.
     */
    includeCompacted?: boolean;
  }): Promise<AgentConversationMessagePage>;
}
