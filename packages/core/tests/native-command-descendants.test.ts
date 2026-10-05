import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodingShell } from '../src/agent-runtime/coding-shell-process';
import { runNativeCommand } from '../src/entrypoints/process';
import { CommandStopped } from '../src/process/command-lifetime';
import { startNativeCommand } from '../src/process/command-owner';
import { NativeCommandError, NativeCommandOptionsSchema } from '../src/process/contract';
import { nativeCommandOwner } from '../src/process/launch';
import { spawnOwnedCommand } from '../src/process/owned-child';
import { processAlive } from './support/process-state';
import { until } from './support/until';

const COOPERATIVE_LEADER = fileURLToPath(
  new URL('./fixtures/native-cooperative-leader.mjs', import.meta.url),
);

const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
});

async function dies(pid: number): Promise<boolean> {
  const deadline = performance.now() + 3000;
  while (processAlive(pid)) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** The leader exits 0 at once and leaves a long sleeper whose stdio is detached from the pipes. */
const detachedGrandchild = ['-c', 'sleep 30 >/dev/null 2>&1 </dev/null & echo $!'];

async function grandchildAfterSuccess(descendants: 'terminate-after-leader' | 'leave') {
  const command = startNativeCommand({
    executable: '/bin/sh',
    args: detachedGrandchild,
    capture: true,
    maxOutputBytes: 64,
    timeoutMs: 5000,
    descendants,
  });
  const result = await command.result;
  const pid = Number(new TextDecoder().decode(result.stdout).trim());
  expect(Number.isInteger(pid)).toBe(true);
  pids.push(pid);
  expect(result.exitCode).toBe(0);
  return pid;
}

describe('descendants policy of a native command', () => {
  test('descendants: terminate-after-leader ends a detached grandchild after a successful run, leave keeps it', async () => {
    const stopped = await grandchildAfterSuccess('terminate-after-leader');
    expect(await dies(stopped)).toBe(true);
    const kept = await grandchildAfterSuccess('leave');
    expect(processAlive(kept)).toBe(true);
  });

  test('terminate-after-leader frees a descendant that holds the output pipe; leave waits for it', async () => {
    const holder = ['-c', 'sleep 30 & echo $!'];
    const result = await startNativeCommand({
      executable: '/bin/sh',
      args: holder,
      capture: true,
      maxOutputBytes: 64,
      timeoutMs: 5000,
      descendants: 'terminate-after-leader',
    }).result;
    expect(result.exitCode).toBe(0);
    const stoppedPid = Number(new TextDecoder().decode(result.stdout).trim());
    pids.push(stoppedPid);
    expect(await dies(stoppedPid)).toBe(true);

    const error = await startNativeCommand({
      executable: '/bin/sh',
      args: holder,
      capture: true,
      maxOutputBytes: 64,
      timeoutMs: 300,
      descendants: 'leave',
    }).result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NativeCommandError);
    expect(error).toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });
  });

  test('an unknown descendants policy is refused before a process starts', () => {
    const parsed = NativeCommandOptionsSchema.safeParse({
      executable: '/bin/sh',
      timeoutMs: 1000,
      descendants: 'terminate',
    });
    expect(parsed.success).toBe(false);
    expect(
      NativeCommandOptionsSchema.parse({ executable: '/bin/sh', timeoutMs: 1000 }),
    ).toMatchObject({
      descendants: 'terminate-after-leader',
    });
  });
});

describe('default descendants policy', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stitchkit-descendants-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The fixture leader exits 0 once its group member (stdio detached from the command) is ready. */
  async function memberLeftBehind(descendants: { descendants?: 'leave' }): Promise<number> {
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [COOPERATIVE_LEADER, dir, 'exit-when-ready'],
      timeoutMs: 10_000,
      ...descendants,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number(await readFile(join(dir, 'member-pid'), 'utf8'));
    pids.push(pid);
    return pid;
  }

  test('a command that does not declare descendants kills the member its leader left in the group', async () => {
    const member = await memberLeftBehind({});
    await until(() => !processAlive(member), 'the member left behind to be killed');
  }, 20_000);

  test("descendants: 'leave' keeps the member its leader left in the group", async () => {
    const member = await memberLeftBehind({ descendants: 'leave' });
    expect(processAlive(member)).toBe(true);
  }, 20_000);
});

describe('typed stop reason', () => {
  test('stop() aborts with CommandStopped, whatever its wording', async () => {
    const command = startNativeCommand({
      executable: '/bin/sh',
      args: ['-c', 'sleep 30'],
      timeoutMs: 10_000,
    });
    await command.stop();
    const error = await command.result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CommandStopped);
  });

  test('the coding shell classifies a stopped command by type, not by message text', async () => {
    const message = Object.getOwnPropertyDescriptor(CommandStopped.prototype, 'message');
    Object.defineProperty(CommandStopped.prototype, 'message', {
      configurable: true,
      get: () => 'reworded stop notice',
    });
    try {
      const output = await runCodingShell({
        executableName: 'sleeper',
        executable: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cwd: '/',
        environment: {},
        timeoutMs: 10_000,
        terminationGraceMs: 500,
        maxOutputBytes: 1024,
        maxArtifactBytes: 4096,
        spawn: () => {
          const child = spawnOwnedCommand({
            executable: '/bin/sh',
            args: ['-c', 'sleep 30'],
            env: {},
            group: true,
          });
          queueMicrotask(() => void nativeCommandOwner(child)?.stop());
          return child;
        },
      });
      expect(output.outcome).toBe('cancelled');
    } finally {
      Reflect.deleteProperty(CommandStopped.prototype, 'message');
      if (message) Object.defineProperty(CommandStopped.prototype, 'message', message);
    }
  });
});
