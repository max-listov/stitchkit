import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpClient } from 'stitchkit';
import { createBoundedAdmission } from 'stitchkit/application';
import { createCliInvoker } from 'stitchkit/cli';
import { AppError } from 'stitchkit/contract';
import { withExclusiveLock } from 'stitchkit/files';
import { implement, serveNode } from 'stitchkit/node';
import { implementRemote } from 'stitchkit/remote';
import { isAgentToolError, mountAgent } from 'stitchkit/tools';
import { createMcpHandler } from 'stitchkit/tools/mcp';
import { contract } from './remote-http-contract.mjs';

const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('@types/bun/package.json'), { code: 'MODULE_NOT_FOUND' });
const install = fileURLToPath(import.meta.resolve('stitchkit/remote'));
assert.ok(install.includes('/node_modules/stitchkit/'));
const packageDir = install.slice(0, install.indexOf('/dist/'));
assert.equal(lstatSync(packageDir).isSymbolicLink(), false);
assert.ok(realpathSync(packageDir).includes('/node_modules/stitchkit'));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function worker(cooperate = true) {
  return {
    cooperate,
    entered: deferred(),
    finished: deferred(),
    release: deferred(),
    aborted: false,
    sawAbort: deferred(),
  };
}
function subprocess(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  return { child, result };
}
async function rpc(handler, method, params, id = 1) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
    : text;
  assert.ok(payload);
  return JSON.parse(payload).result;
}

const scratch = await mkdtemp(join(tmpdir(), 'stitchkit-remote-http-'));
const lockPath = join(scratch, 'operation.lock');
const admission = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
let current;
async function operation(ctx) {
  const active = current;
  if (!active) return { ok: true };
  const admitted = admission.acquire();
  assert.equal(admitted.outcome, 'leased');
  try {
    await withExclusiveLock(
      lockPath,
      async (lock) => {
        await lock.assertHeld();
        const onAbort = () => {
          active.aborted = true;
          active.sawAbort.resolve();
          if (active.cooperate) active.release.resolve();
        };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });
        if (ctx.signal?.aborted) onAbort();
        active.entered.resolve();
        try {
          await active.release.promise;
        } finally {
          ctx.signal?.removeEventListener('abort', onAbort);
        }
      },
      { timeoutMs: 0 },
    );
    return { ok: true };
  } finally {
    admitted.lease.release();
    active.finished.resolve();
  }
}
const originService = implement(contract, {
  fail: ({ input }) => {
    throw new AppError('DOMAIN_REFUSED', {
      message: 'A safe refusal',
      status: input.status,
      details: { marker: 'safe' },
      hint: 'Reconcile destination',
      retryable: input.declared,
    });
  },
  plain: operation,
  input: operation,
  empty: operation,
});
const origin = await serveNode({ hostname: '127.0.0.1', port: 0, services: [originService] });
const http = createHttpClient({ baseUrl: origin.url, retry: { limit: 0 } });
const remote = implementRemote(contract, http);

async function metadataProof() {
  const direct = await createCliInvoker({ name: 'direct', services: [originService] });
  const proxy = await createCliInvoker({ name: 'proxy', services: [remote] });
  const agents = mountAgent([remote]);
  const mcp = createMcpHandler({
    serverInfo: { name: 'remote', version: '1' },
    services: [remote],
    auth: () => ({ id: 'reader' }),
  });
  try {
    await rpc(mcp, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'probe', version: '1' },
    });
    for (const [status, declared, expected] of [
      [502, false, false],
      [409, true, true],
      [502, undefined, true],
      [409, undefined, false],
    ]) {
      const args = { status, ...(declared === undefined ? {} : { declared }) };
      for (const invoker of [direct, proxy]) {
        const failed = await invoker.invoke('recommendation_fail', args);
        assert.equal(failed.ok, false);
        assert.equal(failed.error.code, 'DOMAIN_REFUSED');
        assert.equal(failed.error.retryable, expected);
        assert.equal(failed.error.hint, 'Reconcile destination');
        assert.deepEqual(failed.error.details, { marker: 'safe' });
      }
      const called = await rpc(mcp, 'tools/call', {
        name: 'recommendation_fail',
        arguments: args,
      });
      assert.equal(called.isError, true);
      const text = called.content.find((block) => block.type === 'text');
      assert.ok(text);
      const failure = JSON.parse(text.text);
      assert.equal(failure.retryable, expected);
      assert.equal(failure.error, 'DOMAIN_REFUSED');
      await assert.rejects(
        agents.recommendation_fail.execute(args, { toolCallId: 'probe', messages: [] }),
        (error) =>
          isAgentToolError(error) &&
          error.output.error === 'DOMAIN_REFUSED' &&
          error.output.retryable === expected,
      );
    }
  } finally {
    await mcp.close();
  }
}
async function released(active) {
  await bounded(active.finished.promise, 'Origin did not physically finish');
  assert.equal(active.aborted, true);
  assert.equal(admission.getSnapshot().active, 0);
  await withExclusiveLock(
    lockPath,
    async (lock) => {
      await lock.assertHeld();
    },
    { timeoutMs: 0 },
  );
  current = undefined;
}
async function inProcessProof() {
  for (const [command, args] of [
    ['plain', {}],
    ['input', { text: 'value' }],
    ['empty', {}],
  ]) {
    const active = worker();
    current = active;
    const controller = new AbortController();
    const invoker = await createCliInvoker({
      name: 'cancel',
      services: [remote],
      signal: controller.signal,
    });
    const pending = invoker.invoke(command, args);
    await bounded(active.entered.promise, 'Origin was never entered');
    assert.equal(admission.getSnapshot().active, 1);
    controller.abort(new Error('private-caller-reason'));
    const result = await bounded(pending, 'Caller did not stop');
    assert.equal(result.error.code, 'REQUEST_ABORTED');
    assert.equal(result.error.retryable, false);
    assert.equal(result.exitCode, 130);
    assert.ok(!JSON.stringify(result).includes('private-caller-reason'));
    await released(active);
  }
  const active = worker(false);
  current = active;
  const controller = new AbortController();
  const invoker = await createCliInvoker({
    name: 'noncooperative',
    services: [remote],
    signal: controller.signal,
  });
  const pending = invoker.invoke('plain', {});
  await bounded(active.entered.promise, 'Noncooperative origin was never entered');
  controller.abort();
  assert.equal(
    (await bounded(pending, 'Caller remained waiting')).error.code,
    'REQUEST_ABORTED',
  );
  await bounded(active.sawAbort.promise, 'Origin did not receive caller cancellation');
  assert.equal(admission.getSnapshot().active, 1);
  await assert.rejects(
    withExclusiveLock(lockPath, () => undefined, { timeoutMs: 0 }),
    (error) => error.code === 'LOCK_TIMEOUT',
  );
  active.release.resolve();
  await released(active);
}
async function compiledProof() {
  const binary = join(scratch, 'remote-cli');
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'remote-http-cli.mjs');
  const build = await subprocess('bun', ['build', '--compile', entry, '--outfile', binary])
    .result;
  assert.equal(build.code, 0, build.stderr);
  const positive = await subprocess(binary, [origin.url, 'input', '--text', 'value', '--json'])
    .result;
  assert.equal(positive.code, 0, positive.stderr);
  assert.deepEqual(JSON.parse(positive.stdout), { ok: true });
  for (const compact of [false, true]) {
    const active = worker();
    current = active;
    const run = subprocess(binary, [origin.url, 'plain', ...(compact ? ['--json'] : [])]);
    await bounded(active.entered.promise, 'Compiled CLI never reached origin');
    assert.equal(run.child.kill('SIGTERM'), true);
    const result = await bounded(run.result, 'Compiled CLI did not stop');
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error, 'REQUEST_ABORTED');
    assert.equal(JSON.parse(result.stderr).retryable, false);
    assert.ok(!result.stderr.includes('private-caller-reason'));
    await released(active);
  }
}
try {
  await metadataProof();
  await inProcessProof();
  await compiledProof();
} finally {
  current?.release.resolve();
  if (current) await bounded(current.finished.promise, 'Final origin cleanup failed');
  await origin.shutdown({ gracePeriodMs: 0, forceTimeoutMs: 200 });
  await rm(scratch, { recursive: true, force: true });
}
console.log('packed HTTP remote metadata and cancellation: ok');
