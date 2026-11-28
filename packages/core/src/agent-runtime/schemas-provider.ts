import { z } from 'zod';
import { AgentTimestampSchema } from './schemas-records';

/** Provider-assigned identity for one completed model step. */
export const AgentProviderResponseSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    timestamp: AgentTimestampSchema.optional(),
  })
  .strict();

export type AgentProviderResponse = z.infer<typeof AgentProviderResponseSchema>;
