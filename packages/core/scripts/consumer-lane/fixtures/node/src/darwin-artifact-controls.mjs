import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withExclusiveLock } from 'stitchkit/files';
import { observeProcessInstance, probeProcessOwner } from 'stitchkit/process';

const standalone = typeof Bun !== 'undefined' && Bun.isStandaloneExecutable;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const marker = 'Darwin artifact native controls: ok';

function launch(arguments_) {
  const script = standalone ? [] : [import.meta.filename];
  const child = spawn(process.execPath, [...script, ...arguments_], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(
      () => reject(new Error('Native child readiness timed out')),
      3000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Native child exited before readiness'));
    });
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      if (buffered.length > 128) {
        clearTimeout(timer);
        reject(new Error('Native child readiness exceeded its budget'));
      } else if (buffered.includes('ready\n')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    pid: child.pid,
    ready,
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      let timer;
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Native child cleanup timed out')),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function observed(pid) {
  const observation = await observeProcessInstance(pid);
  assert.equal(observation.state, 'observed', 'Native process identity was unavailable');
  assert.equal(observation.instance.platform, 'darwin');
  assert.ok(observation.instance.bootId);
  assert.ok(observation.instance.namespace);
  assert.match(observation.instance.startId, /^\d+$/);
  return observation.instance;
}

async function processControls() {
  const own = await observed(process.pid);
  assert.deepEqual(await observed(process.pid), own);
  assert.deepEqual(await probeProcessOwner(process.pid, own), {
    liveness: 'alive',
    identity: 'matched',
  });
  assert.deepEqual(
    await probeProcessOwner(process.pid, { ...own, startId: `${own.startId}0` }),
    { liveness: 'gone', identity: 'reused-pid' },
  );
  const child = launch(['--identity-child']);
  try {
    await child.ready;
    const first = await observed(child.pid);
    await pause(20);
    assert.deepEqual(await observed(child.pid), first);
    assert.deepEqual(await probeProcessOwner(child.pid, first), {
      liveness: 'alive',
      identity: 'matched',
    });
    await child.stop('SIGKILL');
    assert.deepEqual(await probeProcessOwner(child.pid, first), {
      liveness: 'gone',
      identity: 'pid-gone',
    });
    assert.equal((await observeProcessInstance(child.pid)).state, 'unavailable');
  } finally {
    await child.stop();
  }
}

async function lockControls() {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-artifact-lock-'));
  const lockPath = path.join(root, 'owner.lock');
  const options = {
    machineIdentity: 'darwin-artifact-control',
    timeoutMs: 0,
    ownerlessGraceMs: null,
  };
  const holder = launch(['--lock-child', lockPath]);
  try {
    await holder.ready;
    let callbacks = 0;
    await assert.rejects(
      withExclusiveLock(
        lockPath,
        () => {
          callbacks++;
        },
        options,
      ),
      /gave up/,
    );
    assert.equal(callbacks, 0);
    await holder.stop('SIGKILL');
    assert.equal(
      await withExclusiveLock(
        lockPath,
        (lock) => {
          callbacks++;
          return lock.reclaimed;
        },
        options,
      ),
      true,
    );
    assert.equal(callbacks, 1);
  } finally {
    await holder.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function refusedBackend() {
  const expected = process.argv[process.argv.indexOf('--expect-unavailable') + 1];
  assert.ok(['missing', 'corrupt', 'unsupported'].includes(expected));
  const observation = await observeProcessInstance(process.pid);
  assert.equal(observation.state, 'unavailable');
  assert.ok(observation.cause instanceof Error);
  const diagnostic = JSON.parse(JSON.stringify(observation.cause));
  assert.equal(diagnostic.code, 'DARWIN_BACKEND_UNAVAILABLE');
  // Bun standalone can report a missing literal import as an Error without code.
  // Only an observed native code can distinguish resolve from a generic load refusal.
  const resolvedMissing = ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(
    diagnostic.nativeCode,
  );
  assert.equal(
    diagnostic.stage,
    expected === 'missing' && resolvedMissing ? 'resolve' : 'load',
  );
  assert.equal(diagnostic.architecture, process.arch);
  assert.equal(Object.hasOwn(diagnostic, 'stack'), false);
  assert.equal(Object.hasOwn(diagnostic, 'cause'), false);
  assert.equal(JSON.stringify(diagnostic).includes('stitchkit-'), false);
  if (expected === 'unsupported') {
    const loaderError = observation.cause.cause;
    assert.ok(loaderError instanceof Error);
    assert.ok(loaderError.cause instanceof Error);
    assert.equal(loaderError.cause.message, 'Unsupported Darwin addon architecture');
  }
  const owner = await probeProcessOwner(process.pid, {
    platform: 'darwin',
    bootId: 'unavailable-control',
    namespace: 'host',
    startId: '1',
  });
  assert.equal(owner.identity, 'unavailable');
  assert.equal(owner.liveness, 'not-probed');
  console.log(JSON.stringify({ control: expected, backend: diagnostic }));
  console.log(`Darwin artifact backend ${expected}: refused`);
}

if (process.argv.includes('--expect-linux')) {
  assert.equal(process.platform, 'linux');
  const own = await observeProcessInstance(process.pid);
  assert.equal(own.state, 'observed');
  assert.equal(own.instance.platform, 'linux');
  console.log('Universal artifact Linux without Darwin addons: ok');
} else {
  assert.equal(process.platform, 'darwin');
  if (process.argv.includes('--identity-child')) {
    console.log('ready');
    await pause(15000);
  } else if (process.argv.includes('--lock-child')) {
    const lockPath = process.argv[process.argv.indexOf('--lock-child') + 1];
    await withExclusiveLock(
      lockPath,
      async () => {
        console.log('ready');
        await pause(15000);
      },
      { machineIdentity: 'darwin-artifact-control' },
    );
  } else if (process.argv.includes('--expect-unavailable')) {
    await refusedBackend();
  } else {
    if (standalone) {
      const expected = process.argv[process.argv.indexOf('--expected-native') + 1];
      const matches = [];
      for (const file of Bun.embeddedFiles) {
        if (!file.name.endsWith('.node')) continue;
        const digest = createHash('sha256')
          .update(new Uint8Array(await file.arrayBuffer()))
          .digest('hex');
        if (digest === expected) matches.push(file);
      }
      assert.equal(
        matches.length,
        1,
        'Exactly one embedded addon must match the original hash',
      );
      const asset = matches[0];
      assert.ok(asset, 'Standalone artifact did not embed its native addon');
      assert.equal(
        createHash('sha256')
          .update(new Uint8Array(await asset.arrayBuffer()))
          .digest('hex'),
        expected,
      );
    }
    await processControls();
    await lockControls();
    await import('./contained-files.mjs');
    console.log(marker);
  }
}
