import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findNeutralIdentity } from './neutral-identity';
import { createStarterLaneDatabase } from './starter-database';
import { readStarterStitchkitTarget, writeStarterStitchkitTarget } from './starter-manifest';

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
const mode = Bun.argv.includes('--head') ? 'head' : 'target';

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
    [backend, 'await mcp.close()'],
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

const workspace = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
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
    for (const packagePath of [
      'packages/backend/package.json',
      'packages/frontend/package.json',
      'packages/shared/package.json',
    ]) {
      const fullPath = join(generated, packagePath);
      const source = await readFile(fullPath, 'utf8');
      if (!source.includes('"stitchkit": "catalog:"')) {
        throw new Error(`${variant} ${packagePath} does not reference the starter catalog`);
      }
    }

    if (coreTarball) {
      await writeStarterStitchkitTarget(generated, `file:${coreTarball}`);
      await assertGeneratedStarterSupportsHead(generated);
    }

    const database = await createStarterLaneDatabase(mode);
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
        `NEXT_PUBLIC_API_URL=${apiOrigin}`,
        `INTERNAL_API_URL=${apiOrigin}`,
        `NEXT_PUBLIC_WEB_URL=${webOrigin}`,
        `CORS_ORIGIN=${webOrigin}`,
        'LOG_FORMAT=json',
      ];
      if (example === 'repository') {
        environmentLines.push(
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
        NEXT_PUBLIC_API_URL: apiOrigin,
        INTERNAL_API_URL: apiOrigin,
        NEXT_PUBLIC_WEB_URL: webOrigin,
        CORS_ORIGIN: webOrigin,
        PLAYWRIGHT_BASE_URL: webOrigin,
        LOG_FORMAT: 'json',
        ...(example === 'repository' && {
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
      await run(['bun', 'run', 'build'], generated, { env });
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
        api = Bun.spawn(['bun', 'run', 'start:api'], {
          cwd: generated,
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        });
        web = Bun.spawn(['bun', 'run', 'start:web'], {
          cwd: generated,
          env,
          stdout: 'inherit',
          stderr: 'inherit',
        });
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

        await run(['bunx', 'playwright', 'install', 'chromium', 'webkit'], generated, { env });
        await run(['bun', 'run', 'e2e'], generated, { env });
      } finally {
        api?.kill('SIGTERM');
        web?.kill('SIGTERM');
        await Promise.allSettled([api?.exited, web?.exited]);
      }

      console.log(
        `Packed ${variant} starter ${mode} lane passed with stitchkit ${installedVersion} (${mode === 'target' ? templateTarget : 'local HEAD'}) across DB, HTTP, OpenAPI, Socket.IO, MCP, CLI, Chromium and WebKit`,
      );
    } finally {
      await database.dispose();
    }
  }

  await runVariant();
  await runVariant('repository');
} finally {
  await rm(workspace, { recursive: true, force: true });
}
