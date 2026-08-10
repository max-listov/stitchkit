import { z } from 'zod';

export const featureServerSchema = {
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  GITHUB_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  GITHUB_TOKEN: z.string().min(1).optional(),
};
