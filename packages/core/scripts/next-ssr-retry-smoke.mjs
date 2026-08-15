/**
 * Real Next.js 16 App Router regression for Stitchkit's per-call Ky fetch
 * adapter. Runs under Node against the packed local package.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = join(coreRoot, 'tests/fixtures/next-ssr-retry');
const workspace = mkdtempSync(join(tmpdir(), 'stitchkit-next-ssr-'));
const appRoot = join(workspace, 'app');
const tarball = join(workspace, 'stitchkit.tgz');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForNext(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next exited before it became ready\n${output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Next is still booting or compiling the route.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Next SSR smoke timed out\n${output.join('')}`);
}

let recoveryAttempts = 0;
let memoAttempts = 0;
let originPort;
let originStarted = false;
let recoveryFetchCalls = 0;
const recoveryDetails = [];
const origin = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(204).end();
    return;
  }
  if (request.url === '/recovery') {
    recoveryAttempts += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
});
const memoOrigin = createServer((request, response) => {
  if (request.url === '/memo') {
    memoAttempts += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ value: 7 }));
    return;
  }
  response.writeHead(404).end();
});
const control = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://control.local');
  if (url.pathname === '/count') {
    if (url.searchParams.get('kind') === 'recovery') recoveryFetchCalls += 1;
    recoveryDetails.push(Object.fromEntries(url.searchParams));
    response.writeHead(204).end();
    return;
  }
  if (url.pathname !== '/start') {
    response.writeHead(404).end();
    return;
  }
  if (originStarted) {
    response.writeHead(204).end();
    return;
  }
  origin.listen(originPort, '127.0.0.1', () => {
    originStarted = true;
    response.writeHead(204).end();
  });
});

let next;
try {
  cpSync(fixtureRoot, appRoot, { recursive: true });
  run('bun', ['pm', 'pack', '--ignore-scripts', '--filename', tarball], coreRoot);
  const manifestPath = join(appRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies.stitchkit = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run('bun', ['install', '--no-save'], appRoot);
  run('bun', ['run', 'build'], appRoot);

  const originReservation = createServer();
  await listen(originReservation);
  const originAddress = originReservation.address();
  assert(originAddress && typeof originAddress === 'object');
  originPort = originAddress.port;
  await close(originReservation);

  await listen(control);
  const controlAddress = control.address();
  assert(controlAddress && typeof controlAddress === 'object');
  await listen(memoOrigin);
  const memoAddress = memoOrigin.address();
  assert(memoAddress && typeof memoAddress === 'object');

  const reservation = createServer();
  await listen(reservation);
  const nextAddress = reservation.address();
  assert(nextAddress && typeof nextAddress === 'object');
  const nextPort = nextAddress.port;
  await close(reservation);

  const output = [];
  next = spawn(
    'node',
    [
      join(appRoot, 'node_modules/next/dist/bin/next'),
      'start',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(nextPort),
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        RETRY_ORIGIN_URL: `http://127.0.0.1:${originPort}`,
        RETRY_CONTROL_URL: `http://127.0.0.1:${controlAddress.port}`,
        MEMO_ORIGIN_URL: `http://127.0.0.1:${memoAddress.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  next.stdout.on('data', (chunk) => output.push(chunk.toString()));
  next.stderr.on('data', (chunk) => output.push(chunk.toString()));

  await waitForNext(`http://127.0.0.1:${nextPort}/api/ready`, next, output);
  const response = await fetch(`http://127.0.0.1:${nextPort}`);
  assert.equal(
    response.status,
    200,
    `Next render failed (logical=${recoveryFetchCalls}, origin=${recoveryAttempts}, started=${originStarted}, details=${JSON.stringify(recoveryDetails)})\n${output.join('')}`,
  );
  const html = await response.text();
  assert.match(html, /data-recovery="true"/);
  assert.match(html, /data-memo-a="7"/);
  assert.match(html, /data-memo-b="7"/);
  assert.equal(recoveryFetchCalls, 2, 'Ky must invoke the selected Next fetch twice');
  assert.equal(recoveryAttempts, 1, 'only the post-rejection retry reaches the origin');
  assert.equal(memoAttempts, 1, 'the first successful attempt must stay memoized by Next');
  console.log('Next.js 16.3.0 SSR retry + first-attempt memoization: OK');
} finally {
  next?.kill('SIGTERM');
  await close(origin).catch(() => undefined);
  await close(memoOrigin).catch(() => undefined);
  await close(control).catch(() => undefined);
  rmSync(workspace, { recursive: true, force: true });
}
