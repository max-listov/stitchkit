import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = fileURLToPath(import.meta.resolve('stitchkit'));
assert.ok(installed.includes('/node_modules/stitchkit/'));
const packageDir = installed.slice(0, installed.indexOf('/dist/'));
assert.equal(lstatSync(packageDir).isSymbolicLink(), false);
assert.ok(realpathSync(packageDir).endsWith('/node_modules/stitchkit'));
const require = createRequire(import.meta.url);
for (const peer of ['ai', '@modelcontextprotocol/server']) {
  assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });
}

async function child(command, args, env) {
  const proc = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
  try {
    const code = await new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', resolve);
    });
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function waitCancelled(path) {
  const deadline = Date.now() + 1000;
  while (!cancelled.has(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(cancelled.has(path), 'origin observes caller/deadline socket close');
}

const seen = new Map();
const bodyHeaders = new Set();
const cancelled = new Set();
const timers = new Set();
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? '/', 'http://origin.invalid').pathname;
  seen.set(path, (seen.get(path) ?? 0) + 1);
  assert.equal(request.method, 'POST');
  for await (const _chunk of request) {
    /* Drain the request before holding the reply. */
  }
  if (path.includes('body-')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":');
    bodyHeaders.add(path);
  }
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'application/json' });
    response.end(path.includes('body-') ? 'true}' : '{"ok":true}');
  }, 12_000);
  timers.add(timer);
  response.on('close', () => {
    clearTimeout(timer);
    timers.delete(timer);
    if (!response.writableFinished) cancelled.add(path);
  });
});
server.timeout = 0;
server.requestTimeout = 0;
const scratch = await mkdtemp(join(tmpdir(), 'stitchkit-native-idle-'));
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const binary = join(scratch, 'idle-cli');
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'native-http-idle-cli.mjs');
  const build = await child(
    'bun',
    ['build', '--compile', entry, '--outfile', binary],
    process.env,
  );
  assert.equal(build.code, 0, build.stderr);
  async function run(lane, mode) {
    const result = await child(binary, [lane, baseUrl, mode], {
      ...process.env,
      BUN_CONFIG_HTTP_IDLE_TIMEOUT: '1',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }

  const [baseline, configured, bare] = await Promise.all([
    run('native', 'slow'),
    run('configured', 'slow'),
    run('bare', 'slow'),
  ]);
  assert.equal(baseline.ok, false, 'native control must really hit the idle timer');
  assert.equal(baseline.errorName, 'TimeoutError');
  assert.ok(baseline.elapsedMs >= 1000 && baseline.elapsedMs < 12_000);
  for (const [lane, result] of [
    ['configured', configured],
    ['bare', bare],
  ]) {
    assert.equal(result.ok, true, lane);
    assert.ok(result.elapsedMs >= 12_000 && result.elapsedMs < 20_000, lane);
    assert.equal(seen.get(`/${lane}/slow`), 1);
    for (const [mode, code] of [
      ['deadline', 'REQUEST_TIMEOUT'],
      ['abort', 'REQUEST_ABORTED'],
      ['body-deadline', 'REQUEST_TIMEOUT'],
    ]) {
      const stopped = await run(lane, mode);
      assert.equal(stopped.ok, false);
      assert.equal(stopped.code, code);
      assert.ok(stopped.elapsedMs < 5000);
      assert.equal(seen.get(`/${lane}/${mode}`), 1, 'mutation cannot replay');
      await waitCancelled(`/${lane}/${mode}`);
      if (mode.startsWith('body-')) assert.ok(bodyHeaders.has(`/${lane}/${mode}`));
    }
    const body = await run(lane, 'body-abort');
    assert.equal(body.ok, false);
    assert.equal(body.errorName, 'AbortError');
    assert.equal(body.sameReason, true);
    assert.ok(body.firstBodyBytes > 0);
    assert.equal(seen.get(`/${lane}/body-abort`), 1);
    await waitCancelled(`/${lane}/body-abort`);
    const preaborted = await run(lane, 'preabort');
    assert.equal(preaborted.ok, false);
    assert.equal(preaborted.code, 'REQUEST_ABORTED');
    assert.equal(seen.get(`/${lane}/preabort`), undefined);
  }
  assert.equal(seen.get('/native/slow'), 1);
  assert.ok(cancelled.has('/native/slow'));
  console.log('packed native HTTP idle deadlines: ok');
} finally {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
