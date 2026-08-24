/**
 * The consumer lane — build the package, install it the way a consuming project
 * does, and exercise it through the published entrypoints only.
 *
 * Why this exists. The test suite imports from `src`, in one process, with
 * everything in scope. A consumer gets a tarball, an `exports` map and the
 * emitted declarations. Four defects in one day lived in the gap between those
 * two views and were all reported from outside: a bundler-folded environment
 * read that made the structured log line unreachable in every published copy, a
 * tool error whose cause no consumer hook could see, a type named in a public
 * signature and exported nowhere, and a raw value delivered to the wrong hook.
 *
 * `check-browser-clean` and `check-env-live` are the same instinct, one scar at
 * a time. This is the net for the next one nobody has thought of.
 *
 * Four fixtures are split by the axis that actually matters — **what a consumer
 * had to install**. The optional-peer matrix then classifies every public export
 * and mixed-barrel feature by target, installed peers, runtime bundle budget,
 * declaration budget and execution policy. Adding an export without adding a
 * matrix row is therefore a release-gate failure rather than an implicit choice.
 *
 * Usage: `bun scripts/consumer-lane/run.mjs` from `packages/core`, after a build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOptionalPeerMatrix } from './optional-peer-matrix.mjs';

const here = import.meta.dirname;
const pkgRoot = join(here, '..', '..');

/**
 * Declaration references that do not resolve on a minimal install, accepted
 * knowingly. Every entry is an **optional** peer, so a consumer who did not opt
 * in genuinely does not have its types — and `skipLibCheck: true`, the near
 * universal default, never looks. The list exists so that a *new* name is a
 * failure: an unresolved reference that is not on it means the package started
 * demanding something it does not declare.
 *
 * A name that stops appearing is reported, not failed — shrinking this list is
 * a good change and should not break an unrelated release. Read the report.
 */
const ACCEPTED_UNRESOLVED = [
  'Bun',
  'bun',
  'node:http',
  'socket.io',
  '@socket.io/bun-engine',
  '@socket.io/component-emitter',
];

const FIXTURES = ['minimal', 'full', 'node', 'grammy'];
const NODE_FORBIDDEN_UNRESOLVED = ['Bun', 'bun', '@socket.io/bun-engine'];

let failed = false;
const timings = [];

function step(label, fn) {
  const started = Date.now();
  const result = fn();
  timings.push([label, Date.now() - started]);
  return result;
}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** tsc exits non-zero on errors, so its output arrives via the thrown error. */
function tsc(cwd, extraArgs) {
  try {
    run('bunx', ['tsc', '--noEmit', '-p', 'tsconfig.json', ...extraArgs], cwd);
    return '';
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

if (!existsSync(join(pkgRoot, 'dist'))) {
  console.error('[consumer-lane] no dist/ — run the build first');
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), 'stitchkit-consumer-'));

try {
  // 1. Pack. `bun pm pack` is ~17× faster than `npm pack` and was verified to
  //    produce an identical file list, so the artifact under test is the one
  //    that ships.
  const packOutput = step('pack', () =>
    run('bun', ['pm', 'pack', '--destination', workdir], pkgRoot),
  );
  const tarball = (packOutput.match(/\S+\.tgz/) ?? [])[0]
    ? join(workdir, (packOutput.match(/[\w.@-]+\.tgz/) ?? [])[0])
    : undefined;
  if (!tarball || !existsSync(tarball)) {
    console.error('[consumer-lane] pack produced no tarball\n', packOutput);
    process.exit(1);
  }

  const unresolved = new Set();
  const fixtureDirectories = {};

  for (const name of FIXTURES) {
    const dir = join(workdir, name);
    fixtureDirectories[name] = dir;
    cpSync(join(here, 'fixtures', name), dir, { recursive: true });

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.dependencies.stitchkit = `file:${tarball}`;
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // Checked-in templates point at local source so editors can type them before
    // a package exists. The consumer lane must prove the opposite boundary:
    // remove that authoring-only path before installing and checking the tarball.
    const tsconfigPath = join(dir, 'tsconfig.json');
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    delete tsconfig.compilerOptions.paths;
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);

    step(`${name}: install`, () => run('bun', ['install', '--no-save'], dir));

    if (name === 'node' && existsSync(join(dir, 'node_modules', '@types', 'bun'))) {
      failed = true;
      console.error('[consumer-lane] node: unexpectedly installed @types/bun');
    }
    if (name === 'minimal' && existsSync(join(dir, 'node_modules', 'grammy'))) {
      failed = true;
      console.error('[consumer-lane] minimal: unexpectedly installed optional peer grammy');
    }
    if (
      name === 'minimal' &&
      (existsSync(join(dir, 'node_modules', 'socket.io')) ||
        existsSync(join(dir, 'node_modules', '@socket.io', 'bun-engine')))
    ) {
      failed = true;
      console.error(
        '[consumer-lane] minimal: unexpectedly installed optional Socket.IO peers',
      );
    }

    // The consumer's default. Any error here is the package's fault, full stop.
    const strict = step(`${name}: typecheck`, () => tsc(dir, []));
    if (strict.trim()) {
      failed = true;
      console.error(`[consumer-lane] ${name}: does not typecheck for a consumer\n${strict}`);
    }

    // Do the emitted declarations stand on their own? Collect what does not
    // resolve rather than failing on it — the allowlist above is the judgement.
    const libCheck = step(`${name}: declaration check`, () =>
      tsc(dir, ['--skipLibCheck', 'false']),
    );
    const fixtureUnresolved = new Set();
    for (const line of libCheck.split('\n')) {
      if (!line.includes('node_modules/stitchkit/')) continue;
      const module = line.match(/Cannot find module '([^']+)'/);
      const namespace = line.match(/Cannot find (?:namespace|name) '([^']+)'/);
      const found = module?.[1] ?? namespace?.[1];
      if (found) {
        unresolved.add(found);
        fixtureUnresolved.add(found);
      }
    }
    if (name === 'node') {
      const bunLeaks = [...fixtureUnresolved].filter((name) =>
        NODE_FORBIDDEN_UNRESOLVED.includes(name),
      );
      if (bunLeaks.length > 0) {
        failed = true;
        console.error(
          `[consumer-lane] node: Bun declarations leaked into stitchkit/node: ${bunLeaks.join(', ')}`,
        );
      }
    }

    const output = step(`${name}: run`, () => {
      try {
        return name === 'node'
          ? run('node', ['src/runtime.mjs'], dir)
          : run('bun', ['src/app.ts'], dir);
      } catch (err) {
        failed = true;
        console.error(
          `[consumer-lane] ${name}: failed\n${err.stdout ?? ''}${err.stderr ?? ''}`,
        );
        return '';
      }
    });
    if (output.trim()) console.log(`[consumer-lane] ${output.trim()}`);

    if (name === 'minimal') {
      const conformanceOutput = step('minimal: managed resource conformance', () =>
        run('bun', ['src/managed-resource-conformance.ts'], dir),
      );
      if (!conformanceOutput.includes('managed resource conformance: ok')) {
        failed = true;
        console.error(
          '[consumer-lane] minimal: managed resource conformance produced no proof',
          conformanceOutput,
        );
      }
      const recipesOutput = step('minimal: application migration recipes', () =>
        run('bun', ['src/application-migration-recipes.ts'], dir),
      );
      if (!recipesOutput.includes('application migration recipes: ok')) {
        failed = true;
        console.error(
          '[consumer-lane] minimal: application migration recipes produced no proof',
          recipesOutput,
        );
      }
    }

    if (name === 'node') {
      const output = step('node: real application signal/drain/force', () =>
        run('node', ['src/application-signal-parent.mjs'], dir),
      );
      if (!output.includes('node application signal/drain/force: ok')) {
        failed = true;
        console.error(
          '[consumer-lane] node: application signal path produced no proof',
          output,
        );
      }
    }
  }

  try {
    step('optional-peer matrix', () => runOptionalPeerMatrix({ fixtureDirectories }));
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
  }

  const unexpected = [...unresolved].filter((n) => !ACCEPTED_UNRESOLVED.includes(n));
  const gone = ACCEPTED_UNRESOLVED.filter((n) => !unresolved.has(n));
  if (unexpected.length > 0) {
    failed = true;
    console.error(
      `[consumer-lane] the published declarations reference something new that a consumer cannot resolve: ${unexpected.join(', ')}\n` +
        '  Either it belongs in ACCEPTED_UNRESOLVED (an optional peer, knowingly), or the package now needs a dependency it does not declare.',
    );
  }
  if (gone.length > 0) {
    console.log(
      `[consumer-lane] no longer unresolved — drop from ACCEPTED_UNRESOLVED: ${gone.join(', ')}`,
    );
  }

  const total = timings.reduce((sum, [, ms]) => sum + ms, 0);
  console.log(
    `[consumer-lane] ${total} ms  (${timings.map(([l, ms]) => `${l} ${ms}`).join(', ')})`,
  );
} finally {
  if (failed) console.error(`[consumer-lane] workdir kept for inspection: ${workdir}`);
  else rmSync(workdir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log('[consumer-lane] the published package works for a consumer');
