import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';

/**
 * One self-contained artifact, on a machine that has nothing.
 *
 * The optional Socket.IO peers are loaded through a VARIABLE, so no bundler can
 * follow them — deliberately, so a consumer bundling an unrelated
 * `stitchkit/server` export never resolves peers it does not use. The cost was
 * that a consumer who DOES use the adapter, and ships one file to a machine
 * with no `node_modules`, had no way back: the package never entered the
 * artifact and the failure arrived at start-up rather than at build time. The
 * only workaround was patching stitchkit's built `dist`.
 *
 * `peers: { server: () => import('socket.io') }` puts the literal in the
 * consumer's own source, where their bundler sees it. This proves that, and it
 * proves it as a PAIR: the same program without the injection must fail in the
 * same directory. Without the negative half the positive one only shows that
 * the machine running the check happens to have the package — which is exactly
 * how this defect stayed invisible in development, where Bun resolves a missing
 * peer from its install cache.
 */

const MARKER = 'self-contained socket: ok';

/**
 * Which peers a runtime actually asks for.
 *
 * On Bun the adapter builds the engine itself, so an artifact that injected
 * only `socket.io` still fails at start-up on `@socket.io/bun-engine` — which
 * is what the first version of this proof discovered, and exactly the shape of
 * the original report. On Node the engine is never asked for, and bundling a
 * Bun-only package for Node would be asking a bundler to carry `bun:` imports
 * it cannot resolve.
 */
function peerLoaders(target) {
  const loaders = ["    server: () => import('socket.io'),"];
  if (target === 'bun') {
    loaders.push("    bunEngine: () => import('@socket.io/bun-engine'),");
  }
  return ['  peers: {', ...loaders, '  },'];
}

function entrySource({ inject, target }) {
  const peers = inject
    ? peerLoaders(target)
    : [
        '  // No peers: the framework resolves them through a variable, which no',
        '  // bundler can follow — so this artifact contains neither.',
      ];
  return [
    "import { createSocketIOServer } from 'stitchkit/server';",
    '',
    'const handle = await createSocketIOServer({',
    ...peers,
    '});',
    "if (typeof handle.io.emit !== 'function') throw new Error('no socket server');",
    'await handle.close();',
    `console.log(${JSON.stringify(MARKER)});`,
    '',
  ].join('\n');
}

/**
 * A directory with no `node_modules` ANYWHERE above it.
 *
 * Module resolution walks parents, so a "clean" directory nested inside the
 * fixture tree is not clean at all — the first version of this check passed
 * against a bundle that contained nothing, because the fixture's own
 * `node_modules` was three levels up.
 */
function isolatedDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-self-contained-'));
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(
        `[self-contained-socket] ${at} carries node_modules, so nothing below it is isolated`,
      );
    }
    if (at === parse(at).root) break;
  }
  return directory;
}

function runIn(directory, command, args) {
  try {
    return {
      failed: false,
      output: execFileSync(command, args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    return { failed: true, output: `${stdout}${stderr}` || String(error) };
  }
}

/**
 * Its OWN project, not one of the peer-budget fixtures.
 *
 * Those fixtures exist to pin what each entrypoint is allowed to resolve, and
 * one of them forbids `@socket.io/bun-engine` on purpose. Borrowing a fixture
 * to bundle a peer it is specifically not allowed to have would break the check
 * it exists for — so this proof installs what a real consumer of the adapter
 * installs, and leaves the inventory alone.
 */
export function runSelfContainedSocketProof({ workdir, tarball, pkgRoot }) {
  // The ranges come from the package's own `peerDependencies`, so this proof
  // cannot drift from what a consumer is actually told to install.
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const peers = manifest.peerDependencies ?? {};
  const dependencies = { stitchkit: `file:${tarball}` };
  for (const name of ['socket.io', '@socket.io/bun-engine']) {
    const range = peers[name];
    if (!range) {
      throw new Error(
        `[self-contained-socket] the package declares no peer range for ${name}`,
      );
    }
    dependencies[name] = range;
  }

  const source = join(workdir, 'self-contained-socket');
  execFileSync('mkdir', ['-p', join(source, 'src')], { stdio: 'pipe' });
  writeFileSync(
    join(source, 'package.json'),
    `${JSON.stringify(
      { name: 'stitchkit-self-contained-socket', private: true, type: 'module', dependencies },
      null,
      2,
    )}\n`,
  );
  execFileSync('bun', ['install'], { cwd: source, stdio: 'pipe' });

  // Both runtimes, because both are how this is deployed: Node has no
  // auto-install at all, and Bun has one that must be off for the check to mean
  // anything. Each gets an artifact built for it — a Bun-targeted bundle does
  // NOT run on Node (`__require is not a function`), which this proof found the
  // moment it tried.
  const runtimes = [
    { label: 'node', target: 'node', command: 'node', args: (file) => [file] },
    { label: 'bun', target: 'bun', command: 'bun', args: (file) => ['--no-install', file] },
  ];

  const directory = isolatedDirectory();
  try {
    for (const runtime of runtimes) {
      for (const inject of [true, false]) {
        const name = `${runtime.label}-${inject ? 'injected' : 'default'}`;
        const entry = join(source, `self-contained-${name}.ts`);
        const bundle = join(source, `self-contained-${name}.js`);
        writeFileSync(entry, entrySource({ inject, target: runtime.target }));
        execFileSync(
          'bun',
          ['build', entry, `--target=${runtime.target}`, '--outfile', bundle],
          {
            cwd: source,
            stdio: 'pipe',
          },
        );
        copyFileSync(bundle, join(directory, `${name}.js`));
      }
    }

    for (const runtime of runtimes) {
      const injected = runIn(
        directory,
        runtime.command,
        runtime.args(`${runtime.label}-injected.js`),
      );
      if (injected.failed || !injected.output.includes(MARKER)) {
        throw new Error(
          `[self-contained-socket] ${runtime.label}: an artifact built with injected peer loaders did not start without node_modules\n${injected.output}`,
        );
      }

      const fallback = runIn(
        directory,
        runtime.command,
        runtime.args(`${runtime.label}-default.js`),
      );
      if (!fallback.failed) {
        throw new Error(
          `[self-contained-socket] ${runtime.label}: the artifact built WITHOUT injected loaders started anyway — this directory is not isolated, so the positive result above proves nothing\n${fallback.output}`,
        );
      }
      if (!fallback.output.includes('socket.io')) {
        throw new Error(
          `[self-contained-socket] ${runtime.label}: the missing peer was not named in the failure\n${fallback.output}`,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
