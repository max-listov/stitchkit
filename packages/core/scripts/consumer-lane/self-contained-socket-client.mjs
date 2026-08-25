import { execFileSync, spawn } from 'node:child_process';
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
 * The other half of the same artifact problem: a program that DIALS.
 *
 * `self-contained-socket.mjs` proves the server half. This proves the client
 * half, and the consumer is a different shape — a CLI, an agent, a worker, a
 * desktop client: one file copied to a machine with no `node_modules`, often no
 * network, that opens a socket rather than accepting connections. For that
 * consumer `socket.io-client` is resolved through a variable specifier, so no
 * bundler could follow it and there was no way to put it inside the artifact.
 * The only remaining workaround was patching stitchkit's built `dist` — the
 * exact dead end the server half was added to close.
 *
 * Proved as a PAIR, for the same reason as the server half: the same program
 * without the injection must fail in the same directory. Without the negative
 * half the positive one only shows that the machine happens to have the
 * package, which is how this class of defect stays invisible in development.
 *
 * And it proves CONNECTION, not construction. The artifact completes a round
 * trip against a real server, so a bundle that loaded the wrong module or a
 * client that never opened a socket does not pass.
 */

const MARKER = 'self-contained socket client: ok';

function clientSource({ inject }) {
  const peers = inject
    ? ["  peers: { client: () => import('socket.io-client') },"]
    : [
        '  // No peers: the framework resolves the client through a variable, which',
        '  // no bundler can follow — so this artifact does not contain it.',
      ];
  return [
    "import { createSocketIOClient } from 'stitchkit';",
    '',
    'const url = process.argv[2];',
    'const client = createSocketIOClient({',
    '  url,',
    "  transports: ['websocket'],",
    ...peers,
    '  onConnectError: (error) => {',
    '    console.error(error.message);',
    '    process.exit(1);',
    '  },',
    '});',
    '',
    'const finished = new Promise((resolve, reject) => {',
    "  client.on('pong', (payload) => resolve(payload));",
    "  setTimeout(() => reject(new Error('no pong within 10s')), 10_000);",
    '});',
    'client.onConnectionChange((connected) => {',
    "  if (connected) client.emit('ping', { n: 41 });",
    '});',
    'client.connect();',
    'const pong = await finished;',
    'if (pong?.n !== 42) throw new Error("unexpected pong " + JSON.stringify(pong));',
    'client.disconnect();',
    `console.log(${JSON.stringify(MARKER)});`,
    'process.exit(0);',
    '',
  ].join('\n');
}

/** The server the artifact dials — run where `node_modules` exists, as a real deployment's peer would be. */
const SERVER_SOURCE = [
  "import { createSocketIOServer } from 'stitchkit/server';",
  "import { createServer } from 'stitchkit/server';",
  '',
  'const handle = await createSocketIOServer({ cors: { origin: "*" } });',
  "handle.io.on('connection', (socket) => {",
  "  socket.on('ping', (data) => socket.emit('pong', { n: data.n + 1 }));",
  '});',
  'const server = createServer({ port: 0, socket: handle });',
  'console.log("ready " + server.port);',
  '',
].join('\n');

/**
 * A directory with no `node_modules` ANYWHERE above it — module resolution
 * walks parents, so a "clean" directory nested in the fixture tree is not clean.
 */
function isolatedDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-self-contained-client-'));
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(
        `[self-contained-socket-client] ${at} carries node_modules, so nothing below it is isolated`,
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

function startServer(source) {
  const child = spawn('bun', ['server.ts'], {
    cwd: source,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let buffered = '';
    const fail = (reason) => {
      child.kill('SIGKILL');
      reject(new Error(`[self-contained-socket-client] ${reason}\n${buffered}`));
    };
    const timer = setTimeout(() => fail('the peer server never reported a port'), 30_000);
    child.stderr.on('data', (chunk) => {
      buffered += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      const ready = /ready (\d+)/.exec(buffered);
      if (!ready) return;
      clearTimeout(timer);
      resolve({ port: Number(ready[1]), stop: () => child.kill('SIGKILL') });
    });
    child.on('exit', (code) => fail(`the peer server exited with ${code}`));
  });
}

export async function runSelfContainedSocketClientProof({ workdir, tarball, pkgRoot }) {
  // The ranges come from the package's own `peerDependencies`, so this proof
  // cannot drift from what a consumer is actually told to install.
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const peers = manifest.peerDependencies ?? {};
  const dependencies = { stitchkit: `file:${tarball}` };
  for (const name of ['socket.io', 'socket.io-client', '@socket.io/bun-engine']) {
    const range = peers[name];
    if (!range) {
      throw new Error(
        `[self-contained-socket-client] the package declares no peer range for ${name}`,
      );
    }
    dependencies[name] = range;
  }

  const source = join(workdir, 'self-contained-socket-client');
  execFileSync('mkdir', ['-p', source], { stdio: 'pipe' });
  writeFileSync(
    join(source, 'package.json'),
    `${JSON.stringify(
      {
        name: 'stitchkit-self-contained-socket-client',
        private: true,
        type: 'module',
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  execFileSync('bun', ['install'], { cwd: source, stdio: 'pipe' });
  writeFileSync(join(source, 'server.ts'), SERVER_SOURCE);

  // Both runtimes, because both are how this is deployed: Node has no
  // auto-install at all, and Bun's must be OFF for the check to mean anything.
  const runtimes = [
    { label: 'node', target: 'node', command: 'node', args: (file, url) => [file, url] },
    {
      label: 'bun',
      target: 'bun',
      command: 'bun',
      args: (file, url) => ['--no-install', file, url],
    },
  ];

  const directory = isolatedDirectory();
  const server = await startServer(source);
  try {
    const url = `http://127.0.0.1:${server.port}`;
    for (const runtime of runtimes) {
      for (const inject of [true, false]) {
        const name = `${runtime.label}-${inject ? 'injected' : 'default'}`;
        const entry = join(source, `client-${name}.ts`);
        const bundle = join(source, `client-${name}.js`);
        writeFileSync(entry, clientSource({ inject }));
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
        runtime.args(`${runtime.label}-injected.js`, url),
      );
      if (injected.failed || !injected.output.includes(MARKER)) {
        throw new Error(
          `[self-contained-socket-client] ${runtime.label}: an artifact built with an injected client loader did not connect without node_modules\n${injected.output}`,
        );
      }

      const fallback = runIn(
        directory,
        runtime.command,
        runtime.args(`${runtime.label}-default.js`, url),
      );
      if (!fallback.failed) {
        throw new Error(
          `[self-contained-socket-client] ${runtime.label}: the artifact built WITHOUT an injected loader connected anyway — this directory is not isolated, so the positive result above proves nothing\n${fallback.output}`,
        );
      }
      if (!fallback.output.includes('socket.io-client')) {
        throw new Error(
          `[self-contained-socket-client] ${runtime.label}: the missing peer was not named in the failure\n${fallback.output}`,
        );
      }
    }
  } finally {
    server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}
