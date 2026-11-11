import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClientArtifact, ForbiddenModuleError } from '../src/files/client-artifact';

let project: string;

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'sk-client-artifact-'));
  await mkdir(join(project, 'src/terminal'), { recursive: true });
  await writeFile(
    join(project, 'src/shared.ts'),
    "export const describeRecord = (name: string) => 'record ' + name;\n",
  );
  await writeFile(
    join(project, 'src/client.ts'),
    "import { describeRecord } from './shared';\n" +
      'export const createApiClient = () => ({ lookup: describeRecord });\n' +
      "export const CLIENT_VERSION = '1.2.3';\n",
  );
  await writeFile(join(project, 'src/terminal/panes.ts'), 'export const panes = () => [];\n');
  await writeFile(
    join(project, 'src/leaking-client.ts'),
    "import { panes } from './terminal/panes';\nexport const createApiClient = () => panes();\n",
  );
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('a client built into one self-contained file', () => {
  test('one call gives the file, its hash and an archive that installs and imports', async () => {
    const artifact = await buildClientArtifact({
      entry: join(project, 'src/client.ts'),
      outFile: join(project, 'dist/api-client.js'),
      forbiddenModules: ['src/terminal/', 'ink'],
      package: {
        name: '@example/api-client',
        version: '1.2.3',
        outDir: join(project, 'dist'),
        exports: ['createApiClient', 'CLIENT_VERSION'],
      },
    });
    const bytes = await readFile(artifact.file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(artifact.sha256).toBe(digest);
    expect(artifact.bytes).toBe(bytes.byteLength);
    expect(await readFile(artifact.sha256File, 'utf8')).toBe(`${digest}  api-client.js\n`);
    expect(artifact.modules.some((module) => module.endsWith('shared.ts'))).toBe(true);
    // Self-contained: the local module was bundled, not left as an import.
    expect(bytes.toString('utf8')).not.toContain("from './shared'");
    // The file is importable on its own, from where it lies.
    const loaded = await import(artifact.file);
    expect(loaded.createApiClient().lookup('main')).toBe('record main');

    expect(artifact.package?.tarball).toBe(join(project, 'dist/example-api-client-1.2.3.tgz'));
    const tarball = await readFile(artifact.package?.tarball ?? '');
    expect(artifact.package?.sha256).toBe(createHash('sha256').update(tarball).digest('hex'));
  }, 120_000);

  test('an export the installed archive lacks fails the build', async () => {
    await expect(
      buildClientArtifact({
        entry: join(project, 'src/client.ts'),
        outFile: join(project, 'dist/checked.js'),
        package: {
          name: 'api-client',
          version: '1.0.0',
          outDir: join(project, 'dist'),
          exports: ['createApiClient', 'doesNotExist'],
        },
      }),
    ).rejects.toThrow('missing exports: doesNotExist');
  }, 120_000);

  test('a forbidden module in the graph is refused by name and leaves no file', async () => {
    const outFile = join(project, 'dist/leaking.js');
    const options = { entry: join(project, 'src/leaking-client.ts'), outFile };
    // The control: the same entry builds when nothing is forbidden.
    await buildClientArtifact(options);
    expect(existsSync(outFile)).toBe(true);

    const refusal = await buildClientArtifact({
      ...options,
      forbiddenModules: ['src/terminal/'],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ForbiddenModuleError);
    if (!(refusal instanceof ForbiddenModuleError)) return;
    expect(refusal.module).toEndWith('src/terminal/panes.ts');
    expect(refusal.importedBy).toEndWith('src/leaking-client.ts');
    expect(refusal.message).toContain('src/terminal/panes.ts');
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(`${outFile}.sha256`)).toBe(false);

    const byPattern = await buildClientArtifact({
      ...options,
      forbiddenModules: [/panes\.ts$/],
    }).catch((error: unknown) => error);
    expect(byPattern).toBeInstanceOf(ForbiddenModuleError);
  }, 120_000);

  test('a linked package is refused by the name that imports it', async () => {
    // A workspace or linked dependency resolves to a real path outside node_modules.
    await mkdir(join(project, 'packages/terminal-ui'), { recursive: true });
    await writeFile(
      join(project, 'packages/terminal-ui/package.json'),
      '{"name":"@example/terminal-ui","version":"1.0.0","type":"module","main":"index.js"}\n',
    );
    await writeFile(
      join(project, 'packages/terminal-ui/index.js'),
      'export const draw = () => 1;\n',
    );
    await mkdir(join(project, 'node_modules/@example'), { recursive: true });
    await symlink(
      join(project, 'packages/terminal-ui'),
      join(project, 'node_modules/@example/terminal-ui'),
    );
    await writeFile(
      join(project, 'src/linked-client.ts'),
      "import { draw } from '@example/terminal-ui';\nexport const createApiClient = () => draw();\n",
    );
    const options = {
      entry: join(project, 'src/linked-client.ts'),
      outFile: join(project, 'dist/linked.js'),
    };
    const built = await buildClientArtifact(options);
    // The control: the bundler reports the real path, which no `node_modules` rule would match.
    expect(built.modules.some((module) => module.includes('/node_modules/'))).toBe(false);
    const refusal = await buildClientArtifact({
      ...options,
      forbiddenModules: ['@example/terminal-ui'],
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ForbiddenModuleError);
    if (!(refusal instanceof ForbiddenModuleError)) return;
    expect(refusal.importedBy).toEndWith('src/linked-client.ts');
    // A bare name does not refuse a source file that merely contains it.
    await expect(
      buildClientArtifact({ ...options, forbiddenModules: ['client', 'terminal'] }),
    ).resolves.toMatchObject({ file: options.outFile });
  }, 120_000);

  test('an archive that fails its proof leaves no file behind', async () => {
    const outFile = join(project, 'dist/unproven.js');
    await expect(
      buildClientArtifact({
        entry: join(project, 'src/client.ts'),
        outFile,
        package: {
          name: 'api-client',
          version: '1.0.0',
          outDir: join(project, 'dist'),
          exports: ['nope'],
        },
      }),
    ).rejects.toThrow('missing exports: nope');
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(`${outFile}.sha256`)).toBe(false);
  }, 120_000);

  test('runtime selects what the file may import from its platform', async () => {
    await writeFile(
      join(project, 'src/bun-client.ts'),
      "import { Database } from 'bun:sqlite';\nexport const createApiClient = () => Database.name;\n",
    );
    const options = {
      entry: join(project, 'src/bun-client.ts'),
      outFile: join(project, 'dist/bun-client.js'),
    };
    await expect(buildClientArtifact({ ...options, runtime: 'bun' })).resolves.toMatchObject({
      file: options.outFile,
    });
    await expect(buildClientArtifact({ ...options, runtime: 'browser' })).rejects.toThrow(
      'Client artifact build failed',
    );
  }, 120_000);

  test('executable, timeoutMs and signal bound the build tool', async () => {
    const options = {
      entry: join(project, 'src/client.ts'),
      outFile: join(project, 'dist/bounded.js'),
    };
    await expect(
      buildClientArtifact({ ...options, executable: join(project, 'no-such-bun') }),
    ).rejects.toThrow();
    // A stand-in tool that never finishes: the deadline and the caller end it.
    const slow = join(project, 'slow-bun');
    await writeFile(slow, '#!/bin/sh\nexec sleep 30\n');
    await chmod(slow, 0o755);
    const startedAt = performance.now();
    await expect(
      buildClientArtifact({ ...options, executable: slow, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      buildClientArtifact({ ...options, executable: slow, signal: controller.signal }),
    ).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(existsSync(options.outFile)).toBe(false);
  }, 60_000);
});
