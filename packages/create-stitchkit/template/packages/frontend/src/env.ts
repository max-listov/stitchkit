import path from 'node:path';
import { createEnv } from '@t3-oss/env-nextjs';
import { config } from 'dotenv';
import { z } from 'zod';

config({ path: path.resolve(process.cwd(), '../../.env'), quiet: true });

export const env = createEnv({
  server: { INTERNAL_API_URL: z.url(), WEB_PORT: z.coerce.number().int().positive() },
  client: {
    NEXT_PUBLIC_API_URL: z.url(),
    NEXT_PUBLIC_WEB_URL: z.url(),
  },
  runtimeEnv: {
    INTERNAL_API_URL: process.env.INTERNAL_API_URL,
    WEB_PORT: process.env.WEB_PORT,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_WEB_URL: process.env.NEXT_PUBLIC_WEB_URL,
  },
  emptyStringAsUndefined: true,
});
