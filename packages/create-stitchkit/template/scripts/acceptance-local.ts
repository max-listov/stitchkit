/**
 * The runtime gates, against a deployment this script owns.
 *
 * `runtime:smoke` and `e2e` check a RUNNING deployment, so a gate list has to
 * bring one up. A gate must not do so through
 * `pm2:prod`: it applies the declared migrations and reloads the developer's
 * own PM2 daemon, turning verification into a deployment.
 * A gate may not mutate a deployment; it may only create and destroy its own.
 *
 * So everything here is this run's and nothing else's: its own `PM2_HOME`, its
 * own ephemeral ports, its own public-host allowlist, its own database, and a
 * stop that names the roles the declaration declares rather than deleting
 * whatever the daemon happened to hold.
 *
 * The gate writes: the repository example's smoke posts a refresh that upserts.
 * It requires `ACCEPTANCE_DATABASE_URL`, distinct from the deployment's own
 * database. The deployment's URL is excluded from the child environment so no
 * role here can reach it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appDeclaration } from '../packages/config/src/declaration';
import { resolveAcceptanceDatabase } from './acceptance-database';
import { awaitRolesAnswering, declaredRoleReadiness } from './readiness';
import { assertBuildArtifacts, runDeclaredReleaseSteps } from './release-steps';
import { deploymentEnvironment } from './tooling-env';

const root = resolve(import.meta.dir, '..');

function freePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data: () => undefined },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function run(command: string[], env: Record<string, string>): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

if (!Bun.which('pm2')) {
  throw new Error(
    'pm2 is required to run the local acceptance gate. Install it with `bun add --global pm2`, then rerun.',
  );
}

assertBuildArtifacts();

const home = await mkdtemp(join(tmpdir(), 'acceptance-local-'));
const apiPort = freePort();
const webPort = freePort();
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const base = deploymentEnvironment(root);
// Before anything starts, and before the deployment's own URL is copied into
// the child environment: a refusal here costs a message, a missing one costs
// rows in someone's database.
const acceptanceDatabaseUrl = resolveAcceptanceDatabase(base);
const environment: Record<string, string> = {};
for (const [name, value] of Object.entries(base)) {
  if (value !== undefined) environment[name] = value;
}
delete environment.ACCEPTANCE_DATABASE_URL;
Object.assign(environment, {
  NODE_ENV: 'production',
  // The gates read the catalogue and the OpenAPI document; the closed default is
  // proved after them, on the same artifact.
  SERVICE_SURFACES: 'open',
  // The one address every role, every migration and every gate here will see.
  DATABASE_URL: acceptanceDatabaseUrl,
  PM2_HOME: home,
  API_PORT: String(apiPort),
  WEB_PORT: String(webPort),
  INTERNAL_API_URL: apiOrigin,
  SMOKE_API_ORIGIN: apiOrigin,
  SMOKE_WEB_ORIGIN: webOrigin,
  PLAYWRIGHT_BASE_URL: webOrigin,
  // The portability proof asks this deployment to answer as addresses other
  // than the one it is dialled on. Those addresses belong to the CHECK, so
  // they are supplied here rather than written into the project's own
  // `.env.example`, where they would be policy a deployment carries for real.
  PUBLIC_WEB_HOSTS: `127.0.0.1:${webPort},alpha.example,beta.example:8443`,
});

// Boxed, so a thrown `undefined` is still recorded as a failure.
let failure: { error: unknown } | undefined;
try {
  // The declared migrations, against the acceptance database. A deployment is
  // brought to its source before its roles start — that is a property of this
  // deployment too, and skipping it here would mean the gates run against
  // whatever schema the throwaway database happened to have.
  await runDeclaredReleaseSteps(environment);
  await run(['pm2', 'start', 'ecosystem.config.cjs', '--update-env'], environment);
  await awaitRolesAnswering(declaredRoleReadiness(appDeclaration, environment));
  await run(['bun', 'run', 'runtime:smoke'], environment);
  await run(['bun', 'run', 'e2e'], environment);
  const closed = { ...environment, SERVICE_SURFACES: 'closed' };
  await run(['pm2', 'restart', 'ecosystem.config.cjs', '--update-env'], closed);
  await awaitRolesAnswering(declaredRoleReadiness(appDeclaration, closed));
  await run(['bun', 'run', 'surfaces:closed'], closed);
  console.log(
    `Local acceptance passed: ${appDeclaration.roles.map((role) => role.name).join(' and ')} answered on ephemeral ports, both runtime gates are green, and the service surfaces close`,
  );
} catch (error) {
  failure = { error };
}

// Only what this run started, named from the declaration. `pm2 delete all`
// would delete every application in the daemon it is pointed at — and pointing
// it at the wrong home is one forgotten variable away.
const cleanupFailures: unknown[] = [];
for (const step of [
  () =>
    run(
      [
        'pm2',
        'delete',
        ...appDeclaration.roles.map((role) => `${appDeclaration.identity.slug}-${role.name}`),
      ],
      environment,
    ),
  () => run(['pm2', 'kill'], environment),
  () => rm(home, { recursive: true, force: true }),
]) {
  try {
    await step();
  } catch (error) {
    cleanupFailures.push(error);
  }
}

const failures = [...(failure ? [failure.error] : []), ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(failures, 'Local acceptance failed, and so did its cleanup');
}
