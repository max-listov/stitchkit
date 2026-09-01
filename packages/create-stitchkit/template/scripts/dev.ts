import { resolve } from 'node:path';
import { z } from 'zod';
import { appDeclaration } from '../packages/config/src/declaration';
import { assertUsableEnvironment, ensureLocalEnvironment } from './local-env';
import { awaitRolesAnswering, declaredRoleReadiness } from './readiness';
import { runDeclaredReleaseSteps } from './release-steps';
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
  // Before pm2, before anything: an unusable environment is the reader's problem to fix, and
  // making them read a supervisor error first only delays the sentence that matters.
  assertUsableEnvironment(root);
  assertToolAvailable('pm2', 'Install PM2 with `bun add --global pm2`, then rerun.');
  await run(['pm2', 'ping']);
  const environmentForRun = await developmentEnvironment(environment);
  // Kept for an environment supplied from the shell rather than from `.env`, which the file
  // check above cannot see.
  if (environmentForRun.DATABASE_URL?.includes('USER:PASSWORD')) {
    throw new Error(
      'DATABASE_URL still contains the starter placeholder. Create a PostgreSQL database, update DATABASE_URL in .env, then rerun `bun run dev`.',
    );
  }
  await assertPortsAvailable(environmentForRun);
  // The generated client is a BUILD artifact; applying migrations is a RELEASE
  // step the declaration owns. Development runs the same release step as
  // production, so the two paths cannot drift on what 'up to date' means.
  await run(['bun', 'run', 'db:generate'], environmentForRun);
  await runDeclaredReleaseSteps(environmentForRun);
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
  const managed = appDeclaration.roles.map(
    (role) => `${appDeclaration.identity.slug}-${role.name}-dev`,
  );
  if (managed.some((name) => registered.has(name))) return;
  // Which ports to probe comes from the declaration, not from a second list
  // of variable names here: a new role is covered by declaring it.
  for (const role of appDeclaration.roles) {
    if (!role.listener) continue;
    const variable = role.listener.portVariable;
    assertPortFree(Number(environment[variable]), variable);
  }
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
      `Port ${port} (${variable}) is already in use by another process. Pick a free port in .env and update the SMOKE_* origins that embed it.`,
    );
  }
}

function assertToolAvailable(command: string, instruction: string): void {
  if (!Bun.which(command)) throw new Error(`${command} is required. ${instruction}`);
}

/**
 * The validated environment the development processes run with.
 *
 * Every variable the DECLARATION names, and no hand-written list beside it: a
 * list here went stale the moment a variable was added, and a role declaring a
 * port whose name was missing got `Number(undefined)` — reported as
 * `Port NaN (WORKER_PORT) is already in use`, which is a false diagnosis of a
 * real mistake.
 */
export async function developmentEnvironment(
  overrides: Record<string, string> = {},
): Promise<Record<string, string>> {
  const { env } = await import('../packages/config/src/server');
  const validated: Record<string, unknown> = env;
  const declared: Record<string, string> = {};
  for (const variable of appDeclaration.env.variables) {
    const value = validated[variable.name];
    if (value !== undefined) declared[variable.name] = String(value);
  }
  return { ...declared, ...overrides };
}

if (import.meta.main) {
  await runDevelopment();

  const environment = await developmentEnvironment();
  const roles = declaredRoleReadiness(appDeclaration, environment);
  // Reported only once it is TRUE. The supervisor returns at the spawn, and a
  // development build needs seconds after that before it listens — so the line
  // below used to be printed at a moment when nothing answered, and the next
  // command in the gate list got a connection reset.
  await awaitRolesAnswering(roles);
  console.log(`${appDeclaration.identity.name} development processes are running`);
  for (const role of roles) console.log(`${role.name}: ${role.url}`);
}
