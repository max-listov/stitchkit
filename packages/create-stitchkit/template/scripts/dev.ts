import { resolve } from 'node:path';
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
  await run(['bun', 'run', 'db:setup'], environmentForRun);
  await run(
    ['pm2', 'startOrReload', 'ecosystem.dev.config.cjs', '--update-env'],
    environmentForRun,
  );
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

  console.log(`${appIdentity.name} development processes are running`);
  console.log('Web: http://localhost:3210/en');
  console.log('API: http://localhost:3211');
}
