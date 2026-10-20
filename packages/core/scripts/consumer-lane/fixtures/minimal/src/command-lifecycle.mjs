import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';

const node = spawnSync('node', ['-p', 'process.execPath']).stdout.toString().trim();
assert.ok(node, 'native Node executable');
const command = (script) => ({ executable: node, args: ['-e', script] });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until a kernel-side state holds, within a bound. A pipe fills as fast as the producer and
 * the runner allow, so a fixed pause proves nothing on a slow host; the state itself does.
 */
async function eventually(holds, timeoutMs, message) {
  const deadline = performance.now() + timeoutMs;
  while (!holds()) {
    assert.ok(performance.now() < deadline, message);
    await delay(10);
  }
}

export async function verifyBlockedGroup(root, helperStartDelayMs = 0) {
  const counter = join(root, 'counter');
  // The helper emits readiness only after its first write, independent of startup latency.
  const helper = `const fs=require('fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(counter)},'0\\n');process.stdout.write('ready');let n=0;setInterval(()=>fs.appendFileSync(${JSON.stringify(counter)},String(++n)+'\\n'),5);`;
  const script = `setTimeout(()=>{const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','pipe','inherit']});child.stdout.once('data',()=>process.stdout.write('ready'));},${helperStartDelayMs});setInterval(()=>{},1000);`;
  const foreign = spawn(node, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const foreignClosed = new Promise((resolve) => foreign.once('close', resolve));
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const reason = new Error('packed blocked sink cancelled');
  const pending = runNativeCommand({
    ...command(script),
    signal: controller.signal,
    timeoutMs: 3000,
    stop: { target: 'group', graceMs: 10 },
    onOutput: async () => {
      entered();
      await held;
    },
  });
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error('Command settled before helper readiness');
      }),
    ]);
    const before = await readFile(counter, 'utf8');
    let grew = false;
    for (let attempt = 0; attempt < 50 && !grew; attempt++) {
      await delay(10);
      grew = (await readFile(counter, 'utf8')).length > before.length;
    }
    assert.ok(grew, 'helper was running');
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    const stopped = await readFile(counter, 'utf8');
    await delay(50);
    assert.equal(await readFile(counter, 'utf8'), stopped, 'TERM-resistant helper stopped');
    assert.equal(foreign.exitCode, null, 'unrelated child remains alive');
  } finally {
    controller.abort(reason);
    release();
    await pending.catch(() => undefined);
    foreign.kill('SIGKILL');
    await foreignClosed;
  }
}

async function undrainedPipe() {
  const reader = spawn(node, ['-e', 'process.stdin.pause();setInterval(()=>{},1000)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const readerClosed = new Promise((resolve) => reader.once('close', resolve));
  reader.stdin.on('error', () => undefined);
  const controller = new AbortController();
  const reason = new Error('packed undrained pipe cancelled');
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let sinks = 0;
  let outputSignal;
  const pending = runNativeCommand({
    ...command(
      "const b=Buffer.alloc(65536);function write(){while(process.stdout.write(b)){}process.stdout.once('drain',write)}write();",
    ),
    signal: controller.signal,
    stop: { target: 'group', graceMs: 0 },
    onOutput: (bytes, _channel, signal) => {
      sinks++;
      outputSignal = signal;
      return new Promise((resolve, reject) => {
        reader.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
        entered();
      });
    },
  });
  try {
    await started;
    await eventually(
      () => reader.stdin.writableLength > 0,
      5000,
      'physical pipe write remains blocked',
    );
    const began = performance.now();
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.ok(performance.now() - began < 1500, 'bounded cancellation before reader teardown');
    assert.equal(reader.exitCode, null);
    assert.equal(outputSignal.aborted, true);
    const count = sinks;
    await delay(20);
    assert.equal(sinks, count, 'no late sink invocation');
  } finally {
    controller.abort(reason);
    // Reader is held until after producer cancellation; never drain it to make the test pass.
    reader.kill('SIGKILL');
    await readerClosed;
    await pending.catch(() => undefined);
  }
}

export async function verifyCommandLifecycle(root) {
  await verifyBlockedGroup(root);
  // Node's writableLength qualifies the native pipe. Bun's compatibility wrapper
  // does not expose that pending-write measurement; its blocked sink is tested above.
  if (!process.versions.bun) await undrainedPipe();
  const controller = new AbortController();
  const reason = new Error('leader exited');
  let helperReady = false;
  let leaderExited = false;
  const cancel = () => {
    if (helperReady && leaderExited) setImmediate(() => controller.abort(reason));
  };
  try {
    await assert.rejects(
      runNativeCommand({
        ...command(
          "require('child_process').spawn(process.execPath,['-e',\"process.stdout.write('ready');setInterval(()=>{},1000)\"],{stdio:['ignore',1,2]});process.exit(0);",
        ),
        timeoutMs: 3000,
        signal: controller.signal,
        stop: { target: 'group', graceMs: 0 },
        // The child outlives the leader and keeps the pipes; only the caller's abort ends it.
        descendants: 'leave',
        onOutput() {
          helperReady = true;
          cancel();
        },
        onLeaderSettled(event) {
          assert.equal(event.kind, 'exit');
          assert.equal(event.exitCode, 0);
          leaderExited = true;
          cancel();
        },
      }),
      (error) => error === reason,
    );
    assert.equal(helperReady, true, 'descendant holds the inherited pipe');
    assert.equal(leaderExited, true, 'leader exited before caller cancellation');
  } finally {
    controller.abort(reason);
  }
  await assert.rejects(
    runNativeCommand({
      ...command("process.stdout.write('x');setInterval(()=>{},1000)"),
      timeoutMs: 2000,
      onOutput: () => {
        throw new Error('packed sink failure');
      },
    }),
    /packed sink failure/,
  );
  assert.throws(() => runNativeCommand({ ...command(''), timeoutMs: 2_147_483_648 }));
  console.log('packed command lifecycle: ok');
}
