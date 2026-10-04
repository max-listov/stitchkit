import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliInvoker } from 'stitchkit/cli';
import {
  ConnectionAuthorizationRequiredError,
  ConnectionRequestError,
  ConnectionResponseTooLargeError,
  ConnectionTimeoutError,
  defineMcpClientConnection,
  mountConnections,
} from 'stitchkit/tools/connections';

const MiB = 1024 * 1024;
const marker = 'packed-private-url-token-body-stack-marker';
const install = fileURLToPath(import.meta.resolve('stitchkit/tools/connections'));
assert.ok(install.includes('/node_modules/stitchkit/'));
const packageDir = install.slice(0, install.indexOf('/dist/'));
assert.equal(lstatSync(packageDir).isSymbolicLink(), false);
assert.ok(realpathSync(packageDir).includes('/node_modules/stitchkit'));

async function fixture(mode = 'json') {
  const senders = new Map();
  const seen = [];
  const state = {
    catalogBytes: 0,
    value: 'ok',
    status: 200,
    callDelay: 0,
    hangInitialize: false,
    hangList: false,
    wrongFrames: false,
  };
  let serial = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET') {
      seen.push('GET');
      if (mode !== 'legacy') {
        response.writeHead(404).end();
        return;
      }
      const endpoint = `/messages/${++serial}`;
      senders.set(endpoint, response);
      response.on('close', () => senders.delete(endpoint));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk.toString('utf8');
    const rpc = JSON.parse(text);
    seen.push(rpc.method);
    if (mode === 'legacy' && url.pathname === '/mcp') {
      response.writeHead(404).end('legacy');
      return;
    }
    if (
      (rpc.method === 'initialize' && state.hangInitialize) ||
      (rpc.method === 'tools/list' && state.hangList)
    )
      return;
    if (rpc.method === 'tools/call' && state.callDelay)
      await new Promise((resolve) => setTimeout(resolve, state.callDelay));
    if (response.destroyed) return;
    if (rpc.method === 'tools/call' && state.status !== 200) {
      response.writeHead(state.status).end(marker);
      return;
    }
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === 'initialize'
        ? { protocolVersion: '2024-11-05' }
        : rpc.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'echo',
                  description: 'x'.repeat(state.catalogBytes),
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : { content: [], structuredContent: { value: state.value } };
    const payload = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result });
    const frame = `event: message\ndata: ${payload}\n\n`;
    const wrong =
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: -1, result: '🙂' })}\n\n`.repeat(
        20,
      );
    if (mode === 'legacy') {
      senders
        .get(url.pathname)
        ?.write(rpc.method === 'tools/call' && state.wrongFrames ? wrong : frame);
      response.writeHead(202).end();
    } else
      response
        .writeHead(200, {
          'content-type': mode === 'finite-sse' ? 'text/event-stream' : 'application/json',
        })
        .end(
          mode === 'finite-sse'
            ? rpc.method === 'tools/call' && state.wrongFrames
              ? wrong
              : frame
            : payload,
        );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    state,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function mounted(mock, limits) {
  return mountConnections([
    defineMcpClientConnection({
      name: marker,
      transport: { url: `${mock.url}?token=${marker}` },
      token: () => marker,
      transports: ['CLI'],
      limits,
    }),
  ]);
}
async function invoker(mock, limits) {
  const runtimeTools = await mounted(mock, limits);
  const raw = [];
  const after = [];
  const cli = await createCliInvoker({
    name: 'packed',
    runtimeTools,
    hooks: {
      onToolError: ({ error }) => raw.push(error),
      afterToolCall: ({ error }) => after.push(error),
    },
  });
  return { invoke: () => cli.invoke('echo', {}), raw, after };
}

async function catalogProof() {
  const mock = await fixture();
  try {
    mock.state.catalogBytes = MiB + 1;
    await assert.rejects(
      mounted(mock),
      (error) =>
        error instanceof ConnectionResponseTooLargeError &&
        error.phase === 'discovery' &&
        error.operation === 'tools/list' &&
        error.maxBytes === MiB &&
        Number.isFinite(error.observedReadBytes) &&
        error.observedReadBytes > MiB,
    );
    const cli = await invoker(mock, { discovery: { maxResponseBytes: 2 * MiB } });
    assert.deepEqual((await cli.invoke()).data, { value: 'ok' });
    mock.state.value = 'x'.repeat(MiB + 1);
    const bounded = await cli.invoke();
    assert.equal(bounded.error?.code, 'CONNECTION_RESPONSE_TOO_LARGE');
    assert.equal(bounded.error?.retryable, false);
    assert.ok(cli.raw[0] instanceof ConnectionResponseTooLargeError);
    assert.equal(cli.after[1], cli.raw[0]);
    const bigCall = await invoker(mock, {
      discovery: { maxResponseBytes: 2 * MiB },
      call: { maxResponseBytes: 2 * MiB },
    });
    assert.equal((await bigCall.invoke()).data.value.length, MiB + 1);
    await assert.rejects(
      mounted(mock, { call: { maxResponseBytes: 2 * MiB } }),
      ConnectionResponseTooLargeError,
    );
  } finally {
    await mock.close();
  }
}

async function deadlineProof() {
  const mock = await fixture();
  try {
    const cli = await invoker(mock, {
      discovery: { timeoutMs: 60 },
      call: { timeoutMs: 250 },
    });
    mock.state.callDelay = 90;
    assert.equal((await cli.invoke()).ok, true);
    const count = mock.seen.filter((method) => method === 'tools/call').length;
    mock.state.hangInitialize = true;
    const stopped = await cli.invoke();
    assert.equal(stopped.error?.code, 'CONNECTION_TIMEOUT');
    assert.deepEqual(stopped.error?.details, {
      message: 'Connection deadline exceeded',
      reason: 'deadline-exceeded',
      operation: 'initialize',
      phase: 'discovery',
      timeoutMs: 60,
      observedReadBytes: 0,
    });
    assert.equal(stopped.exitCode, 7);
    assert.equal(mock.seen.filter((method) => method === 'tools/call').length, count);
    assert.ok(cli.raw[0] instanceof ConnectionTimeoutError);
    mock.state.hangInitialize = false;
    const short = await invoker(mock, {
      discovery: { timeoutMs: 250 },
      call: { timeoutMs: 30 },
    });
    assert.equal((await short.invoke()).error?.details.operation, 'tools/call');
    mock.state.hangList = true;
    await assert.rejects(
      mounted(mock, { discovery: { timeoutMs: 40 }, call: { timeoutMs: 250 } }),
      (error) => error instanceof ConnectionTimeoutError && error.operation === 'tools/list',
    );
  } finally {
    await mock.close();
  }
}

async function streamProof(mode) {
  const mock = await fixture(mode);
  try {
    mock.state.catalogBytes = 8192;
    const bounded = await invoker(mock, {
      discovery: { maxResponseBytes: 16_000 },
      call: { maxResponseBytes: 200 },
    });
    assert.equal((await bounded.invoke()).ok, true);
    mock.state.value = '🙂'.repeat(200);
    const oversized = await bounded.invoke();
    assert.equal(oversized.error?.code, 'CONNECTION_RESPONSE_TOO_LARGE');
    assert.equal(oversized.error?.details.phase, 'call');
    const allowed = await invoker(mock, {
      discovery: { maxResponseBytes: 16_000 },
      call: { maxResponseBytes: 2000 },
    });
    assert.deepEqual((await allowed.invoke()).data, { value: mock.state.value });
    mock.state.wrongFrames = true;
    assert.equal((await bounded.invoke()).error?.code, 'CONNECTION_RESPONSE_TOO_LARGE');
  } finally {
    await mock.close();
  }
}

async function failureProof() {
  const mock = await fixture();
  try {
    const cli = await invoker(mock);
    const original = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);
    try {
      for (const [status, code, exit] of [
        [401, 'UNAUTHORIZED', 2],
        [403, 'FORBIDDEN', 3],
        [503, 'CONNECTION_REQUEST_FAILED', 1],
        [400, 'CONNECTION_REQUEST_FAILED', 1],
        [404, 'CONNECTION_REQUEST_FAILED', 1],
        [405, 'CONNECTION_REQUEST_FAILED', 1],
      ]) {
        mock.state.status = status;
        const before = mock.seen.filter((method) => method === 'tools/call').length;
        const refused = await cli.invoke();
        assert.equal(refused.error?.code, code);
        assert.equal(refused.exitCode, exit);
        assert.equal(mock.seen.filter((method) => method === 'tools/call').length, before + 1);
        assert.ok(!JSON.stringify(refused).includes(marker));
      }
      assert.ok(cli.raw[0] instanceof ConnectionAuthorizationRequiredError);
      assert.ok(cli.raw[2] instanceof ConnectionRequestError);
      assert.equal(cli.raw[2].body, marker);
      assert.equal(cli.after[2], cli.raw[2]);
      assert.deepEqual(logged, []);
      assert.ok(!mock.seen.includes('GET'));
    } finally {
      console.error = original;
    }
  } finally {
    await mock.close();
  }
}

async function child(command, args) {
  const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function compiledProof() {
  const scratch = await mkdtemp(join(tmpdir(), 'stitchkit-mcp-phases-'));
  const mock = await fixture();
  try {
    const binary = join(scratch, 'mcp-cli');
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'mcp-phase-cli.mjs');
    const built = await child('bun', ['build', '--compile', entry, '--outfile', binary]);
    assert.equal(built.code, 0, built.stderr);
    const policy = JSON.stringify({
      discovery: { timeoutMs: 1000, maxResponseBytes: 16_000 },
      call: { timeoutMs: 1000, maxResponseBytes: 200 },
    });
    mock.state.catalogBytes = 8192;
    for (const compact of [false, true]) {
      const flags = compact ? ['--json'] : [];
      const ok = await child(binary, [mock.url, policy, 'echo', ...flags]);
      assert.equal(ok.code, 0, ok.stderr);
      assert.deepEqual(JSON.parse(ok.stdout), { value: 'ok' });
      assert.equal(ok.stderr, '');
      for (const [status, code, exit] of [
        [401, 'UNAUTHORIZED', 2],
        [403, 'FORBIDDEN', 3],
        [503, 'CONNECTION_REQUEST_FAILED', 1],
      ]) {
        mock.state.status = status;
        const fail = await child(binary, [mock.url, policy, 'echo', ...flags]);
        assert.equal(fail.code, exit);
        assert.equal(fail.stdout, '');
        assert.equal(JSON.parse(fail.stderr).error, code);
        assert.ok(!fail.stderr.includes(marker));
        assert.ok(!fail.stderr.includes('unhandled error'));
      }
      mock.state.status = 200;
      mock.state.value = '🙂'.repeat(200);
      const large = await child(binary, [mock.url, policy, 'echo', ...flags]);
      assert.equal(large.code, 1);
      assert.equal(JSON.parse(large.stderr).error, 'CONNECTION_RESPONSE_TOO_LARGE');
      mock.state.value = 'ok';
      const unknown = await child(binary, [mock.url, policy, 'unknown', ...flags]);
      assert.equal(unknown.code, 1);
      assert.equal(JSON.parse(unknown.stderr).error, 'INTERNAL_SERVER_ERROR');
      assert.ok(!unknown.stderr.includes(marker));
      assert.ok(!unknown.stderr.includes('unhandled error'));
    }
    mock.state.callDelay = 90;
    const timed = await child(binary, [
      mock.url,
      JSON.stringify({ discovery: { timeoutMs: 1000 }, call: { timeoutMs: 30 } }),
      'echo',
      '--json',
    ]);
    assert.equal(timed.code, 7);
    assert.equal(JSON.parse(timed.stderr).details.operation, 'tools/call');
    assert.equal(JSON.parse(timed.stderr).retryable, false);
  } finally {
    await mock.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

await catalogProof();
await deadlineProof();
await streamProof('finite-sse');
await streamProof('legacy');
await failureProof();
await compiledProof();
console.log('packed MCP phase limits and failures: ok');
