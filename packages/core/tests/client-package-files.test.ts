/**
 * Files a client package exports by subpath, and modules its build takes as other contents.
 *
 * A consuming project reads its client's version from `<pkg>/package.json` and a data profile
 * from `<pkg>/native-stream.json`, and its client imports the project manifest for one field. Each
 * is asserted on an installed archive, in Node and Bun and under both module resolutions, with a
 * control that shows the same consumer failing without the option.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildClientPackage } from '../src/files/client-package';
import { ClientPackageError } from '../src/files/client-package-contract';
import {
  clientPackageOptions,
  createClientProject,
  installConsumer,
  runTool,
  TSC,
  writeFiles,
  ZOD,
} from './support/client-package-fixture';
import { reapAfterEachTest } from './support/process-reaper';

reapAfterEachTest();

const NAME = '@example/control-client';
const PROFILE = { frames: 'ndjson', maxFrameBytes: 65_536 };
const temporary: string[] = [];
let project: string;

beforeAll(async () => {
  project = await createClientProject('extensionless');
  temporary.push(project);
  await writeFiles(project, {
    'native-stream.json': `${JSON.stringify(PROFILE)}\n`,
    // The project manifest a client imports for its version: what must not ship.
    'package.json': `${JSON.stringify({
      name: 'control-app',
      version: '7.3.1',
      scripts: { release: 'bun scripts/release.ts' },
      devDependencies: { typescript: '^7.0.2' },
    })}\n`,
    'tsconfig.version.json': `${JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { resolveJsonModule: true },
    })}\n`,
    'src/version/index.ts':
      "import pkg from '../../package.json' with { type: 'json' };\n" +
      'export const VERSION: string = pkg.version;\n',
  });
});

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

async function consumerOf(tarball: string): Promise<string> {
  const consumer = await installConsumer({ [NAME]: `file:${tarball}`, zod: `file:${ZOD}` });
  temporary.push(consumer);
  return consumer;
}

/** Reads both exported files by the package name, the way the consuming project does. */
const FILE_READER =
  `import pkg from '${NAME}/package.json' with { type: 'json' };\n` +
  `import profile from '${NAME}/native-stream.json' with { type: 'json' };\n` +
  'console.log(JSON.stringify({ version: pkg.version, profile }));\n';

const FILE_CONSUMER =
  `import pkg from '${NAME}/package.json' with { type: 'json' };\n` +
  `import profile from '${NAME}/native-stream.json' with { type: 'json' };\n` +
  'export const revision: string = pkg.version;\n' +
  'export const frameBytes: number = profile.maxFrameBytes;\n' +
  '// @ts-expect-error the profile is typed from the packed file, not `any`\n' +
  'export const wrong: string = profile.maxFrameBytes;\n';

async function typecheckFiles(consumer: string, resolution: 'bundler' | 'NodeNext') {
  await writeFile(join(consumer, 'use.ts'), FILE_CONSUMER);
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: 'ES2022',
        module: resolution === 'bundler' ? 'Preserve' : 'NodeNext',
        moduleResolution: resolution,
        resolveJsonModule: true,
        lib: ['ES2023', 'DOM'],
        types: [],
      },
      files: ['use.ts'],
    }),
  );
  return runTool(TSC, ['-p', 'tsconfig.json'], consumer);
}

describe('files a client package exports and modules its build replaces', () => {
  test('./package.json and a data file are imported by name in Node and Bun and typecheck under both resolutions', async () => {
    const proofSource = join(project, 'files-consumer.ts');
    await writeFile(proofSource, FILE_CONSUMER);
    const options = {
      ...clientPackageOptions(project),
      files: { 'native-stream.json': join(project, 'native-stream.json') },
    };
    const built = await buildClientPackage({
      ...options,
      exportedFiles: ['./package.json', './native-stream.json'],
      proof: { typecheck: [proofSource], exports: { './package.json': ['default'] } },
    });
    expect(built.proof.exportedFiles).toEqual(['./package.json', './native-stream.json']);
    expect(built.exports['./package.json']).toEqual(['default']);
    expect(built.exports['./native-stream.json']).toEqual(['default']);
    // Entries are still compared among themselves; the JSON defaults are no shared export.
    expect(built.sharedExports).toEqual(['ControlError', 'SessionSchema']);

    const consumer = await consumerOf(built.tarball);
    const installed = join(consumer, 'node_modules', NAME);
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    expect(manifest.exports['./package.json']).toBe('./package.json');
    expect(manifest.exports['./native-stream.json']).toBe('./native-stream.json');
    await writeFile(join(consumer, 'read.mjs'), FILE_READER);
    for (const runtime of ['node', 'bun']) {
      const ran = await runTool(runtime, ['read.mjs'], consumer);
      expect(ran.exitCode).toBe(0);
      expect(JSON.parse(ran.output)).toEqual({ version: '1.4.0', profile: PROFILE });
    }
    for (const resolution of ['bundler', 'NodeNext'] as const) {
      expect(await typecheckFiles(consumer, resolution)).toEqual({ exitCode: 0, output: '' });
    }

    // The control: the same package without `exportedFiles` packs the data file, but neither
    // runtime nor compiler reaches either file by name.
    const plain = await consumerOf((await buildClientPackage(options)).tarball);
    await writeFile(join(plain, 'read.mjs'), FILE_READER);
    for (const runtime of ['node', 'bun']) {
      const ran = await runTool(runtime, ['read.mjs'], plain);
      expect(ran.exitCode).not.toBe(0);
    }
    expect(
      await readFile(join(plain, 'node_modules', NAME, 'native-stream.json'), 'utf8'),
    ).toBe(`${JSON.stringify(PROFILE)}\n`);
    for (const resolution of ['bundler', 'NodeNext'] as const) {
      const unresolved = await typecheckFiles(plain, resolution);
      expect(unresolved.exitCode).not.toBe(0);
      expect(unresolved.output).toContain('TS2307');
    }
  }, 120_000);

  test('an exported file that is neither the manifest nor a packed file, or a subpath named twice, is a caller mistake', async () => {
    const options = clientPackageOptions(project);
    await expect(
      buildClientPackage({ ...options, exportedFiles: ['./native-stream.json'] }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      buildClientPackage({
        ...options,
        files: { monitoring: join(project, 'native-stream.json') },
        exportedFiles: ['./monitoring'],
      }),
    ).rejects.toThrow('exported twice');
    await expect(
      buildClientPackage({ ...options, exportedFiles: ['./package.json', './package.json'] }),
    ).rejects.toThrow('exported twice');
  });

  test('a replaced project manifest ships one field, and the unreplaced one ships its scripts', async () => {
    const options = {
      ...clientPackageOptions(project),
      entries: { '.': join(project, 'src/version/index.ts') },
      tsconfig: join(project, 'tsconfig.version.json'),
      peerDependencies: {},
    };
    const shipped = async (tarball: string) => {
      const consumer = await consumerOf(tarball);
      await writeFile(
        join(consumer, 'version.mjs'),
        `import { VERSION } from '${NAME}';\nconsole.log(VERSION);\n`,
      );
      const ran = await runTool('node', ['version.mjs'], consumer);
      expect(ran).toEqual({ exitCode: 0, output: '7.3.1' });
      return consumer;
    };
    const javascriptOf = async (built: Awaited<ReturnType<typeof buildClientPackage>>) => {
      const consumer = await shipped(built.tarball);
      const files = built.files.filter((file) => file.path.endsWith('.js'));
      return (
        await Promise.all(
          files.map((file) =>
            readFile(join(consumer, 'node_modules', NAME, file.path), 'utf8'),
          ),
        )
      ).join('\n');
    };

    const replaced = await buildClientPackage({
      ...options,
      replaceModules: {
        [join(project, 'package.json')]: JSON.stringify({ version: '7.3.1' }),
      },
    });
    expect(replaced.modules).toContain(join(project, 'package.json'));
    const lean = await javascriptOf(replaced);
    expect(lean).toContain('7.3.1');
    expect(lean).not.toContain('devDependencies');
    expect(lean).not.toContain('"scripts"');
    expect(lean).not.toMatch(/\bscripts\b/);

    // The control: built from the file itself, the same entry ships the whole manifest.
    const whole = await javascriptOf(await buildClientPackage(options));
    expect(whole).toContain('devDependencies');
    expect(whole).toMatch(/\bscripts\b/);
  }, 120_000);

  test('a replacement no bundled module imports is refused, and one that is no module file is a caller mistake', async () => {
    const refusal = await buildClientPackage({
      ...clientPackageOptions(project),
      replaceModules: { [join(project, 'package.json')]: '{"version":"7.3.1"}' },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ClientPackageError);
    expect(refusal).toMatchObject({
      reason: 'replacement-unused',
      details: { module: join(project, 'package.json') },
    });
    await expect(
      buildClientPackage({
        ...clientPackageOptions(project),
        replaceModules: { [join(project, 'missing.json')]: '{}' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      buildClientPackage({
        ...clientPackageOptions(project),
        replaceModules: { [join(project, 'tsconfig.json').replace('.json', '.md')]: '' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  }, 120_000);
});
