import { z } from 'zod';

/** Provider-assigned identity for one completed model step. */
export const AgentProviderResponseSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1).optional(),
  })
  .strict();

export type AgentProviderResponse = z.infer<typeof AgentProviderResponseSchema>;
