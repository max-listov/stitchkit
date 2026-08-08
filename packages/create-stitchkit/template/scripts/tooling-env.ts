import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(scriptDirectory, '..', '.env'), quiet: true });

const ToolingEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  NEXT_PUBLIC_WEB_URL: z.url(),
  PLAYWRIGHT_BASE_URL: z.url().optional(),
});

export const toolingEnv = ToolingEnvSchema.parse(process.env);
