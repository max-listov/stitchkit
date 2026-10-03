import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { sandboxProcessOwner } from '../src/agent-runtime/sandbox-process-owner';
import { startNativeCommand } from '../src/process/command-owner';
import { waitForCommandClose } from '../src/process/group';
import { nativeCommandOwner } from '../src/process/launch';

test('Sandbox admission waits for both native close and successful owner settlement', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const hook = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const command = startNativeCommand(
    {
      executable: process.execPath,
      args: ['-e', ''],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        entered.resolve();
        return hook.promise;
      },
    },
    (child) => admission.track(child),
  );
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(admission.size).toBe(1);
  expect(() => admission.admit()).toThrow('concurrency limit');
  hook.resolve();
  await command.result;
  await admission.stop();
  expect(admission.size).toBe(0);
  expect(() => admission.admit()).not.toThrow();
});

test('Sandbox keeps refused settlement visible to shutdown and admission', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const command = startNativeCommand(
    {
      executable: process.execPath,
      args: ['-e', ''],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        throw new Error('settlement refused');
      },
    },
    (child) => admission.track(child),
  );
  await expect(command.result).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
  await expect(admission.stop()).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
  expect(admission.size).toBe(1);
  expect(() => admission.admit()).toThrow('concurrency limit');
});

test('stop after synchronous launch failure propagates cleanup refusal only', async () => {
  for (const refused of [false, true]) {
    const command = startNativeCommand({
      executable: process.execPath,
      args: ['\u0000'],
      timeoutMs: 1000,
      onLeaderSettled: () => {
        if (refused) throw new Error('settlement refused');
      },
    });
    await expect(command.result).rejects.toMatchObject({
      code: refused ? 'COMMAND_CLEANUP' : 'COMMAND_UNAVAILABLE',
    });
    if (refused)
      await expect(command.stop()).rejects.toMatchObject({ code: 'COMMAND_CLEANUP' });
    else await expect(command.stop()).resolves.toBeUndefined();
  }
});

test('a direct natural close retains output and completes one native settlement', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const child = admission.spawn({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("kept-output")'],
    cwd: tmpdir(),
    environment: {},
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += String(bytes);
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve());
    child.once('error', reject);
  });
  try {
    await waitForCommandClose(closed, 3000);
    await waitForCommandClose(admission.stop(), 3000);
    expect(output).toBe('kept-output');
    expect(nativeCommandOwner(child)).toBeDefined();
    expect(admission.size).toBe(0);
  } finally {
    await admission.stop();
  }
});

test('a direct launch error remains observable and releases its admission', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const root = await mkdtemp(join(tmpdir(), 'sandbox-missing-command-'));
  try {
    const child = admission.spawn({
      executable: join(root, 'absent'),
      args: [],
      cwd: root,
      environment: {},
    });
    const error = new Promise<Error>((resolve) => child.once('error', resolve));
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(await waitForCommandClose(error, 3000)).toMatchObject({ code: 'ENOENT' });
    await waitForCommandClose(closed, 3000);
    await waitForCommandClose(admission.stop(), 3000);
    expect(admission.size).toBe(0);
  } finally {
    await admission.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function executing(pid: number): Promise<boolean> {
  try {
    const info = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !info.slice(info.lastIndexOf(')') + 2).startsWith('Z ');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForObservation<T>(read: () => Promise<T | undefined>, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error('Sandbox test observation deadline exceeded');
}

function killTestGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

test.skipIf(process.platform !== 'linux')(
  'direct settlement owns pipe-free descendants after leader exit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-direct-descendant-'));
    const marker = join(root, 'member.json');
    const release = join(root, 'release');
    const helper = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid}));setInterval(()=>{},20)`;
    const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:'ignore'});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},5)`;
    const admission = sandboxProcessOwner(() => undefined, 1);
    const child = admission.spawn({
      executable: process.execPath,
      args: ['-e', leader],
      cwd: root,
      environment: {},
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    let member: number | undefined;
    try {
      const leaderPid = child.pid;
      if (leaderPid === undefined) throw new Error('Expected a running sandbox test leader');
      member = (
        await waitForObservation(async () => {
          const bytes = await readFile(marker, 'utf8').catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
              return null;
            throw error;
          });
          return bytes === null
            ? undefined
            : z.object({ pid: z.number().int().positive() }).parse(JSON.parse(bytes));
        })
      ).pid;
      const info = await readFile(`/proc/${member}/stat`, 'utf8');
      expect(Number(info.slice(info.lastIndexOf(')') + 2).split(' ')[2])).toBe(leaderPid);
      expect(await executing(member)).toBe(true);
      expect(admission.size).toBe(1);
      await writeFile(release, 'exit');
      await waitForCommandClose(closed, 3000);
      await waitForCommandClose(admission.stop(), 3000);
      expect(admission.size).toBe(0);
      const pid = member;
      await waitForObservation(async () => ((await executing(pid)) ? undefined : true), 1000);
      expect(await executing(member)).toBe(false);
    } finally {
      if (
        child.pid !== undefined &&
        (child.exitCode === null || (member !== undefined && (await executing(member))))
      ) {
        killTestGroup(child.pid);
      }
      await admission.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
