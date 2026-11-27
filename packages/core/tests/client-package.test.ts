import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildClientArtifact } from '../src/files/client-artifact';
import { buildClientPackage } from '../src/files/client-package';
import { ClientPackageError } from '../src/files/client-package-contract';
import { declarationSpecifiers } from '../src/files/declaration-specifiers';
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
const temporary: string[] = [];
let project: string;

beforeAll(async () => {
  project = await createClientProject('extensionless');
  temporary.push(project);
});

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

/** A consumer of the test's own: the archive and its peer, nothing else. */
async function consumerOf(tarball: string): Promise<string> {
  const consumer = await installConsumer({ [NAME]: `file:${tarball}`, zod: `file:${ZOD}` });
  temporary.push(consumer);
  return consumer;
}

/** Whether a schema and an error class are one object across two modules, in one runtime. */
async function sharedIdentity(runtime: string, cwd: string, first: string, second: string) {
  await writeFile(
    join(cwd, 'identity.mjs'),
    `import * as first from ${JSON.stringify(first)};\n` +
      `import * as second from ${JSON.stringify(second)};\n` +
      'console.log(JSON.stringify({\n' +
      '  schema: first.SessionSchema === second.SessionSchema,\n' +
      '  error: new first.ControlError() instanceof second.ControlError,\n' +
      '}));\n',
  );
  const ran = await runTool(runtime, ['identity.mjs'], cwd);
  expect(ran.exitCode).toBe(0);
  return JSON.parse(ran.output);
}

async function declarationsOf(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.d.ts'))
      files.push(join(entry.parentPath, entry.name));
  }
  return files.sort();
}

const STRICT_CONSUMER =
  `import { SessionSchema, type Session } from '${NAME}';\n` +
  `import { readSessions } from '${NAME}/monitoring';\n` +
  "const session: Session = SessionSchema.parse({ id: 'a', state: 'idle' });\n" +
  'const list: Session[] = readSessions([session]);\n' +
  '// @ts-expect-error state is a closed enum: an unresolved declaration would make it `any`\n' +
  "const bad: Session = { id: 'a', state: 'nope' };\n" +
  'export { bad, list };\n';

/** The test's own strict consumer typecheck, under one module resolution. */
async function typecheck(consumer: string, resolution: 'bundler' | 'NodeNext') {
  await writeFile(join(consumer, 'use.ts'), STRICT_CONSUMER);
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
        lib: ['ES2023', 'DOM'],
        types: [],
      },
      files: ['use.ts'],
    }),
  );
  return runTool(TSC, ['-p', 'tsconfig.json'], consumer);
}

describe('a typed client built into an npm package', () => {
  test('two entries share one module graph in Node and Bun', async () => {
    const built = await buildClientPackage(clientPackageOptions(project));
    expect(built.tarball).toBe(join(project, 'dist/example-control-client-1.4.0.tgz'));
    const archive = await readFile(built.tarball);
    expect(built.sha256).toBe(createHash('sha256').update(archive).digest('hex'));
    expect(built.bytes).toBe(archive.byteLength);
    expect(built.sharedExports).toEqual(['ControlError', 'SessionSchema']);
    expect(built.exports['./monitoring']).toEqual([
      'ControlError',
      'SessionSchema',
      'readSessions',
    ]);
    expect(built.proof.runtimes).toEqual(['node', 'bun']);

    const consumer = await consumerOf(built.tarball);
    for (const runtime of ['node', 'bun']) {
      expect(await sharedIdentity(runtime, consumer, NAME, `${NAME}/monitoring`)).toEqual({
        schema: true,
        error: true,
      });
    }

    // The control: the same two entries built separately are two module graphs, and the same
    // comparison says so. This is the defect one build over all entries prevents.
    const separate = await Promise.all(
      ['index', 'monitoring'].map((entry) =>
        buildClientArtifact({
          entry: join(project, `src/client/${entry}.ts`),
          outFile: join(project, `dist/separate/${entry}.js`),
        }),
      ),
    );
    for (const runtime of ['node', 'bun']) {
      expect(
        await sharedIdentity(
          runtime,
          join(project, 'dist/separate'),
          separate[0]?.file ?? '',
          separate[1]?.file ?? '',
        ),
      ).toEqual({ schema: false, error: false });
    }
  }, 120_000);

  test('an export that differs between entries is refused by name', async () => {
    await writeFiles(project, {
      'src/split/index.ts':
        "export const createClient = () => 'root';\nexport const shared = 1;\n",
      'src/split/admin.ts':
        "export const createClient = () => 'admin';\nexport const shared = 1;\n",
    });
    const options = {
      ...clientPackageOptions(project),
      entries: {
        '.': join(project, 'src/split/index.ts'),
        './admin': join(project, 'src/split/admin.ts'),
      },
      peerDependencies: {},
    };
    const refusal = await buildClientPackage(options).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ClientPackageError);
    if (!(refusal instanceof ClientPackageError)) return;
    expect(refusal.reason).toBe('shared-export-split');
    expect(refusal.details.names).toEqual(['createClient']);
    expect(existsSync(join(project, 'dist/example-control-client-1.4.0.tgz'))).toBe(false);

    // Declared as deliberately different, the same package is built; `shared` is still proven one value.
    const built = await buildClientPackage({
      ...options,
      proof: { distinctExports: ['createClient'], exports: { './admin': ['createClient'] } },
    });
    expect(built.sharedExports).toEqual(['shared']);

    const missing = await buildClientPackage({
      ...options,
      proof: { distinctExports: ['createClient'], exports: { './admin': ['dropSession'] } },
    }).catch((error: unknown) => error);
    expect(missing).toMatchObject({
      reason: 'missing-export',
      details: { subpath: './admin', names: ['dropSession'] },
    });
  }, 120_000);

  test.each(['extensionless', 'ts'] as const)(
    'declarations typecheck for a strict consumer under Bundler and NodeNext (%s imports)',
    async (imports) => {
      const source = imports === 'ts' ? await createClientProject('ts') : project;
      temporary.push(source);
      const proofSource = join(source, 'consumer-proof.ts');
      await writeFile(proofSource, STRICT_CONSUMER);
      const built = await buildClientPackage({
        ...clientPackageOptions(source),
        proof: { typecheck: [proofSource] },
      });
      expect(built.proof.resolutions).toEqual(['bundler', 'NodeNext']);
      // Only the entries' own graph is declared: the project's failing server module is absent.
      expect(built.files.map((file) => file.path)).toContain('dist/src/schema.d.ts');
      expect(built.files.some((file) => file.path.includes('server'))).toBe(false);

      const consumer = await consumerOf(built.tarball);
      const declarations = await declarationsOf(join(consumer, 'node_modules', NAME));
      const relativeSpecifiers: string[] = [];
      for (const file of declarations) {
        for (const specifier of declarationSpecifiers(await readFile(file, 'utf8'))) {
          if (specifier.text.startsWith('.')) relativeSpecifiers.push(specifier.text);
        }
      }
      expect(relativeSpecifiers.length).toBeGreaterThan(0);
      expect(relativeSpecifiers.filter((specifier) => !specifier.endsWith('.js'))).toEqual([]);
      for (const resolution of ['bundler', 'NodeNext'] as const) {
        expect(await typecheck(consumer, resolution)).toEqual({ exitCode: 0, output: '' });
      }

      // The control: the same declarations with the specifiers as the compiler emitted them
      // (no `.js`) stop resolving under NodeNext, and this consumer typecheck reports it.
      for (const file of declarations) {
        const text = await readFile(file, 'utf8');
        await writeFile(file, text.replaceAll("'../schema.js'", "'../schema'"));
      }
      const unresolved = await typecheck(consumer, 'NodeNext');
      expect(unresolved.exitCode).not.toBe(0);
      expect(unresolved.output).toContain('TS2834');
    },
    120_000,
  );

  test('a consumer source that does not typecheck against the package is refused', async () => {
    const proofSource = join(project, 'wrong-consumer.ts');
    await writeFile(
      proofSource,
      `import type { Session } from '${NAME}';\nexport const bad: Session = { id: 'a', state: 'nope' };\n`,
    );
    const refusal = await buildClientPackage({
      ...clientPackageOptions(project),
      proof: { typecheck: [proofSource] },
    }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ reason: 'typecheck', details: { resolution: 'bundler' } });
    if (!(refusal instanceof ClientPackageError)) return;
    expect(String(refusal.details.output)).toContain('TS2322');
    expect(existsSync(join(project, 'dist/example-control-client-1.4.0.tgz'))).toBe(false);
  }, 120_000);

  test('peers stay outside the archive', async () => {
    const built = await buildClientPackage(clientPackageOptions(project));
    expect(built.modules.filter((module) => module.startsWith(`${ZOD}/`))).toEqual([]);
    expect(built.proof.externals.zod).toMatch(/^4\./);
    const consumer = await consumerOf(built.tarball);
    const installed = join(consumer, 'node_modules', NAME);
    expect(existsSync(join(installed, 'node_modules'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    expect(manifest.peerDependencies).toEqual({ zod: '^4.0.0' });
    expect(manifest.dependencies).toBeUndefined();
    // Every shipped module reaches zod by its name, and none of them carries its code.
    let namesZod = 0;
    for (const file of built.files.filter((entry) => entry.path.endsWith('.js'))) {
      const text = await readFile(join(installed, file.path), 'utf8');
      if (/from\s*"zod"/.test(text)) namesZod += 1;
      expect(text).not.toContain('ZodObject');
    }
    expect(namesZod).toBe(1);

    // The control: a build without external peers carries zod, by the same two measures.
    const bundled = await buildClientArtifact({
      entry: join(project, 'src/client/index.ts'),
      outFile: join(project, 'dist/bundled.js'),
    });
    expect(bundled.modules.some((module) => module.startsWith(`${ZOD}/`))).toBe(true);
    expect(await readFile(bundled.file, 'utf8')).toContain('ZodObject');
  }, 120_000);
});
