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
 * Three fixtures, split by the axes that actually matter — **what a consumer had
 * to install**. Every peer except `zod` is optional, so `minimal` (stitchkit +
 * zod) proves the core path needs nothing else, and `full` adds the peers the
 * tool surface requires. Splitting by entrypoint would prove less: one app can
 * satisfy itself through a transitive import.
 *
 * Usage: `bun scripts/consumer-lane/run.mjs` from `packages/core`, after a build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const FIXTURES = ['minimal', 'full', 'node'];
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

function runExpectFailure(cmd, args, cwd) {
  try {
    run(cmd, args, cwd);
    return { failed: false, output: '' };
  } catch (error) {
    return {
      failed: true,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
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

  for (const name of FIXTURES) {
    const dir = join(workdir, name);
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
      const remoteBundle = join(dir, 'remote-bundle.js');
      const remoteMetafile = join(dir, 'remote-metafile.json');
      step('minimal: bundle remote entrypoint', () =>
        run(
          'bun',
          [
            'build',
            'src/remote-bundle.ts',
            '--target=bun',
            '--packages=bundle',
            `--outfile=${remoteBundle}`,
            `--metafile=${remoteMetafile}`,
          ],
          dir,
        ),
      );
      const remoteInputs = Object.keys(
        JSON.parse(readFileSync(remoteMetafile, 'utf8')).inputs,
      );
      const forbiddenRemoteInputs = remoteInputs.filter(
        (input) => input.includes('@modelcontextprotocol/') || input.includes('/ai/'),
      );
      if (forbiddenRemoteInputs.length > 0) {
        failed = true;
        console.error(
          `[consumer-lane] minimal: stitchkit/remote pulled optional tool peers into the bundle: ${forbiddenRemoteInputs.join(', ')}`,
        );
      }
      step('minimal: run remote bundle', () => run('bun', [remoteBundle], dir));

      const missingToolsPeer = step('minimal: missing tools peer', () =>
        runExpectFailure('node', ['src/missing-mcp-peer.mjs'], dir),
      );
      if (
        !missingToolsPeer.failed ||
        !missingToolsPeer.output.includes("Cannot find package 'ai'")
      ) {
        failed = true;
        console.error(
          '[consumer-lane] minimal: the opted-in tools entry must name its first missing peer',
          missingToolsPeer.output,
        );
      }

      step('minimal: install agent peer for MCP diagnostic', () =>
        run('bun', ['add', '--no-save', 'ai@^7.0.0'], dir),
      );
      const missingMcpPeer = step('minimal: missing MCP peer', () =>
        runExpectFailure('node', ['src/missing-mcp-peer.mjs'], dir),
      );
      if (
        !missingMcpPeer.failed ||
        !missingMcpPeer.output.includes('@modelcontextprotocol/server')
      ) {
        failed = true;
        console.error(
          '[consumer-lane] minimal: stitchkit/tools must name the missing @modelcontextprotocol/server peer',
          missingMcpPeer.output,
        );
      }
    }
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
