import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertNothingSurvives,
  reapOnTermination,
  reapProcessesUnder,
  stopProcessGroup,
  sweepAbandonedLaneProcesses,
} from './lane-processes';
import { findNeutralIdentity } from './neutral-identity';
import { createStarterLaneDatabase } from './starter-database';
import { parseStarterLaneOptions } from './starter-lane-options';
import {
  assertCatalogIsTheOnlyStitchkitRange,
  readStarterStitchkitTarget,
  writeStarterStitchkitTarget,
} from './starter-manifest';

function parseIdentityAllowlist(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('identity allowlist must be an object with a paths array');
  }
  const paths = Reflect.get(value, 'paths');
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) {
    throw new Error('identity allowlist paths must be strings');
  }
  return paths;
}

const repositoryRoot = resolve(import.meta.dir, '..');
const templateRoot = join(repositoryRoot, 'packages/create-stitchkit/template');
const { mode, variant: selectedVariant, browser } = parseStarterLaneOptions(Bun.argv.slice(2));

interface CommandOptions {
  env?: Record<string, string | undefined>;
}

async function run(
  command: string[],
  cwd: string,
  options: CommandOptions = {},
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: options.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new Error(`${command.join(' ')} failed with exit code ${exitCode}`);
}

async function capture(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed: ${stderr}`);
  return stdout;
}

async function packageVersion(packagePath: string): Promise<string> {
  const source = await readFile(packagePath, 'utf8');
  const match = source.match(/"version"\s*:\s*"([^"]+)"/);
  const version = match?.[1];
  if (!version) throw new Error(`Package version is missing in ${packagePath}`);
  return version;
}

async function assertGeneratedStarterSupportsHead(generatedRoot: string): Promise<void> {
  const rootManifest = await readFile(join(generatedRoot, 'package.json'), 'utf8');
  const backendManifest = await readFile(
    join(generatedRoot, 'packages/backend/package.json'),
    'utf8',
  );
  const backend = await readFile(join(generatedRoot, 'packages/backend/src/index.ts'), 'utf8');
  const smoke = await readFile(join(generatedRoot, 'scripts/runtime-smoke.ts'), 'utf8');
  const surfaceConformance = await readFile(
    join(generatedRoot, 'scripts/surface-conformance.ts'),
    'utf8',
  );

  const requirements: [source: string, requirement: string][] = [
    [rootManifest, '"@modelcontextprotocol/client": "^2.0.0"'],
    [backendManifest, '"@modelcontextprotocol/server": "^2.0.0"'],
    [backend, 'createMcpHttpRoute'],
    // The session is closed on shutdown — the invariant is the close, not the
    // spelling of it. It used to read `await mcp.close()`, which the role now
    // deliberately does NOT write: an unbounded await there could run past the
    // very kill timeout the declared budget tells a supervisor to allow. That
    // the close is bounded is checked in the generated project's own suite
    // (`scripts/shutdown-budget.test.ts`); that it happens at all is checked
    // here.
    [backend, 'mcp.close()'],
    [surfaceConformance, "from '@modelcontextprotocol/client'"],
    [surfaceConformance, "pin: '2026-07-28'"],
  ];
  for (const [source, requirement] of requirements) {
    if (!source.includes(requirement)) {
      throw new Error(`Generated starter is missing its MCP v2 invariant: ${requirement}`);
    }
  }
  if (
    rootManifest.includes('@modelcontextprotocol/sdk') ||
    backendManifest.includes('@modelcontextprotocol/sdk') ||
    smoke.includes('@modelcontextprotocol/sdk') ||
    surfaceConformance.includes('@modelcontextprotocol/sdk') ||
    backend.includes('mcp(req)')
  ) {
    throw new Error('Generated starter still contains an MCP v1 integration path');
  }
}

function freePort(): number {
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data() {
        return;
      },
    },
  });
  const port = listener.port;
  listener.stop(true);
  return port;
}

function startGitHubFixture(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'GET') return new Response(null, { status: 405 });

      if (url.pathname === '/repos/max-listov/stitchkit') {
        return Response.json({
          full_name: 'max-listov/stitchkit',
          description: 'Contract-first backend framework for Bun and Node',
          html_url: 'https://github.com/max-listov/stitchkit',
          language: 'TypeScript',
          visibility: 'public',
          stargazers_count: 2,
          forks_count: 0,
          open_issues_count: 0,
        });
      }

      if (url.pathname === '/repos/max-listov/stitchkit/commits') {
        const lastPage = new URL(
          '/repos/max-listov/stitchkit/commits?per_page=1&page=57',
          server.url,
        );
        return Response.json(
          [
            {
              sha: '4fb99240c34b28da95ea3ac2f43f7132244a97c0',
              commit: {
                message: 'release(core): ship operational APIs and Bun retry in 0.48.1',
                author: { date: '2026-08-14T12:00:00.000Z' },
                committer: { date: '2026-08-14T12:00:00.000Z' },
              },
            },
          ],
          { headers: { Link: `<${lastPage}>; rel="last"` } },
        );
      }

      return new Response(null, { status: 404 });
    },
  });
  return server;
}

async function waitFor(
  url: string,
  processName: string,
  process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const processState = await Promise.race([
      process.exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(0).then(() => undefined),
    ]);
    if (processState) {
      throw new Error(
        `${processName} exited with code ${processState.exitCode} before ${url} became ready`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

// Sweep BEFORE starting anything. A predecessor that was SIGKILLed — by a
// person, by a supervisor, by the OOM killer — ran no handler at all, and this
// is the only thing that stops its roles outliving one further run.
const swept = await sweepAbandonedLaneProcesses();
if (swept > 0) {
  console.log(`[starter-lane] reaped ${swept} process(es) abandoned by an earlier run`);
}

const workspace = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));

let roles: Array<{ pid: number; exited: Promise<number> }> = [];
const reapEverything = async (): Promise<void> => {
  await Promise.allSettled(roles.map((role) => stopProcessGroup(role)));
  roles = [];
};
// A `finally` covers a throw and nothing else. An interrupted lane is exactly
// the run that leaves the most behind, so the same cleanup runs on a signal.
reapOnTermination(reapEverything);

try {
  const packed = join(workspace, 'packed');
  const runner = join(workspace, 'runner');
  await mkdir(packed, { recursive: true });
  await mkdir(runner, { recursive: true });

  const corePackage = join(repositoryRoot, 'packages/core/package.json');
  const templateTarget = await readStarterStitchkitTarget(templateRoot);

  if (mode === 'head') await run(['bun', '--filter', 'stitchkit', 'build'], repositoryRoot);
  await run(['bun', '--filter', 'create-stitchkit', 'build'], repositoryRoot);

  const createTarball = join(packed, 'create-stitchkit.tgz');
  await run(
    ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', createTarball],
    join(repositoryRoot, 'packages/create-stitchkit'),
  );
  const packedScaffolderFiles = await capture(
    ['tar', '-tzf', createTarball],
    repositoryRoot,
    Bun.env,
  );
  for (const forbiddenPath of [
    'package/template/.env',
    'package/template/.build-stamp.json',
    'package/template/test-results/',
    'package/template/packages/frontend/.next/',
    'package/template/packages/backend/dist/',
    'package/template/packages/db/src/generated/',
    'package/examples/repository/.env',
    'package/examples/repository/packages/db/src/generated/',
  ]) {
    if (packedScaffolderFiles.includes(forbiddenPath)) {
      throw new Error(`Published scaffolder contains runtime artifact: ${forbiddenPath}`);
    }
  }
  if (
    !packedScaffolderFiles.includes('package/examples/repository/packages/shared/src/index.ts')
  ) {
    throw new Error('Published scaffolder is missing the repository example overlay');
  }

  await writeFile(
    join(runner, 'package.json'),
    JSON.stringify({
      private: true,
      dependencies: { 'create-stitchkit': `file:${createTarball}` },
    }),
  );
  await run(['bun', 'install'], runner);

  let expectedVersion: string | undefined;
  let coreTarball: string | undefined;
  if (mode === 'head') {
    expectedVersion = await packageVersion(corePackage);
    coreTarball = join(packed, 'stitchkit.tgz');
    await run(
      ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', coreTarball],
      join(repositoryRoot, 'packages/core'),
    );
  }

  async function runVariant(example?: 'repository'): Promise<void> {
    const variant = example ?? 'blank';
    const generated = join(workspace, `generated-${variant}`);
    const scaffoldCommand = [
      join(runner, 'node_modules/.bin/create-stitchkit'),
      generated,
      '--no-install',
    ];
    if (example) scaffoldCommand.push('--example', example);
    await run(scaffoldCommand, runner);

    const generatedTarget = await readStarterStitchkitTarget(generated);
    if (generatedTarget !== templateTarget) {
      throw new Error(
        `Generated ${variant} target drifted: template=${templateTarget}, generated=${generatedTarget}`,
      );
    }

    // Total identity sweep: no file of the generated tree may carry the
    // template's neutral identity outside the committed allowlist — this is
    // what catches a missed rendering projection, which no fixed list of
    // known substitutions can.
    const allowlist = parseIdentityAllowlist(
      JSON.parse(
        await readFile(
          join(import.meta.dir, '../packages/create-stitchkit/tests/identity-allowlist.json'),
          'utf8',
        ),
      ),
    );
    const neutralOffenders = await findNeutralIdentity(generated, allowlist);
    if (neutralOffenders.length > 0) {
      throw new Error(
        `Generated ${variant} tree carries the neutral template identity:\n${neutralOffenders.join('\n')}`,
      );
    }
    try {
      await assertCatalogIsTheOnlyStitchkitRange(generated);
    } catch (error) {
      throw new Error(
        `${variant} generated tree: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (coreTarball) {
      await writeStarterStitchkitTarget(generated, `file:${coreTarball}`);
      await assertGeneratedStarterSupportsHead(generated);
    }

    const database = await createStarterLaneDatabase(mode);
    const githubFixture = example === 'repository' ? startGitHubFixture() : undefined;
    const githubApiUrl = githubFixture?.url.origin;
    if (example === 'repository' && !githubApiUrl) {
      throw new Error('Repository starter lane requires its GitHub fixture');
    }
    // Boxed, so a thrown `undefined` is still recorded as a failure.
    let laneFailure: { error: unknown } | undefined;
    try {
      const webPort = freePort();
      const apiPort = freePort();
      const webOrigin = `http://127.0.0.1:${webPort}`;
      const apiOrigin = `http://127.0.0.1:${apiPort}`;
      const environmentLines = [
        'NODE_ENV=production',
        `DATABASE_URL=${database.url}`,
        `API_PORT=${apiPort}`,
        `WEB_PORT=${webPort}`,
        `INTERNAL_API_URL=${apiOrigin}`,
        // The deployment the smoke dials. Bound to a place on purpose — and named
        // so that no build substitutes it into an artifact.
        `SMOKE_API_ORIGIN=${apiOrigin}`,
        `SMOKE_WEB_ORIGIN=${webOrigin}`,
        // The hosts this deployment answers for. The portability smoke proves one
        // artifact serves several — within the policy, not for any header. It
        // READS this list rather than carrying hosts of its own, so these two
        // names are the deployment's choice and nothing has to agree with them.
        `PUBLIC_WEB_HOSTS=127.0.0.1:${webPort},alpha.example,beta.example:8443`,
        'LOG_FORMAT=json',
      ];
      if (example === 'repository') {
        environmentLines.push(
          // HTTP is already same-origin here — the web role forwards `/api`.
          // The SOCKET cannot be forwarded by a route handler, so this lane,
          // which runs the two roles on two ports with nothing in front of
          // them, names the socket's origin and admits the browser for it.
          `PUBLIC_REALTIME_ORIGIN=${apiOrigin}`,
          `CORS_ORIGIN=${webOrigin}`,
          `GITHUB_API_URL=${githubApiUrl}`,
          'GITHUB_REPOSITORY=max-listov/stitchkit',
          'GITHUB_CACHE_TTL_SECONDS=900',
        );
      }
      environmentLines.push('');
      await writeFile(join(generated, '.env'), environmentLines.join('\n'));

      const env = {
        ...Bun.env,
        NODE_ENV: 'production',
        DATABASE_URL: database.url,
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
        INTERNAL_API_URL: apiOrigin,
        SMOKE_API_ORIGIN: apiOrigin,
        SMOKE_WEB_ORIGIN: webOrigin,
        PUBLIC_WEB_HOSTS: `127.0.0.1:${webPort},alpha.example,beta.example:8443`,
        PLAYWRIGHT_BASE_URL: webOrigin,
        LOG_FORMAT: 'json',
        ...(example === 'repository' && {
          PUBLIC_REALTIME_ORIGIN: apiOrigin,
          CORS_ORIGIN: webOrigin,
          GITHUB_API_URL: githubApiUrl,
          GITHUB_REPOSITORY: 'max-listov/stitchkit',
          GITHUB_CACHE_TTL_SECONDS: '900',
        }),
      };

      await run(
        mode === 'target' ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'],
        generated,
      );
      const installedPackage = join(
        generated,
        'packages/backend/node_modules/stitchkit/package.json',
      );
      const installedPath = await realpath(
        join(generated, 'packages/backend/node_modules/stitchkit'),
      );
      const installedVersion = await packageVersion(installedPackage);
      const resolvedFromPackedCore = installedPath.includes('/.bun/stitchkit@+');
      if (mode === 'target' && resolvedFromPackedCore) {
        throw new Error(`Static starter target resolved a file dependency: ${installedPath}`);
      }
      if (mode === 'head') {
        if (!resolvedFromPackedCore) {
          throw new Error(
            `HEAD starter probe did not resolve the packed local core: ${installedPath}`,
          );
        }
        if (installedVersion !== expectedVersion) {
          throw new Error(
            `HEAD starter probe resolved stitchkit ${installedVersion}, expected ${expectedVersion}`,
          );
        }
      }
      await run(['bun', 'run', 'check'], generated, { env });
      await run(['bun', 'run', 'test'], generated, { env });
      // The build runs against a database address that ACCEPTS NOTHING.
      //
      // Data read while building is the third kind of input — neither code nor
      // a binding — and a build that reads it is a function of whichever
      // machine happened to have the database. Reading the routes proves
      // nothing here: the dependency arrives transitively, through a helper
      // imported by a component imported by a page. Pointing the build at a
      // closed port is the only check that covers every path at once, and it
      // fails loudly the moment a prerender starts dialling.
      await run(['bun', 'run', 'build'], generated, {
        env: { ...env, DATABASE_URL: `postgresql://nobody@127.0.0.1:${freePort()}/absent` },
      });
      await run(['bun', 'run', 'lint'], generated, { env });

      // Second-developer scenario: a fresh clone carries no `.env`. Both the
      // plain `env:ensure` path and the tooling entry (`runtime:smoke` / `e2e`
      // validate through loadToolingEnv) must self-heal it with the RENDERED
      // application identity before validating anything.
      await rm(join(generated, '.env'), { force: true });
      await run(['bun', 'run', 'env:ensure'], generated);
      const healed = await readFile(join(generated, '.env'), 'utf8');
      if (healed.includes('stitchkit_starter')) {
        throw new Error(
          'env:ensure rendered the neutral identity instead of the application identity',
        );
      }
      await rm(join(generated, '.env'), { force: true });
      await run(
        [
          'bun',
          '-e',
          "import { loadToolingEnv } from './scripts/tooling-env.ts'; loadToolingEnv();",
        ],
        generated,
      );
      const healedByTooling = await readFile(join(generated, '.env'), 'utf8');
      if (healedByTooling !== healed) {
        throw new Error('the tooling entry healed a different environment than env:ensure');
      }
      await writeFile(join(generated, '.env'), environmentLines.join('\n'));

      let api: ReturnType<typeof Bun.spawn> | undefined;
      let web: ReturnType<typeof Bun.spawn> | undefined;
      try {
        await run(['bun', 'run', 'db:setup'], generated, { env });
        // `detached` makes each role a process-group LEADER, so one signal
        // reaches the role and the `bun run` launcher in front of it. Killing
        // the child alone leaves the role running with a deleted working
        // directory — 101 of those accumulated on a shared host in one evening.
        api = Bun.spawn(['bun', 'run', 'start:api'], {
          cwd: generated,
          env,
          detached: true,
          stdout: 'inherit',
          stderr: 'inherit',
        });
        roles = [api];
        web = Bun.spawn(['bun', 'run', 'start:web'], {
          cwd: generated,
          env,
          detached: true,
          stdout: 'inherit',
          stderr: 'inherit',
        });
        roles = [api, web];
        // Registered one at a time, before the next spawn: a signal arriving in
        // between must still find the role that already exists.
        await Promise.all([
          waitFor(`${apiOrigin}/health`, 'starter API', api),
          waitFor(`${webOrigin}/en`, 'starter web', web),
        ]);
        await run(['bun', 'run', 'runtime:smoke'], generated, { env });

        const tools = JSON.parse(await capture(['bun', 'run', 'tools'], generated, env));
        if (!tools.manifest || !tools.names)
          throw new Error('Tool manifest output is incomplete');
        if (example === 'repository') {
          const cli = await capture(
            ['bun', 'run', 'cli', '--', 'repository_read'],
            generated,
            env,
          );
          JSON.parse(cli);
        } else if (tools.names.length !== 0) {
          throw new Error(
            `Blank starter unexpectedly exposes tools: ${tools.names.join(', ')}`,
          );
        }

        const browserNames = browser === 'all' ? ['chromium', 'webkit'] : [browser];
        await run(['bunx', 'playwright', 'install', ...browserNames], generated, { env });
        const browserProjects =
          browser === 'chromium'
            ? ['--project=chromium', '--project=mobile-chromium']
            : browser === 'webkit'
              ? ['--project=webkit']
              : [];
        await run(['bun', 'run', 'e2e', ...browserProjects], generated, { env });
      } finally {
        roles = [];
        await Promise.allSettled([api && stopProcessGroup(api), web && stopProcessGroup(web)]);
      }

      console.log(
        `Packed ${variant} starter ${mode}/${browser} lane passed with stitchkit ${installedVersion} (${mode === 'target' ? templateTarget : 'local HEAD'}) across DB, HTTP, OpenAPI, Socket.IO, MCP, CLI and its selected browser surface`,
      );
    } catch (error) {
      laneFailure = { error };
    }

    // Cleanup that is allowed to FAIL, and a `finally` that throws discards
    // whatever the lane was already failing on — the same shape, and the same
    // reason, as `supervised-lane.ts`. Disposing a database can fail on its
    // own (a full disk once made `pg_terminate_backend` return 1), and when it
    // does that is a fact worth reporting, not one worth reporting INSTEAD of
    // the check that actually broke.
    const cleanupFailures: unknown[] = [];
    for (const step of [() => githubFixture?.stop(true), () => database.dispose()]) {
      try {
        await step();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }

    const failures = [...(laneFailure ? [laneFailure.error] : []), ...cleanupFailures];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'The starter lane failed, and so did its cleanup');
    }
  }

  if (selectedVariant === 'blank') await runVariant();
  else await runVariant('repository');
} finally {
  await reapEverything();
  // Then everything else still living in this tree: a Prisma engine, a browser
  // a Playwright run left behind, a helper that outlived the command that
  // awaited it. Those are the lane's too — CI found one the role groups did not
  // cover, which is precisely what the assertion below is for.
  const swept = await reapProcessesUnder(workspace);
  if (swept > 0)
    console.log(`[starter-lane] reaped ${swept} process(es) left in its own tree`);
  // Fail-closed. A warning here reads as noise, and "probably fine" is what two
  // and a half hours of runs turned into a host that stopped responding.
  await assertNothingSurvives(workspace);
  await rm(workspace, { recursive: true, force: true });
}
