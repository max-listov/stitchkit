import { resolve } from 'node:path';
import { appIdentity } from '../packages/config/src/identity';
import { childEnvironment, env } from '../packages/config/src/server';
import { ensureLocalEnvironment } from './local-env';

const root = resolve(import.meta.dir, '..');
async function run(command: string[], environment?: Record<string, string>): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment ? childEnvironment(environment) : undefined,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

export async function runDevelopment(environment?: Record<string, string>): Promise<void> {
  await ensureLocalEnvironment(root);
  const environmentForRun = developmentEnvironment(environment);
  await run(['bun', 'run', 'db:setup'], environmentForRun);
  await run(
    ['pm2', 'startOrReload', 'ecosystem.dev.config.cjs', '--update-env'],
    environmentForRun,
  );
}

export function developmentEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    API_PORT: String(env.API_PORT),
    WEB_PORT: String(env.WEB_PORT),
    CORS_ORIGIN: env.CORS_ORIGIN,
    NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_WEB_URL: env.NEXT_PUBLIC_WEB_URL,
    INTERNAL_API_URL: env.INTERNAL_API_URL,
    DEV_HTTPS_CERT: '',
    DEV_HTTPS_KEY: '',
    DEV_HTTPS_CA: '',
    NODE_EXTRA_CA_CERTS: '',
    ...overrides,
  };
}

if (import.meta.main) {
  await runDevelopment();

  console.log(`${appIdentity.name} development processes are running`);
  console.log('Web: http://localhost:3210/en');
  console.log('API: http://localhost:3211');
}
