import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { ApiError } from 'stitchkit/http';
import { createHandler, implement } from 'stitchkit/server';
import {
  client,
  contract,
  queryClient,
  realtimeClient,
  retained,
} from './native-client-graph.mjs';

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'stitchkit-native-client-hermes-'));
const compilerRoot = dirname(require.resolve('hermes-compiler/package.json'));
const compiler = join(
  compilerRoot,
  'hermesc',
  process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin',
  'hermesc',
);
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native client control exceeded 5 seconds')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const output = join(root, 'native.js');
  const entry = fileURLToPath(new URL('./native-client-graph.mjs', import.meta.url));
  const built = run('bun', [
    'build',
    entry,
    '--target=browser',
    '--format=iife',
    '--outfile',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(readFileSync(output, 'utf8'), /SOCKET_IO_CLIENT|webpackIgnore/);
  const babel = await import('@babel/core');
  const transformed = await babel.transformFileAsync(output, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-async-generator-functions')],
  });
  assert.ok(transformed?.code);
  writeFileSync(output, transformed.code);
  const compiled = run(compiler, ['-emit-binary', '-out', join(root, 'native.hbc'), output]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(statSync(join(root, 'native.hbc')).size > 0);
  const negative = join(root, 'computed-import.js');
  writeFileSync(negative, "const peer='socket.io-client';globalThis.load=()=>import(peer);\n");
  const refused = run(compiler, ['-emit-binary', '-out', join(root, 'bad.hbc'), negative]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Invalid expression|import/i);

  assert.equal(queryClient.getQueryCache().getAll().length, 0);
  retained.record('greeting', 'retained');
  assert.equal(retained.get('greeting'), 'retained');
  const handler = createHandler({
    services: [implement(contract, { greeting: () => ({ message: 'hello' }) })],
  });
  const http = Bun.serve({
    port: 0,
    fetch: (request) =>
      request.headers.get('authorization') === 'accepted'
        ? handler(request)
        : Response.json(
            { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
            { status: 401 },
          ),
  });
  try {
    assert.deepEqual(await client(http.url.toString(), 'accepted').greeting(), {
      message: 'hello',
    });
    await assert.rejects(
      client(http.url.toString(), 'denied').greeting(),
      (error) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    await http.stop(true);
  }

  const transport = createServer();
  const io = new Server(transport);
  io.use((socket, next) => {
    if (socket.handshake.auth.token === 'accepted') return next();
    const error = new Error('Unauthorized');
    error.data = { code: 'handshake_rejected' };
    next(error);
  });
  io.on('connection', (socket) => socket.emit('greeting', { message: 'realtime hello' }));
  await new Promise((resolve) => transport.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${transport.address().port}`;
  const accepted = realtimeClient(url, 'accepted');
  let denied;
  try {
    const greeting = new Promise((resolve) => accepted.on('greeting', resolve));
    accepted.connect();
    assert.deepEqual(await bounded(greeting), { message: 'realtime hello' });
    assert.equal(accepted.connected, true);
    let refusedAuth;
    const rejection = new Promise((resolve) => {
      refusedAuth = resolve;
    });
    denied = realtimeClient(url, 'denied', refusedAuth);
    denied.connect();
    const report = await bounded(rejection);
    assert.equal(report.terminal, true);
    assert.equal(report.message, 'Unauthorized');
    assert.equal(denied.connected, false);
  } finally {
    accepted.disconnect();
    denied?.disconnect();
    await new Promise((resolve) => io.close(resolve));
  }
  console.log('packed Hermes native HTTP query realtime graph: ok');
} finally {
  queryClient.clear();
  rmSync(root, { recursive: true, force: true });
}
