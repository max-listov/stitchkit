import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sandboxProcessOwner } from '../src/agent-runtime/sandbox-process-owner';
import { startNativeCommand } from '../src/process/command-owner';
import { waitForCommandClose } from '../src/process/group';
import { nativeCommandOwner } from '../src/process/launch';
import { processAlive } from './support/process-state';
import { eventLoopTurn, observe, until } from './support/until';

test('Sandbox admission waits for both native close and successful owner settlement', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const hook = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
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
    (child) => {
      child.once('close', () => closed.resolve());
      admission.track(child);
    },
  );
  await Promise.all([entered.promise, closed.promise]);
  await eventLoopTurn();
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

test('a direct natural close retains output and settles without a command owner', async () => {
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
    // A direct child is settled by the group terminator, never by a command wrapped around it.
    expect(nativeCommandOwner(child)).toBeUndefined();
    expect(admission.size).toBe(0);
  } finally {
    await admission.stop();
  }
});

function stoppedWithin(pid: number): Promise<boolean> {
  return until(() => !processAlive(pid), `process ${pid} to stop`, 3_000).then(
    () => true,
    () => false,
  );
}

test('a direct child that exits leaves no descendant: its group is stopped and its pipes close', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const child = admission.spawn({
    executable: '/bin/sh',
    args: ['-c', 'sleep 30 & echo $!'],
    cwd: tmpdir(),
    environment: {},
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += String(bytes);
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const grandchild = await new Promise<number>((resolve) => {
    child.stdout.on('data', () => {
      const pid = Number(output.trim());
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
    });
  });
  try {
    // The sleeper holds the inherited pipe, so close can only follow the group stop.
    await waitForCommandClose(closed, 3000);
    expect(await stoppedWithin(grandchild)).toBe(true);
    await waitForCommandClose(admission.stop(), 3000);
    expect(admission.size).toBe(0);
  } finally {
    await admission.stop();
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

test('stop terminates a running direct child group without reading its output', async () => {
  const admission = sandboxProcessOwner(() => undefined, 1);
  const child = admission.spawn({
    executable: '/bin/sh',
    args: ['-c', 'sleep 30 & echo $!; wait'],
    cwd: tmpdir(),
    environment: {},
  });
  let output = '';
  const ready = new Promise<number>((resolve) => {
    child.stdout.on('data', (bytes) => {
      output += String(bytes);
      const pid = Number(output.trim());
      if (Number.isInteger(pid) && pid > 0) resolve(pid);
    });
  });
  const grandchild = await ready;
  try {
    await waitForCommandClose(admission.stop(), 5000);
    expect(await stoppedWithin(grandchild)).toBe(true);
    expect(admission.size).toBe(0);
    expect(nativeCommandOwner(child)).toBeUndefined();
  } finally {
    try {
      process.kill(grandchild, 'SIGKILL');
    } catch {
      // Already gone.
    }
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
    if (!(error instanceof Error && 'code' in error)) throw error;
    if (error.code === 'ENOENT') return false;
    // A process being torn down fails the read itself with ESRCH before it becomes a zombie;
    // it has not stopped yet, so the caller keeps observing until the zombie or the absence.
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

function waitForObservation<T>(read: () => Promise<T | undefined>, timeoutMs = 3000) {
  return observe(read, 'a Sandbox test observation', timeoutMs);
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
    const admission = sandboxProcessOwner(() => undefined, 1);
    const child = admission.spawn({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL('./fixtures/sandbox-leader-until-release.mjs', import.meta.url)),
        marker,
        release,
      ],
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
      // Settles only on a zombie or an absent pid, both terminal; a second read could meet the
      // reaping itself and fail with ESRCH.
      await waitForObservation(async () => ((await executing(pid)) ? undefined : true), 1000);
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
