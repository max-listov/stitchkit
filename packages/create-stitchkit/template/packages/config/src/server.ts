import path from 'node:path';
import { createEnv } from '@t3-oss/env-core';
import { config } from 'dotenv';
import { z } from 'zod';
import { featureServerSchema } from './features';

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
    CORS_ORIGIN: z.url(),
    ...featureServerSchema,
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/** Preserve the host process environment while applying explicit child-process overrides. */
export function childEnvironment(
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}
