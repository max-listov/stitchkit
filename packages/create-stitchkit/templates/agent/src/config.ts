import { z } from 'zod';

const EnvironmentSchema = z
  .object({
    OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required'),
    OPENROUTER_MODEL: z.string().min(1).optional(),
  })
  .loose();

export interface AgentConfig {
  apiKey: string;
  preferredModelId?: string;
}

export function readAgentConfig(environment: Record<string, string | undefined>): AgentConfig {
  const result = EnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = [
      ...new Set(
        result.error.issues
          .map((issue) => issue.path[0])
          .filter((field) => field !== undefined),
      ),
    ];
    throw new Error(`Missing or invalid configuration: ${fields.join(', ')}`);
  }
  const parsed = result.data;
  return {
    apiKey: parsed.OPENROUTER_API_KEY,
    ...(parsed.OPENROUTER_MODEL && { preferredModelId: parsed.OPENROUTER_MODEL }),
  };
}
