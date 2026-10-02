import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeCommand } from '../src/entrypoints/process';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stitchkit-command-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const NODE = spawnSync('node', ['-p', 'process.execPath']).stdout.toString().trim();
if (!NODE) throw new Error('native Node executable unavailable');
const command = (script: string) => ({ executable: NODE, args: ['-e', script] });

test('native capture preserves raw bytes and counts actual combined bytes', async () => {
  const input = command(
    'process.stdout.write(Buffer.from([255,0,97]));process.stderr.write(Buffer.from([98]));',
  );
  const result = await runNativeCommand({
    ...input,
    capture: true,
    maxOutputBytes: 4,
    timeoutMs: 2000,
  });
  expect(Array.from(result.stdout)).toEqual([255, 0, 97]);
  expect(Array.from(result.stderr)).toEqual([98]);
  await expect(
    runNativeCommand({ ...input, capture: true, maxOutputBytes: 3, timeoutMs: 2000 }),
  ).rejects.toMatchObject({ code: 'COMMAND_LIMIT' });
  expect((await runNativeCommand({ ...input, timeoutMs: 2000 })).stdout.length).toBe(0);
});

test('declared-only missing env stays empty and ambient is explicit', async () => {
  const input = command('process.stdout.write(process.env.PATH?"ambient":"empty")');
  const capture = { capture: true, maxOutputBytes: 100, timeoutMs: 2000 };
  expect(
    new TextDecoder().decode((await runNativeCommand({ ...input, ...capture })).stdout),
  ).toBe('empty');
  expect(
    new TextDecoder().decode(
      (await runNativeCommand({ ...input, ...capture, envPolicy: 'ambient' })).stdout,
    ),
  ).toBe('ambient');
});

test('command cwd args environment and bounded stdin are applied', async () => {
  const input = {
    executable: NODE,
    args: [
      '-e',
      'process.stdin.pipe(process.stdout); process.stderr.write(process.cwd()+":"+process.env.MARK+":"+process.argv[1]);process.exitCode=7;',
      'arg',
    ],
  };
  const result = await runNativeCommand({
    ...input,
    cwd: root,
    env: { MARK: 'set' },
    stdin: new Uint8Array([0, 255]),
    maxStdinBytes: 2,
    capture: true,
    maxOutputBytes: 2000,
    timeoutMs: 2000,
  });
  expect(result.exitCode).toBe(7);
  expect(Array.from(result.stdout)).toEqual([0, 255]);
  expect(new TextDecoder().decode(result.stderr)).toBe(`${root}:set:arg`);
  expect(() =>
    runNativeCommand({ ...input, stdin: new Uint8Array(3), maxStdinBytes: 2, timeoutMs: 100 }),
  ).toThrow();
});

test('native streaming fully drains multi-megabyte output per channel before completion', async () => {
  const chunks: Record<'stdout' | 'stderr', Uint8Array[]> = { stdout: [], stderr: [] };
  const result = await runNativeCommand({
    ...command(
      'for(let i=0;i<32;i++){process.stdout.write(Buffer.alloc(65536,i));process.stderr.write(Buffer.alloc(65536,255-i));}',
    ),
    timeoutMs: 5000,
    onOutput: async (bytes, channel) => {
      await new Promise((r) => setTimeout(r, 1));
      chunks[channel].push(bytes);
    },
  });
  for (const channel of ['stdout', 'stderr'] as const) {
    const expected = Buffer.concat(
      Array.from({ length: 32 }, (_, i) =>
        Buffer.alloc(65536, channel === 'stdout' ? i : 255 - i),
      ),
    );
    expect(Buffer.concat(chunks[channel]).equals(expected)).toBe(true);
    expect(result[channel].length).toBe(0);
  }
});

test('blocked sink abort releases wait and terminates TERM-resistant descendant without touching unrelated child', async () => {
  const counter = join(root, 'counter');
  const pidfile = join(root, 'pid');
  const helper = `const fs=require('fs');process.on('SIGTERM',()=>{});let n=0;setInterval(()=>fs.writeFileSync(${JSON.stringify(counter)},String(++n)),5);`;
  const script = `const {spawn}=require('child_process');const fs=require('fs');const h=spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidfile)},String(h.pid));setTimeout(()=>process.stdout.write('ready'),100);setInterval(()=>{},1000);`;
  const unrelated = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const controller = new AbortController();
  let sinkEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    sinkEntered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promise = runNativeCommand({
    ...command(script),
    signal: controller.signal,
    killGraceMs: 10,
    cleanupTimeoutMs: 1000,
    onOutput: async () => {
      sinkEntered();
      await held;
    },
  });
  try {
    await entered;
    controller.abort(new Error('cancel'));
    await expect(promise).rejects.toThrow('cancel');
    const first = await readFile(counter, 'utf8');
    await new Promise((r) => setTimeout(r, 50));
    expect(await readFile(counter, 'utf8')).toBe(first);
    expect(unrelated.exitCode).toBeNull();
  } finally {
    release();
    unrelated.kill('SIGKILL');
    await new Promise<void>((resolve) => unrelated.once('close', () => resolve()));
  }
}, 5000);

test('parent exit with helper holding pipes remains cancellable and sink failure cleans up', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('cancel after leader exit')), 100);
  await expect(
    runNativeCommand({
      ...command(
        "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.exit(0);",
      ),
      signal: controller.signal,
      killGraceMs: 0,
    }),
  ).rejects.toThrow('cancel after leader exit');
  await expect(
    runNativeCommand({
      ...command("process.stdout.write('x');setInterval(()=>{},1000)"),
      timeoutMs: 1000,
      onOutput: () => {
        throw new Error('sink failure');
      },
    }),
  ).rejects.toThrow('sink failure');
});

test('pre-spawn abort creates no command and deadlines bound a live command', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  expect(() =>
    runNativeCommand({
      ...command('throw new Error("must not spawn")'),
      signal: controller.signal,
    }),
  ).toThrow('already cancelled');
  await expect(
    runNativeCommand({ ...command('setInterval(()=>{},1000)'), timeoutMs: 20 }),
  ).rejects.toMatchObject({ code: 'COMMAND_LIMIT' });
  expect(() => runNativeCommand(command(''))).toThrow('caller signal');
  expect(() => runNativeCommand({ ...command(''), capture: true, timeoutMs: 100 })).toThrow(
    'output budget',
  );
});

test('caller-lifetime streaming has no hidden sixty-second deadline', async () => {
  const controller = new AbortController();
  const result = await runNativeCommand({
    ...command("setTimeout(()=>process.stdout.write('done'),61000)"),
    signal: controller.signal,
    capture: true,
    maxOutputBytes: 10,
  });
  expect(new TextDecoder().decode(result.stdout)).toBe('done');
}, 65000);

test('physically undrained native pipe abort completes before reader teardown', async () => {
  const reader = spawn(NODE, ['-e', 'process.stdin.pause();setInterval(()=>{},1000)'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  reader.stdin.on('error', () => undefined);
  const controller = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sinks = 0;
  let outputSignal: AbortSignal | undefined;
  const producer = runNativeCommand({
    ...command(
      "const b=Buffer.alloc(65536);function write(){while(process.stdout.write(b)){}process.stdout.once('drain',write)}write();",
    ),
    signal: controller.signal,
    killGraceMs: 0,
    onOutput: (bytes, _channel, signal) => {
      sinks++;
      outputSignal = signal;
      return new Promise<void>((resolve, reject) => {
        reader.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
        entered();
      });
    },
  });
  try {
    await waiting;
    await new Promise((r) => setTimeout(r, 50));
    const began = performance.now();
    controller.abort(new Error('undrained pipe cancelled'));
    await expect(producer).rejects.toThrow('undrained pipe cancelled');
    expect(performance.now() - began).toBeLessThan(1500);
    expect(reader.exitCode).toBeNull();
    expect(outputSignal?.aborted).toBe(true);
    const count = sinks;
    await new Promise((r) => setTimeout(r, 20));
    expect(sinks).toBe(count);
  } finally {
    reader.kill('SIGKILL');
    await new Promise<void>((resolve) => reader.once('close', () => resolve()));
  }
}, 5000);

test('early stdin close is handled without an unhandled EPIPE', async () => {
  const result = await runNativeCommand({
    ...command('process.stdin.destroy();process.exit(0)'),
    stdin: new Uint8Array(1024 * 1024),
    capture: true,
    maxOutputBytes: 10,
    timeoutMs: 2000,
  });
  expect(result.exitCode).toBe(0);
});

test('command grace and cleanup options control their native budgets', async () => {
  const { waitForCommandClose } = await import('../src/process/group');
  await expect(
    waitForCommandClose(new Promise<number>((resolve) => setTimeout(() => resolve(0), 30)), 1),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(
    await waitForCommandClose(
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 5)),
      100,
    ),
  ).toBe(0);
  const controller = new AbortController();
  let began = 0;
  await expect(
    runNativeCommand({
      ...command(
        "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)",
      ),
      signal: controller.signal,
      killGraceMs: 80,
      onOutput: () => {
        began = performance.now();
        controller.abort(new Error('grace control'));
      },
    }),
  ).rejects.toThrow('grace control');
  expect(performance.now() - began).toBeGreaterThanOrEqual(65);
});

test('synchronous spawn failure releases the caller listener and deadline', async () => {
  const controller = new AbortController();
  await expect(
    runNativeCommand({
      executable: NODE,
      args: ['\u0000'],
      signal: controller.signal,
      timeoutMs: 1000,
    }),
  ).rejects.toThrow('Command could not start');
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('signal termination reports the observed signal without synthesizing an exit code', async () => {
  const result = await runNativeCommand({
    ...command("process.kill(process.pid,'SIGTERM')"),
    timeoutMs: 2000,
  });
  expect(result.exitCode).toBeNull();
  expect(result.signal).toBe('SIGTERM');
});

test('native deadline refuses timer overflow instead of silently firing after one millisecond', async () => {
  const input = command("setTimeout(()=>process.stdout.write('done'),40)");
  expect(() => runNativeCommand({ ...input, timeoutMs: 2_147_483_648 })).toThrow();
  const result = await runNativeCommand({
    ...input,
    timeoutMs: 2_147_483_647,
    capture: true,
    maxOutputBytes: 4,
  });
  expect(new TextDecoder().decode(result.stdout)).toBe('done');
});

test('an already aborted race observes a late producer rejection', async () => {
  const { raceAbort } = await import('../src/internal/abort-race');
  const controller = new AbortController();
  const reason = new Error('already aborted');
  controller.abort(reason);
  await expect(
    raceAbort(Promise.reject(new Error('producer failure')), controller.signal),
  ).rejects.toBe(reason);
  await new Promise((resolve) => setTimeout(resolve, 5));
});
