/**
 * A typed client of a contract, built into an npm package by the installed framework.
 *
 * The framework is the client's peer here, as it is for a real consumer: the proof inside
 * `buildClientPackage` installs the archive beside this fixture's own `stitchkit` and `zod`,
 * imports both entries in Node and Bun and typechecks a strict consumer under both resolutions.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClientPackage,
  ClientPackageError,
  ForbiddenModuleError,
} from 'stitchkit/files/packaging';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(fixture, 'src', 'client-package');
const framework = JSON.parse(
  readFileSync(join(fixture, 'node_modules', 'stitchkit', 'package.json'), 'utf8'),
).version;
const work = mkdtempSync(join(tmpdir(), 'stitchkit-client-package-proof-'));

try {
  const consumerProof = join(work, 'consumer-proof.ts');
  writeFileSync(
    consumerProof,
    "import { type Session, sessions } from '@example/sessions-client';\n" +
      "import { isBusy } from '@example/sessions-client/monitoring';\n" +
      'const path: string = sessions.endpoints.list.path;\n' +
      "const busy: boolean = isBusy({ id: 'a', state: 'busy' });\n" +
      '// @ts-expect-error state is a closed enum: an unresolved declaration would make it `any`\n' +
      "const bad: Session = { id: 'a', state: 'nope' };\n" +
      'export { bad, busy, path };\n',
  );
  const options = {
    name: '@example/sessions-client',
    version: '1.0.0',
    entries: { '.': join(source, 'index.ts'), './monitoring': join(source, 'monitoring.ts') },
    tsconfig: join(fixture, 'tsconfig.json'),
    peerDependencies: { stitchkit: `^${framework}`, zod: '^4.0.0' },
    outDir: join(work, 'out'),
    proof: {
      typecheck: [consumerProof],
      exports: { '.': ['sessions'], './monitoring': ['isBusy'] },
      types: ['@types/node'],
    },
  };

  const built = await buildClientPackage(options);
  // The contract, its schema and its error class are one object across both entries.
  assert.deepEqual(built.sharedExports, ['SessionError', 'SessionSchema', 'sessions']);
  assert.deepEqual(built.proof.runtimes, ['node', 'bun']);
  assert.deepEqual(built.proof.resolutions, ['bundler', 'NodeNext']);
  assert.equal(built.proof.externals.stitchkit, framework);
  // Nothing of the framework or of zod is in the package: three modules of the client itself.
  assert.deepEqual(
    built.modules.map((module) => module.slice(source.length + 1)),
    ['contract.ts', 'index.ts', 'monitoring.ts'],
  );
  assert.ok(built.files.every((file) => !file.path.includes('node_modules')));
  assert.ok(
    built.bytes < 4096,
    `archive of ${built.bytes} bytes carries more than the client`,
  );

  // A subpath of the external peer is refused by the import that names it.
  await assert.rejects(
    buildClientPackage({ ...options, forbiddenModules: ['stitchkit/contract'] }),
    (error) =>
      error instanceof ForbiddenModuleError &&
      error.module === 'stitchkit/contract' &&
      error.importedBy.endsWith('contract.ts'),
  );
  // A range the installed framework is outside of is a typed refusal, and leaves no archive.
  await assert.rejects(
    buildClientPackage({
      ...options,
      peerDependencies: { ...options.peerDependencies, stitchkit: '^999.0.0' },
    }),
    (error) =>
      error instanceof ClientPackageError &&
      error.reason === 'peer-range' &&
      error.details.package === 'stitchkit',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('packed client package: ok');
