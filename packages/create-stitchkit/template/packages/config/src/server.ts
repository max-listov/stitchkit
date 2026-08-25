import path from 'node:path';
import { createEnv } from '@t3-oss/env-core';
import { config } from 'dotenv';
import { applicationVariables } from './variables';

config({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

/**
 * The API role's view of the environment: every declared variable.
 *
 * The variables themselves are declared once in `variables.ts` — this module
 * only says which of them this role validates, and where the file is read from.
 */
export const env = createEnv({
  server: applicationVariables,
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

/** Preserve the host process environment while applying explicit child-process overrides. */
export function childEnvironment(
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}
