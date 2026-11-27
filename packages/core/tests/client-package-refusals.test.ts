import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ForbiddenModuleError } from '../src/files/client-build';
import { buildClientPackage } from '../src/files/client-package';
import { ClientPackageError } from '../src/files/client-package-contract';
import {
  clientPackageOptions,
  createClientProject,
  installConsumer,
  writeFiles,
  ZOD,
} from './support/client-package-fixture';
import { reapAfterEachTest } from './support/process-reaper';

reapAfterEachTest();

const NAME = '@example/control-client';
const temporary: string[] = [];
let project: string;
let tarball: string;

beforeAll(async () => {
  project = await createClientProject('extensionless');
  temporary.push(project);
  tarball = join(project, 'dist/example-control-client-1.4.0.tgz');
});

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

/** One entry, so a test states only the module it is about. */
function single(entry: string) {
  return { ...clientPackageOptions(project), entries: { '.': join(project, entry) } };
}

async function refusalOf(build: Promise<unknown>): Promise<ClientPackageError> {
  const refusal = await build.catch((error: unknown) => error);
  if (!(refusal instanceof ClientPackageError)) {
    throw new Error(`expected a ClientPackageError, got ${String(refusal)}`);
  }
  return refusal;
}

describe('what a client package refuses', () => {
  test('a forbidden module in the graph is refused by name and leaves no archive', async () => {
    await writeFiles(project, {
      'src/terminal/panes.ts': 'export const panes = () => [];\n',
      'src/client/leaking.ts':
        "import { panes } from '../terminal/panes';\nexport const createClient = () => panes();\n",
      'src/client/locale.ts':
        "import { locales } from 'zod/v4';\nexport const localeCount = () => Object.keys(locales).length;\n",
    });
    // The controls: each entry builds while nothing is forbidden, and leaves its archive.
    await buildClientPackage(single('src/client/locale.ts'));
    await buildClientPackage(single('src/client/leaking.ts'));
    expect(existsSync(tarball)).toBe(true);

    const bundled = await buildClientPackage({
      ...single('src/client/leaking.ts'),
      forbiddenModules: ['src/terminal/'],
    }).catch((error: unknown) => error);
    expect(bundled).toBeInstanceOf(ForbiddenModuleError);
    if (!(bundled instanceof ForbiddenModuleError)) return;
    expect(bundled.module).toEndWith('src/terminal/panes.ts');
    expect(bundled.importedBy).toEndWith('src/client/leaking.ts');
    expect(bundled.message).toContain('src/terminal/panes.ts');
    expect(existsSync(tarball)).toBe(false);

    // A subpath of a peer is not in the output at all; the import that names it is still refused.
    const external = await buildClientPackage({
      ...single('src/client/locale.ts'),
      forbiddenModules: ['zod/v4'],
    }).catch((error: unknown) => error);
    expect(external).toBeInstanceOf(ForbiddenModuleError);
    if (!(external instanceof ForbiddenModuleError)) return;
    expect(external.module).toBe('zod/v4');
    expect(external.importedBy).toEndWith('src/client/locale.ts');
    // A rule names a subpath exactly: the peer's other subpaths stay allowed.
    await expect(
      buildClientPackage({ ...single('src/client/locale.ts'), forbiddenModules: ['zod/v3'] }),
    ).resolves.toMatchObject({ tarball });
  }, 120_000);

  test('a declaration that needs an undeclared package is refused', async () => {
    await writeFiles(project, {
      'node_modules/@example/shapes/package.json': JSON.stringify({
        name: '@example/shapes',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'node_modules/@example/shapes/index.js': 'export const unit = { sides: 4 };\n',
      'node_modules/@example/shapes/index.d.ts':
        'export interface Shape { sides: number }\nexport declare const unit: Shape;\n',
      'src/client/shapes.ts':
        "import { type Shape, unit } from '@example/shapes';\n" +
        'export const describeShape = (shape: Shape = unit): Shape => shape;\n',
    });
    const refusal = await refusalOf(buildClientPackage(single('src/client/shapes.ts')));
    expect(refusal.reason).toBe('declaration-dependency');
    expect(refusal.details).toEqual({
      file: 'src/client/shapes.d.ts',
      specifier: '@example/shapes',
      package: '@example/shapes',
    });
    expect(existsSync(tarball)).toBe(false);

    // Declared as a dependency, it is left outside the output, installed with the client and proven.
    const built = await buildClientPackage({
      ...single('src/client/shapes.ts'),
      dependencies: { '@example/shapes': '^1.0.0' },
      proof: { exports: { '.': ['describeShape'] } },
    });
    expect(built.modules.some((module) => module.includes('@example/shapes'))).toBe(false);
    expect(built.proof.externals).toMatchObject({ '@example/shapes': '1.0.0' });
    const consumer = await installConsumer(
      { [NAME]: `file:${built.tarball}`, zod: `file:${ZOD}` },
      { '@example/shapes': `file:${join(project, 'node_modules/@example/shapes')}` },
    );
    temporary.push(consumer);
    const installed = join(consumer, 'node_modules', NAME);
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ '@example/shapes': '^1.0.0' });
    for (const file of built.files.filter((entry) => entry.path.endsWith('.js'))) {
      const text = await readFile(join(installed, file.path), 'utf8');
      expect(text).toContain('from "@example/shapes"');
      expect(text).not.toContain('sides');
    }
  }, 120_000);

  test('a tsconfig path alias in a public declaration is refused as an undeclared package', async () => {
    await writeFiles(project, {
      'tsconfig.alias.json': JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }),
      'src/client/aliased.ts': "export { type Session, SessionSchema } from '@/schema';\n",
    });
    // The bundler and the compiler both follow the alias; a consumer has no such mapping.
    const refusal = await refusalOf(
      buildClientPackage({
        ...single('src/client/aliased.ts'),
        tsconfig: join(project, 'tsconfig.alias.json'),
      }),
    );
    expect(refusal.reason).toBe('declaration-dependency');
    expect(refusal.details).toMatchObject({
      file: 'src/client/aliased.d.ts',
      specifier: '@/schema',
    });
  }, 120_000);

  test('a declaration that names a module the package does not declare is refused', async () => {
    await writeFiles(project, {
      // A hand-written declaration: the compiler types against it and does not emit it.
      'src/legacy.d.ts': 'export interface Legacy { old: true }\n',
      'src/client/legacy.ts':
        "import type { Legacy } from '../legacy';\nexport const keep = (value: Legacy): Legacy => value;\n",
    });
    const refusal = await refusalOf(buildClientPackage(single('src/client/legacy.ts')));
    expect(refusal.reason).toBe('declaration-unresolved');
    expect(refusal.details).toEqual({
      file: 'src/client/legacy.d.ts',
      specifier: '../legacy',
    });
  }, 120_000);

  test('a type error in the client graph fails the declarations, one outside it does not', async () => {
    await writeFiles(project, {
      'src/client/broken.ts': "export const limit: number = 'ten';\n",
    });
    const refusal = await refusalOf(buildClientPackage(single('src/client/broken.ts')));
    expect(refusal.reason).toBe('declarations');
    expect(String(refusal.details.output)).toContain('TS2322');
    // `src/server.ts` of the fixture has the same error and is in the tsconfig's `include`.
    await expect(buildClientPackage(clientPackageOptions(project))).resolves.toMatchObject({
      tarball,
    });
  }, 120_000);

  test('code of a peer reached by path is refused as a bundled peer', async () => {
    await writeFiles(project, {
      'packages/kit/package.json': JSON.stringify({
        name: '@example/kit',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './index.d.ts', default: './index.js' } },
      }),
      'packages/kit/index.js': "export const kit = 'kit';\n",
      'packages/kit/index.d.ts': 'export declare const kit: string;\n',
      'src/client/by-name.ts':
        "import { kit } from '@example/kit';\nexport const useKit = () => kit;\n",
      'src/client/by-path.ts':
        "import { kit } from '../../packages/kit/index.js';\nexport const useKit = () => kit;\n",
    });
    // A workspace neighbour: linked into node_modules, living outside it.
    await mkdir(join(project, 'node_modules/@example'), { recursive: true });
    await symlink(join(project, 'packages/kit'), join(project, 'node_modules/@example/kit'));
    const peers = { peerDependencies: { '@example/kit': '^1.0.0' } };

    const built = await buildClientPackage({ ...single('src/client/by-name.ts'), ...peers });
    expect(built.modules.some((module) => module.includes('packages/kit'))).toBe(false);

    const refusal = await refusalOf(
      buildClientPackage({ ...single('src/client/by-path.ts'), ...peers }),
    );
    expect(refusal.reason).toBe('bundled-peer');
    expect(refusal.details.package).toBe('@example/kit');
    expect(String(refusal.details.module)).toEndWith('packages/kit/index.js');
    expect(existsSync(tarball)).toBe(false);
  }, 120_000);

  test('a peer range the installed version does not satisfy is refused', async () => {
    const refusal = await refusalOf(
      buildClientPackage({
        ...clientPackageOptions(project),
        peerDependencies: { zod: '^3.0.0' },
      }),
    );
    expect(refusal.reason).toBe('peer-range');
    expect(refusal.details).toMatchObject({ package: 'zod', range: '^3.0.0' });
    expect(String(refusal.details.installed)).toMatch(/^4\./);
    expect(existsSync(tarball)).toBe(false);

    const absent = await refusalOf(
      buildClientPackage({
        ...clientPackageOptions(project),
        peerDependencies: { zod: '^4.0.0', 'not-installed-here': '^1.0.0' },
      }),
    );
    expect(absent).toMatchObject({
      reason: 'install',
      details: { package: 'not-installed-here' },
    });
  }, 120_000);

  test('manifest fields and extra files are packed, and a field the package owns is refused', async () => {
    await writeFile(join(project, 'CLIENT.md'), '# Control client\n');
    const options = {
      ...clientPackageOptions(project),
      manifest: { description: 'Control client', license: 'MIT', sideEffects: false },
      files: { 'docs/CLIENT.md': join(project, 'CLIENT.md') },
    };
    const built = await buildClientPackage(options);
    const consumer = await installConsumer({
      [NAME]: `file:${built.tarball}`,
      zod: `file:${ZOD}`,
    });
    temporary.push(consumer);
    const installed = join(consumer, 'node_modules', NAME);
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: NAME,
      version: '1.4.0',
      description: 'Control client',
      license: 'MIT',
      sideEffects: false,
      type: 'module',
      exports: {
        '.': { types: './dist/src/client/index.d.ts', import: './dist/src/client/index.js' },
        './monitoring': {
          types: './dist/src/client/monitoring.d.ts',
          import: './dist/src/client/monitoring.js',
        },
      },
    });
    expect(await readFile(join(installed, 'docs/CLIENT.md'), 'utf8')).toBe(
      '# Control client\n',
    );
    expect(built.files.map((file) => file.path)).toContain('docs/CLIENT.md');

    for (const field of ['exports', 'peerDependencies', 'version']) {
      const refusal = await refusalOf(
        buildClientPackage({ ...options, manifest: { ...options.manifest, [field]: {} } }),
      );
      expect(refusal).toMatchObject({ reason: 'manifest-owned-field', details: { field } });
    }
    await expect(
      buildClientPackage({
        ...options,
        files: { '../outside.md': join(project, 'CLIENT.md') },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  }, 120_000);

  test('runtime selects the platform the package is built for and where it is proven', async () => {
    await writeFiles(project, {
      // The fixture project installs no Bun types; this stands in for them.
      'src/bun-sqlite.d.ts': "declare module 'bun:sqlite' {\n  export class Database {}\n}\n",
      'src/client/store.ts':
        '/// <reference path="../bun-sqlite.d.ts" />\n' +
        "import { Database } from 'bun:sqlite';\nexport const storeName = (): string => Database.name;\n",
    });
    const options = { ...single('src/client/store.ts'), peerDependencies: {} };
    const built = await buildClientPackage({ ...options, runtime: 'bun' });
    expect(built.proof.runtimes).toEqual(['bun']);
    const refusal = await refusalOf(buildClientPackage({ ...options, runtime: 'browser' }));
    expect(refusal.reason).toBe('build');
    expect(String(refusal.details.output)).toContain('bun:sqlite');
  }, 120_000);

  test('executables, timeoutMs and signal bound every tool of the package build', async () => {
    const options = clientPackageOptions(project);
    await expect(
      buildClientPackage({ ...options, executables: { bun: join(project, 'no-such-bun') } }),
    ).rejects.toThrow();

    // Stand-ins that fail by name: each tool is the one the build actually ran.
    const failing = async (name: string): Promise<string> => {
      const path = join(project, name);
      await writeFile(path, `#!/bin/sh\necho "stand-in ${name}" >&2\nexit 3\n`);
      await chmod(path, 0o755);
      return path;
    };
    const compiler = await refusalOf(
      buildClientPackage({ ...options, executables: { tsc: await failing('fake-tsc') } }),
    );
    expect(compiler.reason).toBe('declarations');
    expect(String(compiler.details.output)).toContain('stand-in fake-tsc');
    const runtime = await refusalOf(
      buildClientPackage({ ...options, executables: { node: await failing('fake-node') } }),
    );
    expect(runtime).toMatchObject({ reason: 'install', details: { runtime: 'node' } });
    expect(String(runtime.details.output)).toContain('stand-in fake-node');

    // A stand-in that never finishes: the deadline and the caller end it.
    const slow = join(project, 'slow-bun');
    await writeFile(slow, '#!/bin/sh\nexec sleep 30\n');
    await chmod(slow, 0o755);
    const startedAt = performance.now();
    await expect(
      buildClientPackage({ ...options, executables: { bun: slow }, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      buildClientPackage({
        ...options,
        executables: { bun: slow },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(existsSync(tarball)).toBe(false);
  }, 120_000);
});
