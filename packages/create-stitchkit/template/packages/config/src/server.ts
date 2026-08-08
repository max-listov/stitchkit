import path from 'node:path';
import { createEnv } from '@t3-oss/env-core';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

export const env = createEnv({
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url(),
    API_PORT: z.coerce.number().int().positive(),
    WEB_PORT: z.coerce.number().int().positive(),
    NEXT_PUBLIC_API_URL: z.url(),
    INTERNAL_API_URL: z.url(),
    NEXT_PUBLIC_WEB_URL: z.url(),
    LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
    GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    GITHUB_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    GITHUB_TOKEN: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
