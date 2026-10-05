import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A library bundles public imports once, and ships their declaration closure with Zod as its only peer. */
export function qualifyNeutralLibrary(author) {
  const root = mkdtempSync(join(tmpdir(), 'stitchkit-neutral-library-'));
  const artifact = join(root, 'artifact');
  const consumer = join(root, 'consumer');
  const packageRoot = join(author, 'node_modules/stitchkit');
  const dist = join(packageRoot, 'dist');
  const lib = join(artifact, 'lib');
  const run = (command, args, cwd) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    mkdirSync(lib, { recursive: true });
    mkdirSync(consumer);
    const exports = {};
    const seen = new Set();
    const copyDeclaration = (relative) => {
      if (seen.has(relative)) return;
      seen.add(relative);
      const source = resolve(dist, relative);
      assert.ok(
        source.startsWith(`${dist}/`),
        'declaration must remain inside published artifact',
      );
      const text = readFileSync(source, 'utf8');
      const destination = join(lib, relative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, text);
      for (const [, specifier] of text.matchAll(
        /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g,
      )) {
        if (!specifier.startsWith('.')) {
          assert.ok(
            specifier === 'zod' || specifier.startsWith('node:'),
            `unexpected declaration dependency ${specifier}`,
          );
          continue;
        }
        copyDeclaration(
          resolve(dirname(source), specifier.replace(/\.js$/, '.d.ts')).slice(dist.length + 1),
        );
      }
    };
    for (const name of ['files', 'primitives', 'process']) {
      const entry = join(author, `neutral-${name}.mjs`);
      writeFileSync(entry, `export * from 'stitchkit/${name}';\n`);
      run(
        'bun',
        [
          'build',
          entry,
          '--target=node',
          '--external=zod',
          '--outdir',
          join(lib, 'entrypoints'),
          `--entry-naming=${name}.js`,
        ],
        author,
      );
      copyDeclaration(`entrypoints/${name}.d.ts`);
      exports[`./${name}`] = {
        types: `./lib/entrypoints/${name}.d.ts`,
        import: `./lib/entrypoints/${name}.js`,
      };
    }
    writeFileSync(
      join(artifact, 'package.json'),
      JSON.stringify({
        name: 'neutral-library-fixture',
        version: '1.0.0',
        type: 'module',
        exports,
        files: ['lib'],
        dependencies: {},
        peerDependencies: { zod: '^4.0.0' },
      }),
    );
    run('bun', ['pm', 'pack', '--destination', root], artifact);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          'neutral-library-fixture': `file:${join(root, 'neutral-library-fixture-1.0.0.tgz')}`,
          zod: '^4.0.0',
        },
      }),
    );
    run('bun', ['install', '--ignore-scripts'], consumer);
    assert.equal(
      existsSync(join(consumer, 'node_modules/stitchkit')),
      false,
      'consumer installs no backend kernel',
    );
    assert.equal(
      existsSync(join(consumer, 'node_modules/ky')),
      false,
      'consumer installs no HTTP client',
    );
    const fixture = readFileSync(join(author, 'src/native-owners.mjs'), 'utf8')
      .replaceAll("'stitchkit/files'", "'neutral-library-fixture/files'")
      .replaceAll("'stitchkit/process'", "'neutral-library-fixture/process'");
    writeFileSync(join(consumer, 'owners.mjs'), fixture);
    const sources = join(dirname(fileURLToPath(import.meta.url)), 'neutral-library');
    copyFileSync(join(sources, 'json.mjs'), join(consumer, 'json.mjs'));
    writeFileSync(join(consumer, 'negative.mjs'), "import 'stitchkit/files';");
    for (const runtime of ['bun', 'node']) {
      assert.ok(run(runtime, ['owners.mjs'], consumer).includes('packed native owners: ok'));
      assert.ok(run(runtime, ['json.mjs'], consumer).includes('neutral JSON: ok'));
      assert.throws(
        () => run(runtime, ['negative.mjs'], consumer),
        /Cannot find|Cannot resolve|Module not found/,
      );
    }
    copyFileSync(join(sources, 'types.ts'), join(consumer, 'types.ts'));
    mkdirSync(join(consumer, 'node_modules/@types'), { recursive: true });
    // Node's ambient declarations are a typechecking tool, never a runtime dependency of the artifact.
    cpSync(
      join(author, 'node_modules/@types/node'),
      join(consumer, 'node_modules/@types/node'),
      { recursive: true, dereference: true },
    );
    const undici = join(author, 'node_modules/undici-types');
    if (existsSync(undici))
      cpSync(undici, join(consumer, 'node_modules/undici-types'), {
        recursive: true,
        dereference: true,
      });
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          types: ['node'],
        },
        include: ['types.ts'],
      }),
    );
    run('bunx', ['tsc', '--project', 'tsconfig.json'], consumer);
    return `neutral library runtime/types: ok (${seen.size} declaration files; no Stitchkit/ky install)`;
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const name of ['files', 'primitives', 'process'])
      rmSync(join(author, `neutral-${name}.mjs`), { force: true });
  }
}
