import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { runNativeCommand } from '../packages/core/src/process/command';
import {
  databaseProbeFingerprint,
  STARTER_DATABASE_PROBE_QUERY,
} from './starter-database-probe';

export const LaneInputSchema = z.enum(['postgres', 'browsers']);
export type LaneInput = z.infer<typeof LaneInputSchema>;
type Environment = Record<string, string | undefined>;

const POSTGRES_STEPS = new Set([
  'test:postgres-stores',
  'starter-lane',
  'starter-head-lane',
  'supervised-lane',
]);
const BROWSER_STEPS = new Set(['starter-lane', 'starter-head-lane']);

export function laneInputsForSteps(steps: readonly string[]): LaneInput[] {
  const inputs: LaneInput[] = [];
  if (steps.some((step) => POSTGRES_STEPS.has(step))) inputs.push('postgres');
  if (steps.some((step) => BROWSER_STEPS.has(step))) inputs.push('browsers');
  return inputs;
}

const BrowserContextSchema = z.object({
  packageRoot: z.string(),
  // Set only for an actual generated project, never inferred from the template.
  executionCwd: z.string().optional(),
  version: z.string().optional(),
});
export type BrowserContext = z.infer<typeof BrowserContextSchema>;

async function captureProbe(
  executable: string,
  args: string[],
  environment: Environment,
  timeoutMs: number,
  cwd?: string,
): Promise<string | undefined> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined) env[name] = value;
  const result = await runNativeCommand({
    executable,
    args,
    cwd,
    envPolicy: 'declared-only',
    env,
    timeoutMs,
    killGraceMs: 0,
    cleanupTimeoutMs: 500,
    capture: true,
    maxOutputBytes: 16 * 1024,
  });
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : undefined;
}

/** Only required inputs enter the key; unavailable inputs never authorize reuse. */
export async function laneEnvironmentFingerprint(
  environment: Environment = Bun.env,
  required: readonly LaneInput[] = ['postgres', 'browsers'],
  browserContext: BrowserContext = {
    packageRoot: join(import.meta.dir, '../packages/create-stitchkit/template'),
  },
): Promise<string> {
  const parts: string[] = [];
  if (required.includes('postgres')) parts.push(await postgresFingerprint(environment));
  if (required.includes('browsers'))
    parts.push(await browserFingerprint(environment, browserContext));
  return parts.join(' ') || 'lanes:none';
}

export function laneEnvironmentIsReusable(fingerprint: string): boolean {
  return !/pg:(?:unreachable|unmeasurable|unknown)|browsers:(?:absent|none|unknown)/.test(
    fingerprint,
  );
}

/** Configuration path identity excludes its credential contents, including passfile. */
export function postgresConnectionFingerprint(
  url: string | undefined,
  environment: Environment = {},
): string {
  if (!url) return 'local-socket';
  try {
    const parsed = new URL(url);
    const parameters = [...parsed.searchParams].filter(
      ([name]) => !['password', 'sslpassword'].includes(name.toLowerCase()),
    );
    const effective: Record<string, string | undefined> = {};
    const include = (key: string, explicit: boolean) => {
      if (!explicit && environment[key] !== undefined) effective[key] = environment[key];
    };
    include('PGHOST', !!parsed.hostname || parsed.searchParams.has('host'));
    include('PGPORT', !!parsed.port || parsed.searchParams.has('port'));
    include('PGUSER', !!parsed.username || parsed.searchParams.has('user'));
    include('PGDATABASE', parsed.pathname.length > 1 || parsed.searchParams.has('dbname'));
    include('PGSSLMODE', parsed.searchParams.has('sslmode'));
    // libpq's service/passfile settings are configuration paths, not passwords.
    // Fully explicit URIs do not inherit endpoint defaults from PG* variables.
    const partial = !parsed.hostname || !parsed.username || parsed.pathname.length <= 1;
    for (const key of ['PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS'])
      include(key, !partial && !parsed.searchParams.has('service'));
    return createHash('sha256')
      .update(
        JSON.stringify([
          parsed.protocol,
          parsed.hostname,
          parsed.port,
          parsed.pathname,
          parsed.username,
          parameters,
          effective,
        ]),
      )
      .digest('hex');
  } catch {
    return 'invalid-connection';
  }
}

/** URL mode uses the lane's Bun SQL owner; local mode uses the same sudo/psql endpoint. */
export async function postgresFingerprint(
  environment: Environment,
  timeoutMs = 1000,
): Promise<string> {
  const url = environment.STARTER_TEST_DATABASE_ADMIN_URL;
  const connection = postgresConnectionFingerprint(url, environment);
  try {
    const output = url
      ? await captureProbe(
          process.execPath,
          [join(import.meta.dir, 'starter-database-probe.ts')],
          environment,
          timeoutMs,
        )
      : await captureProbe(
          'sudo',
          [
            '-n',
            '-u',
            'postgres',
            'psql',
            '-w',
            '--dbname',
            'postgres',
            '-tAc',
            STARTER_DATABASE_PROBE_QUERY,
          ],
          environment,
          timeoutMs,
        );
    if (!output) return `pg:unreachable:${connection}`;
    const measured = url ? output : databaseProbeFingerprint(output);
    if (!/^pg:\d[^\s]*:[0-9a-f]{64}$/.test(measured)) return `pg:unknown:${connection}`;
    return `${measured}:${connection}`;
  } catch {
    return `pg:unmeasurable:${connection}`;
  }
}

/** Delegate resolution to the selected package, in a child with the lane's environment. */
export async function browserFingerprint(
  environment: Environment,
  context: BrowserContext,
): Promise<string> {
  const override = environment.PLAYWRIGHT_BROWSERS_PATH;
  if (
    !context.executionCwd &&
    (override === '0' ||
      (override && !isAbsolute(override) && !isAbsolute(environment.INIT_CWD ?? '')))
  )
    return 'browsers:unknown-context';
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(context.packageRoot, 'package.json'), 'utf8'),
    );
    const selected = z
      .object({ overrides: z.object({ 'playwright-core': z.string() }) })
      .parse(manifest);
    const version = context.version ?? selected.overrides['playwright-core'];
    const output = await captureProbe(
      process.execPath,
      [join(import.meta.dir, 'gate-browser-probe.ts'), context.packageRoot, version],
      environment,
      1000,
      context.executionCwd ?? context.packageRoot,
    );
    return output && /^browsers:[^\s]+:[0-9a-f]{64}$/.test(output)
      ? output
      : 'browsers:unknown-runtime';
  } catch {
    return 'browsers:unknown-runtime';
  }
}
