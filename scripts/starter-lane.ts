import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStarterLaneDatabase } from './starter-database';
import { readStarterStitchkitTarget, writeStarterStitchkitTarget } from './starter-manifest';

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

async function rewriteJsonPackage(
  packagePath: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  mutate(manifest);
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function prepareGeneratedStarterForHead(generatedRoot: string): Promise<void> {
  await rewriteJsonPackage(join(generatedRoot, 'package.json'), (manifest) => {
    const devDependencies = manifest.devDependencies;
    if (!devDependencies || typeof devDependencies !== 'object') {
      throw new Error('Generated starter root devDependencies are missing');
    }
    Reflect.deleteProperty(devDependencies, '@modelcontextprotocol/sdk');
    Reflect.set(devDependencies, '@modelcontextprotocol/client', '^2.0.0');
  });
  await rewriteJsonPackage(
    join(generatedRoot, 'packages/backend/package.json'),
    (manifest) => {
      const dependencies = manifest.dependencies;
      if (!dependencies || typeof dependencies !== 'object') {
        throw new Error('Generated starter backend dependencies are missing');
      }
      Reflect.deleteProperty(dependencies, '@modelcontextprotocol/sdk');
      Reflect.set(dependencies, '@modelcontextprotocol/server', '^2.0.0');
    },
  );

  const backendPath = join(generatedRoot, 'packages/backend/src/index.ts');
  const backend = await readFile(backendPath, 'utf8');
  const updatedBackend = backend
    .replace(
      "import { createMcpHandler } from 'stitchkit/tools';",
      "import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools';",
    )
    .replace(
      "{ method: 'ALL', path: '/mcp', handler: (req) => mcp(req) },",
      "createMcpHttpRoute({ path: '/mcp', handler: mcp }),",
    )
    .replace(
      '    await socket.io.close();',
      '    await mcp.close();\n    await socket.io.close();',
    );
  if (updatedBackend === backend || updatedBackend.includes('mcp(req)')) {
    throw new Error('Generated starter MCP backend migration did not apply cleanly');
  }
  await writeFile(backendPath, updatedBackend);

  const smokePath = join(generatedRoot, 'scripts/runtime-smoke.ts');
  const smoke = await readFile(smokePath, 'utf8');
  const updatedSmoke = smoke
    .replace(
      "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nimport { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
      "import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
    )
    .replace(
      "const client = new Client({ name: 'starter-lane', version: '1.0.0' });",
      "const client = new Client(\n    { name: 'starter-lane', version: '1.0.0' },\n    { versionNegotiation: { mode: { pin: '2026-07-28' } } },\n  );",
    );
  if (updatedSmoke === smoke || updatedSmoke.includes('@modelcontextprotocol/sdk')) {
    throw new Error('Generated starter MCP client migration did not apply cleanly');
  }
  await writeFile(smokePath, updatedSmoke);
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

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
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
const packed = join(workspace, 'packed');
const runner = join(workspace, 'runner');
const generated = join(workspace, 'generated-app');
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
]) {
  if (packedScaffolderFiles.includes(forbiddenPath)) {
    throw new Error(`Published scaffolder contains runtime artifact: ${forbiddenPath}`);
  }
}

await writeFile(
  join(runner, 'package.json'),
  JSON.stringify({
    private: true,
    dependencies: { 'create-stitchkit': `file:${createTarball}` },
  }),
);
await run(['bun', 'install'], runner);
await run(
  [join(runner, 'node_modules/.bin/create-stitchkit'), generated, '--no-install'],
  runner,
);

const generatedTarget = await readStarterStitchkitTarget(generated);
if (generatedTarget !== templateTarget) {
  throw new Error(
    `Generated starter target drifted: template=${templateTarget}, generated=${generatedTarget}`,
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
    throw new Error(`${packagePath} does not reference the starter catalog`);
  }
}

let expectedVersion: string | undefined;
if (mode === 'head') {
  expectedVersion = await packageVersion(corePackage);
  const coreTarball = join(packed, 'stitchkit.tgz');
  await run(
    ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', coreTarball],
    join(repositoryRoot, 'packages/core'),
  );
  await writeStarterStitchkitTarget(generated, `file:${coreTarball}`);
  await prepareGeneratedStarterForHead(generated);
}

const database = await createStarterLaneDatabase(mode);
try {
  const webPort = freePort();
  const apiPort = freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  await writeFile(
    join(generated, '.env'),
    [
      'NODE_ENV=production',
      `DATABASE_URL=${database.url}`,
      `API_PORT=${apiPort}`,
      `WEB_PORT=${webPort}`,
      `NEXT_PUBLIC_API_URL=${apiOrigin}`,
      `INTERNAL_API_URL=${apiOrigin}`,
      `NEXT_PUBLIC_WEB_URL=${webOrigin}`,
      'LOG_FORMAT=json',
      'GITHUB_REPOSITORY=max-listov/stitchkit',
      'GITHUB_CACHE_TTL_SECONDS=900',
      '',
    ].join('\n'),
  );

  const env = {
    ...Bun.env,
    NODE_ENV: 'production',
    DATABASE_URL: database.url,
    API_PORT: String(apiPort),
    WEB_PORT: String(webPort),
    NEXT_PUBLIC_API_URL: apiOrigin,
    INTERNAL_API_URL: apiOrigin,
    NEXT_PUBLIC_WEB_URL: webOrigin,
    PLAYWRIGHT_BASE_URL: webOrigin,
    LOG_FORMAT: 'json',
    GITHUB_REPOSITORY: 'max-listov/stitchkit',
    GITHUB_CACHE_TTL_SECONDS: '900',
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
    await Promise.all([waitFor(`${apiOrigin}/health`), waitFor(`${webOrigin}/en`)]);
    await run(['bun', 'run', 'runtime:smoke'], generated, { env });

    const tools = JSON.parse(await capture(['bun', 'run', 'tools'], generated, env));
    if (!tools.manifest || !tools.names) throw new Error('Tool manifest output is incomplete');
    const cli = await capture(['bun', 'run', 'cli', '--', 'repository_read'], generated, env);
    JSON.parse(cli);

    await run(['bunx', 'playwright', 'install', 'chromium', 'webkit'], generated, { env });
    await run(['bun', 'run', 'e2e'], generated, { env });
  } finally {
    api?.kill('SIGTERM');
    web?.kill('SIGTERM');
    await Promise.allSettled([api?.exited, web?.exited]);
  }

  console.log(
    `Packed starter ${mode} lane passed with stitchkit ${installedVersion} (${mode === 'target' ? templateTarget : 'local HEAD'}) across DB, HTTP, OpenAPI, Socket.IO, MCP, CLI, Chromium and WebKit`,
  );
} finally {
  await database.dispose();
}
