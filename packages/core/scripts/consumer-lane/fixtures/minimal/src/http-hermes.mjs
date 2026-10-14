import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from 'stitchkit/http';
import { createHandler, implement } from 'stitchkit/server';
import { client, contract } from './http-hermes-client.mjs';

const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('socket.io-client'), { code: 'MODULE_NOT_FOUND' });
const compilerRoot = dirname(require.resolve('hermes-compiler/package.json'));
const platform = process.platform === 'darwin' ? 'osx-bin' : 'linux64-bin';
const compiler = join(compilerRoot, 'hermesc', platform, 'hermesc');
const root = mkdtempSync(join(tmpdir(), 'stitchkit-http-hermes-'));
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
try {
  const entry = fileURLToPath(new URL('./http-hermes-client.mjs', import.meta.url));
  const output = join(root, 'client.js');
  const built = run('bun', [
    'build',
    entry,
    '--target=browser',
    '--format=iife',
    '--outfile',
    output,
  ]);
  assert.equal(built.status, 0, built.stderr);
  assert.doesNotMatch(readFileSync(output, 'utf8'), /socket\.io|webpackIgnore/);
  const bytecode = join(root, 'client.hbc');
  const babel = await import('@babel/core');
  const transformed = await babel.transformFileAsync(output, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-async-generator-functions')],
  });
  assert.ok(transformed?.code, 'the async-generator transform emitted JavaScript');
  writeFileSync(output, transformed.code);
  const compiled = run(compiler, ['-emit-binary', '-out', bytecode, output]);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(statSync(bytecode).size > 0, 'the real compiler emitted bytecode');

  // The root's optional realtime graph is deliberately outside the HTTP-only boundary.
  const negative = join(root, 'computed-import.js');
  writeFileSync(
    negative,
    "const peer = 'socket.io-client'; globalThis.load = () => import(peer);\n",
  );
  const refused = run(compiler, ['-emit-binary', '-out', join(root, 'bad.hbc'), negative]);
  assert.notEqual(refused.status, 0, 'computed imports must be refused');
  assert.match(refused.stderr, /Invalid expression|import/i);

  const api = implement(contract, { greeting: () => ({ message: 'hello' }) });
  const handler = createHandler({ services: [api] });
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get('authorization') !== 'accepted')
        return Response.json(
          { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
          { status: 401 },
        );
      return handler(request);
    },
  });
  try {
    assert.deepEqual(await client(server.url.toString(), 'accepted').greeting(), {
      message: 'hello',
    });
    await assert.rejects(
      client(server.url.toString(), 'denied').greeting(),
      (error) => error instanceof ApiError && error.status === 401,
    );
  } finally {
    await server.stop(true);
  }
  console.log('packed Hermes HTTP client: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
