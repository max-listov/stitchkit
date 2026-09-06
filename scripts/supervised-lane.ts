/**
 * The supervised lane — the roles under a REAL supervisor, started and stopped.
 *
 * Everything this repository knows about supervised behaviour was found by
 * running it, not by reading it: a launcher between PM2 and the role made the
 * stop signal arrive twice and collapsed a declared 15 s drain into 1.3 ms; a
 * workspace filter swallowed the signal entirely; renaming the processes made a
 * new pair fight the old one for the same ports under `autorestart`. Not one of
 * those is visible in a diff, and each one shipped.
 *
 * So the class of check belongs to a machine. This lane scaffolds a project,
 * builds it, hands it to PM2 exactly as `bun run pm2:prod` does, asks for a
 * stop, and requires the drain to have actually run.
 *
 * It never touches a developer's PM2: `PM2_HOME` points at a temporary
 * directory, which gives the lane its own daemon, its own process list and its
 * own logs. Nothing is saved, and the daemon is killed on the way out.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertNothingSurvives,
  claimLaneDirectory,
  reapOnTermination,
  reapProcessesUnder,
  releaseLaneDirectory,
  supervisorPidIn,
  sweepAbandonedLaneDirectories,
  sweepAbandonedLaneProcesses,
} from './lane-processes';
import { createStarterLaneDatabase } from './starter-database';

const repositoryRoot = resolve(import.meta.dir, '..');

interface Spawned {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function capture(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<Spawned> {
  const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const result = await capture(command, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

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

async function waitFor(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(500);
  }
  throw new Error(`${label} never became ready at ${url}`);
}

interface SupervisedProcess {
  name: string;
  status: string;
  exitCode: number | undefined;
}

function readProcessList(output: string): SupervisedProcess[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('pm2 jlist did not return a list');
  return parsed.map((entry) => {
    const name =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : null;
    const environment =
      typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'pm2_env') : null;
    const status =
      typeof environment === 'object' && environment !== null
        ? Reflect.get(environment, 'status')
        : null;
    const exitCode =
      typeof environment === 'object' && environment !== null
        ? Reflect.get(environment, 'exit_code')
        : null;
    return {
      name: typeof name === 'string' ? name : '<unnamed>',
      status: typeof status === 'string' ? status : '<unknown>',
      exitCode: typeof exitCode === 'number' ? exitCode : undefined,
    };
  });
}

// Same rule as the packed lane: sweep what an earlier run abandoned before
// adding to it. This lane leaves the worse kind behind — a supervisor daemon
// with its own isolated home, which keeps restarting the roles it owns.
const swept = await sweepAbandonedLaneProcesses();
if (swept > 0) {
  console.log(`[supervised-lane] reaped ${swept} process(es) abandoned by an earlier run`);
}
// And their trees: the `rm` at the end of this file runs on no path a signal or
// the OOM killer takes, so every such run used to leave its workspace on disk.
const reclaimed = await sweepAbandonedLaneDirectories();
if (reclaimed.length > 0) {
  console.log(
    `[supervised-lane] removed ${reclaimed.length} directory(ies) abandoned by an earlier run`,
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'supervised-lane-'));
await claimLaneDirectory(workspace);
const pm2Home = join(workspace, 'pm2');

/**
 * The environment every child of this lane runs in.
 *
 * `PM2_HOME` points at a temporary directory so the lane never touches a
 * developer's own PM2, and the workspace `node_modules/.bin` is prepended so
 * `pm2` resolves to the version this repository PINS rather than to whatever
 * happens to be installed globally.
 *
 * The pin is the point. This lane used to require a global `pm2`, which kept it
 * out of `verify` — it was the one gate a release commit could not see locally,
 * and the release commit is the one whose red CI run cannot be repaired in
 * place. A pinned devDependency arrives with the `bun install` every
 * contributor already runs, so the prerequisite is not documented, it is gone.
 * It also takes a live `npm install` off the release-critical path, the same
 * reason the Playwright image is pinned by digest and Bun by tarball hash.
 */
function laneEnvironment(): Record<string, string | undefined> {
  const bin = join(repositoryRoot, 'node_modules', '.bin');
  const path = Bun.env.PATH ? `${bin}:${Bun.env.PATH}` : bin;
  return { ...Bun.env, PATH: path, PM2_HOME: pm2Home };
}
// The directory name becomes the project's identity slug, and the slug becomes
// the supervised process names — which is one of the things this lane checks.
const generated = join(workspace, 'supervised-lane');
let daemonStarted = false;
let database: Awaited<ReturnType<typeof createStarterLaneDatabase>> | undefined;
// Boxed, so a thrown `undefined` is still recorded as a failure.
let laneFailure: { error: unknown } | undefined;

const shutDownSupervisor = async (): Promise<void> => {
  if (!daemonStarted) return;
  daemonStarted = false;
  const env = laneEnvironment();
  // `delete` before `kill`, and never `save`: this daemon is the lane's own,
  // and its resurrect list must not outlive it.
  //
  // Both results are CHECKED. Ignoring them let the lane finish green after a
  // failed `pm2 kill`, leaving a daemon that goes on restarting its roles —
  // and a gate that goes green wrongly is worse than no gate.
  for (const command of [
    ['pm2', 'delete', 'all'],
    ['pm2', 'kill'],
  ]) {
    const result = await capture(command, repositoryRoot, env);
    if (result.exitCode !== 0) {
      throw new Error(
        `${command.join(' ')} failed with exit code ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
    }
  }

  // And the command succeeding is still not the fact. Checked while PM2_HOME
  // exists, because once it is removed there is nothing left to look at.
  const deadline = Date.now() + 10_000;
  let survivor = await supervisorPidIn(pm2Home);
  while (survivor !== undefined && Date.now() < deadline) {
    await Bun.sleep(200);
    survivor = await supervisorPidIn(pm2Home);
  }
  if (survivor !== undefined) {
    throw new Error(
      `The lane's supervisor daemon (pid ${survivor}) is still running after pm2 kill. It owns this lane's roles and will keep restarting them.`,
    );
  }
};
// A signal to the lane is exactly the case that used to leave a daemon behind:
// it keeps its roles alive, and restarts them, long after the tree is gone.
reapOnTermination(async () => {
  await shutDownSupervisor();
  await releaseLaneDirectory(workspace);
});

try {
  if (!Bun.which('pm2', { PATH: laneEnvironment().PATH })) {
    throw new Error(
      'pm2 is not resolvable. This lane runs the generated supervision files through the REAL supervisor, and the supervisor is a pinned devDependency of this repository — run `bun install`.',
    );
  }

  // The same disposable database the starter lane creates, from the same
  // admin URL, so this lane needs no second way to be configured.
  database = await createStarterLaneDatabase('target');

  const env = laneEnvironment();

  await run(['bun', '--filter', 'create-stitchkit', 'build'], repositoryRoot, env);
  await run(
    [
      'bun',
      join(repositoryRoot, 'packages/create-stitchkit/dist/cli.js'),
      generated,
      '--no-install',
      '--display-name',
      'Supervised Lane',
    ],
    repositoryRoot,
    env,
  );

  const apiPort = freePort();
  const webPort = freePort();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  await writeFile(
    join(generated, '.env'),
    [
      'NODE_ENV=production',
      `DATABASE_URL=${database.url}`,
      `API_PORT=${apiPort}`,
      `WEB_PORT=${webPort}`,
      `SMOKE_API_ORIGIN=${apiOrigin}`,
      `SMOKE_WEB_ORIGIN=${webOrigin}`,
      `PUBLIC_WEB_HOSTS=127.0.0.1:${webPort}`,
      'LOG_FORMAT=json',
      '',
    ].join('\n'),
  );

  await run(['bun', 'install'], generated, env);
  await run(['bun', 'run', 'db:setup'], generated, env);
  await run(['bun', 'run', 'build'], generated, env);

  // Exactly the entry point the README gives an operator — not a hand-built
  // pm2 command that could differ from what a project actually runs.
  daemonStarted = true;
  await run(['bun', 'run', 'pm2:prod'], generated, env);

  const declaration: unknown = JSON.parse(
    await readFile(join(generated, 'project.json'), 'utf8'),
  );
  const identity =
    typeof declaration === 'object' && declaration !== null
      ? Reflect.get(declaration, 'identity')
      : null;
  const slug =
    typeof identity === 'object' && identity !== null ? Reflect.get(identity, 'slug') : null;
  if (typeof slug !== 'string')
    throw new Error('the generated declaration has no identity slug');

  const expected = [`${slug}-api`, `${slug}-web`];
  const registered = readProcessList(await run(['pm2', 'jlist'], generated, env));
  const registeredNames = registered.map((entry) => entry.name).sort();
  if (JSON.stringify(registeredNames) !== JSON.stringify([...expected].sort())) {
    // A renamed role that leaves the old process behind is how two supervised
    // pairs end up fighting for one port under `autorestart`.
    throw new Error(
      `Supervised process names differ from the declared roles: ${registeredNames.join(', ')} (expected ${expected.join(', ')})`,
    );
  }

  await Promise.all([
    waitFor(`${apiOrigin}/health`, 'supervised API role'),
    waitFor(`${webOrigin}/en`, 'supervised web role'),
  ]);

  // THE POINT OF THE LANE. A stop the supervisor asked for must run the role's
  // own shutdown and end with a zero exit code. Anything else — a forced
  // outcome, a non-zero code, a missing line — means the drain the declaration
  // promises did not happen, which is invisible from the outside.
  await run(['pm2', 'stop', 'all'], generated, env);

  const stopped = readProcessList(await run(['pm2', 'jlist'], generated, env));
  for (const entry of stopped) {
    if (entry.status !== 'stopped') {
      throw new Error(`${entry.name} is ${entry.status} after a requested stop`);
    }
    if (entry.exitCode !== 0) {
      throw new Error(
        `${entry.name} exited with ${entry.exitCode ?? 'no code'} on a requested stop — a stop the supervisor asked for is a success`,
      );
    }
  }

  const apiLog = await readFile(join(pm2Home, 'logs', `${slug}-api-out.log`), 'utf8');
  const shutdown = /Shutdown (\w+)(?: \((\w+)\))? in ([\d.]+)ms/.exec(apiLog);
  if (!shutdown) {
    throw new Error(
      `The API role never reported how its shutdown ended. Without that line a forced shutdown and a clean one look identical from outside.\n${apiLog}`,
    );
  }
  const [, outcome, reason] = shutdown;
  if (outcome !== 'clean') {
    throw new Error(
      `The supervised API role shut down "${outcome}"${reason ? ` (${reason})` : ''} instead of draining. A launcher between the supervisor and the role, or a kill timeout below the role's budget, produces exactly this.`,
    );
  }

  console.log(
    `Supervised lane passed: ${expected.join(' and ')} started under PM2, answered, and stopped clean with exit code 0`,
  );
} catch (error) {
  laneFailure = { error };
}

// Cleanup is no longer only cleanup: a surviving daemon is a red gate. So it
// has to be able to fail — and a `finally` that throws DISCARDS whatever the
// lane was already failing on, which is why this is not one. Both outcomes are
// collected and reported together.
const cleanupFailures: unknown[] = [];
for (const step of [
  shutDownSupervisor,
  async () => database?.dispose(),
  () => reapProcessesUnder(workspace),
  () => assertNothingSurvives(workspace),
]) {
  try {
    await step();
  } catch (error) {
    cleanupFailures.push(error);
  }
}
await rm(workspace, { recursive: true, force: true });

const failures = [...(laneFailure ? [laneFailure.error] : []), ...cleanupFailures];
if (failures.length === 1) throw failures[0];
if (failures.length > 1) {
  throw new AggregateError(failures, 'The supervised lane failed, and so did its cleanup');
}
