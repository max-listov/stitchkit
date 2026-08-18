import { resolve } from 'node:path';
import { z } from 'zod';
import { appIdentity } from '../packages/config/src/identity';
import { ensureLocalEnvironment } from './local-env';
import { inheritToolingEnvironment } from './tooling-env';

const root = resolve(import.meta.dir, '..');
async function run(command: string[], environment?: Record<string, string>): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment ? inheritToolingEnvironment(environment) : undefined,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

export async function runDevelopment(environment?: Record<string, string>): Promise<void> {
  ensureLocalEnvironment(root);
  assertToolAvailable('pm2', 'Install PM2 with `bun add --global pm2`, then rerun.');
  await run(['pm2', 'ping']);
  const environmentForRun = await developmentEnvironment(environment);
  if (environmentForRun.DATABASE_URL?.includes('USER:PASSWORD')) {
    throw new Error(
      'DATABASE_URL still contains the starter placeholder. Create a PostgreSQL database, update DATABASE_URL in .env, then rerun `bun run dev`.',
    );
  }
  await assertPortsAvailable(environmentForRun);
  await run(['bun', 'run', 'db:setup'], environmentForRun);
  await run(
    ['pm2', 'startOrReload', 'ecosystem.dev.config.cjs', '--update-env'],
    environmentForRun,
  );
}

/**
 * Fail fast with the offending variable when a port is held by a FOREIGN
 * process. A rerun of `bun run dev` reloads this app's own PM2 processes while
 * they still hold the ports, so the probe is skipped once they are registered.
 */
async function assertPortsAvailable(environment: Record<string, string>): Promise<void> {
  const registered = await registeredPm2Names();
  const managed = [`${appIdentity.slug}-backend-dev`, `${appIdentity.slug}-frontend-dev`];
  if (managed.some((name) => registered.has(name))) return;
  assertPortFree(Number(environment.API_PORT), 'API_PORT');
  assertPortFree(Number(environment.WEB_PORT), 'WEB_PORT');
}

async function registeredPm2Names(): Promise<Set<string>> {
  const child = Bun.spawn(['pm2', 'jlist'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  await child.exited;
  const parsed = z.array(z.object({ name: z.string() })).safeParse(safeJsonParse(output));
  return new Set(parsed.success ? parsed.data.map((entry) => entry.name) : []);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function assertPortFree(port: number, variable: string): void {
  try {
    const listener = Bun.listen({
      hostname: '127.0.0.1',
      port,
      socket: { data: () => undefined },
    });
    listener.stop(true);
  } catch {
    throw new Error(
      `Port ${port} (${variable}) is already in use by another process. Pick a free port in .env and update the URLs that embed it.`,
    );
  }
}

function assertToolAvailable(command: string, instruction: string): void {
  if (!Bun.which(command)) throw new Error(`${command} is required. ${instruction}`);
}

export async function developmentEnvironment(
  overrides: Record<string, string> = {},
): Promise<Record<string, string>> {
  const { env } = await import('../packages/config/src/server');
  return {
    DATABASE_URL: env.DATABASE_URL,
    BIND_HOST: env.BIND_HOST,
    API_PORT: String(env.API_PORT),
    WEB_PORT: String(env.WEB_PORT),
    CORS_ORIGIN: env.CORS_ORIGIN,
    NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_WEB_URL: env.NEXT_PUBLIC_WEB_URL,
    INTERNAL_API_URL: env.INTERNAL_API_URL,
    ...overrides,
  };
}

if (import.meta.main) {
  await runDevelopment();

  const environment = await developmentEnvironment();
  console.log(`${appIdentity.name} development processes are running`);
  console.log(`Web: ${environment.NEXT_PUBLIC_WEB_URL}/en`);
  console.log(`API: ${environment.NEXT_PUBLIC_API_URL}`);
}
