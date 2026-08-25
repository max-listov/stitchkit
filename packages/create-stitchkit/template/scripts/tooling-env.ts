import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import { ensureLocalEnvironment } from './local-env';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
// Tooling addresses are LEGITIMATELY bound to a place — they name the deployment a
// check is dialling. They must not be named `NEXT_PUBLIC_*`, because that
// prefix makes Next substitute the value into the build output.
const ToolingEnvSchema = z.object({
  SMOKE_API_ORIGIN: z.url(),
  SMOKE_WEB_ORIGIN: z.url(),
  PLAYWRIGHT_BASE_URL: z.url().optional(),
});

export function loadToolingEnv(root = path.resolve(scriptDirectory, '..')) {
  // Self-heal FIRST — a fresh clone has no `.env`, and validation must not
  // fire before the environment can be created (the second-developer path:
  // `runtime:smoke` and `e2e` both start here).
  ensureLocalEnvironment(root);
  dotenvConfig({ path: path.resolve(root, '.env'), quiet: true });
  return ToolingEnvSchema.parse(process.env);
}

/** Process inheritance is isolated to this tooling environment boundary. */
export function inheritToolingEnvironment(
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}
