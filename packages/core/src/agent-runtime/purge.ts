import { z } from 'zod';
import { AgentRecordIdSchema, AgentRecordVersionSchema } from './schemas';
import type { AgentRuntimeStore } from './store';

export const AgentConversationPurgeInputSchema = z.strictObject({
  conversationId: AgentRecordIdSchema,
  expectedVersion: AgentRecordVersionSchema.optional(),
});

export const AgentConversationPurgeResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('purged') }),
  z.strictObject({ outcome: z.literal('already_purged') }),
  z.strictObject({ outcome: z.literal('unsupported') }),
  z.strictObject({
    outcome: z.literal('active'),
    runIds: z.array(AgentRecordIdSchema).min(1),
  }),
  z.strictObject({ outcome: z.literal('conflict'), actualVersion: AgentRecordVersionSchema }),
]);

export type AgentConversationPurgeInput = z.infer<typeof AgentConversationPurgeInputSchema>;
export type AgentConversationPurgeResult = z.infer<typeof AgentConversationPurgeResultSchema>;

/** A purged ID is permanently reserved; no runtime mutation may recreate its records. */
export class AgentConversationPurgedError extends Error {
  constructor() {
    super('Agent conversation has been purged; use a new conversation ID');
    this.name = 'AgentConversationPurgedError';
  }
}

/** Dispatch optional deletion without silently treating an unsupported store as empty. */
export async function purgeAgentConversation(
  store: AgentRuntimeStore,
  input: AgentConversationPurgeInput,
): Promise<AgentConversationPurgeResult> {
  const parsed = AgentConversationPurgeInputSchema.parse(input);
  if (!store.purgeConversation) return { outcome: 'unsupported' };
  return AgentConversationPurgeResultSchema.parse(await store.purgeConversation(parsed));
}
