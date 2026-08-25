import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig, parse as parseDotenv } from 'dotenv';
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
  // What the deployment says about the addresses it serves. A check that proves
  // one artifact answers on many can only dial an address the deployment
  // claims — every other one is refused, by design — so it has to read the
  // claim rather than carry two fixture hosts of its own and require the
  // deployment to have been told the same two names.
  PUBLIC_WEB_ORIGIN: z.url().optional(),
  PUBLIC_WEB_HOSTS: z.string().min(1).optional(),
  // The acceptance gate's own database. Optional here because only that gate
  // needs it and `runtime:smoke` must still run against a deployment someone
  // else brought up; `resolveAcceptanceDatabase` is what makes it mandatory
  // where it matters, with a refusal that names the line to add.
  ACCEPTANCE_DATABASE_URL: z.url().optional(),
});

export function loadToolingEnv(root = path.resolve(scriptDirectory, '..')) {
  // Self-heal FIRST — a fresh clone has no `.env`, and validation must not
  // fire before the environment can be created (the second-developer path:
  // `runtime:smoke` and `e2e` both start here).
  ensureLocalEnvironment(root);
  dotenvConfig({ path: path.resolve(root, '.env'), quiet: true });
  return ToolingEnvSchema.parse(process.env);
}

/**
 * The environment this deployment actually runs with: what the place injected,
 * with `.env` filling the gaps.
 *
 * The same precedence the generated supervision file uses — a file in the
 * repository never overrules the place — so a script reading it and a role
 * started from it cannot disagree about which port a role is on.
 */
export function deploymentEnvironment(
  root = path.resolve(scriptDirectory, '..'),
): Record<string, string | undefined> {
  const file = path.resolve(root, '.env');
  const fromFile = existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

/** Process inheritance is isolated to this tooling environment boundary. */
export function inheritToolingEnvironment(
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}
