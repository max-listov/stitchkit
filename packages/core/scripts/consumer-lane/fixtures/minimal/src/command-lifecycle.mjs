import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';

const node = spawnSync('node', ['-p', 'process.execPath']).stdout.toString().trim();
assert.ok(node, 'native Node executable');
const command = (script) => ({ executable: node, args: ['-e', script] });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function blockedGroup(root) {
  const counter = join(root, 'counter');
  const helper = `const fs=require('fs');process.on('SIGTERM',()=>{});let n=0;setInterval(()=>fs.appendFileSync(${JSON.stringify(counter)},String(++n)+'\\n'),5);`;
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});setTimeout(()=>process.stdout.write('ready'),150);setInterval(()=>{},1000);`;
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
    killGraceMs: 10,
    onOutput: async () => {
      entered();
      await held;
    },
  });
  try {
    await started;
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
    killGraceMs: 0,
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
    await delay(80);
    assert.ok(reader.stdin.writableLength > 0, 'physical pipe write remains blocked');
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
  await blockedGroup(root);
  // Node's writableLength qualifies the native pipe. Bun's compatibility wrapper
  // does not expose that pending-write measurement; its blocked sink is tested above.
  if (!process.versions.bun) await undrainedPipe();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('leader exited')), 150);
  try {
    await assert.rejects(
      runNativeCommand({
        ...command(
          "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.exit(0);",
        ),
        signal: controller.signal,
        killGraceMs: 0,
      }),
      /leader exited/,
    );
  } finally {
    clearTimeout(timer);
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
  // Source suite covers the Bun owner for 61s; this control exercises the installed Node owner.
  if (!process.versions.bun) {
    const deadline = new AbortController();
    const watchdog = setTimeout(
      () => deadline.abort(new Error('61s control watchdog')),
      65_000,
    );
    try {
      const result = await runNativeCommand({
        ...command("setTimeout(()=>process.stdout.write('done'),61000)"),
        signal: deadline.signal,
        capture: true,
        maxOutputBytes: 4,
      });
      assert.equal(new TextDecoder().decode(result.stdout), 'done');
      assert.equal(result.exitCode, 0);
    } finally {
      clearTimeout(watchdog);
    }
  }
  console.log('packed command lifecycle: ok');
}
