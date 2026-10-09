import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeCommand } from '../src/entrypoints/process';
import { ownerLossAvailable } from '../src/process/owner-loss-protocol';
import {
  reapAfterEachTest,
  trackGroupLeader,
  trackPidFile,
  trackProcess,
} from './support/process-reaper';
import { processAlive } from './support/process-state';
import { observe, until } from './support/until';

let root: string;
reapAfterEachTest();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stitchkit-owner-loss-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ownerFixture = fileURLToPath(
  new URL('./fixtures/native-owner-loss-owner.ts', import.meta.url),
);
const targetFixture = fileURLToPath(
  new URL('./fixtures/native-owner-loss-target.mjs', import.meta.url),
);

async function numberFile(name: string): Promise<number | undefined> {
  try {
    const value = Number(await readFile(join(root, name), 'utf8'));
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function marker(name: string): Promise<boolean> {
  try {
    await readFile(join(root, name));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function startOwner(mode: 'guarded' | 'unguarded', phase: string) {
  trackPidFile(join(root, 'target.pid'));
  trackPidFile(join(root, 'member.pid'));
  const owner = spawn(process.execPath, [ownerFixture, mode, phase, root, targetFixture], {
    stdio: 'ignore',
  });
  trackProcess(owner.pid);
  return owner;
}

test('without an owner-loss guard, SIGKILL of the caller leaves its detached command alive', async () => {
  const owner = startOwner('unguarded', 'after-initialize');
  await until(() => marker('initialized'), 'unguarded command initialization');
  const leader = await observe(() => numberFile('leader.pid'), 'unguarded group leader');
  const target = await observe(() => numberFile('target.pid'), 'unguarded target');
  const member = await observe(() => numberFile('member.pid'), 'unguarded descendant');
  expect(leader).toBe(target);
  trackGroupLeader({ pid: leader });
  const ownerPid = owner.pid;
  if (ownerPid === undefined) throw new Error('owner started without a pid');
  process.kill(ownerPid, 'SIGKILL');
  await until(() => !processAlive(ownerPid), 'unguarded owner death');
  expect(processAlive(target)).toBe(true);
  expect(processAlive(member)).toBe(true);
  process.kill(-leader, 'SIGKILL');
  await until(
    () => !processAlive(target) && !processAlive(member),
    'negative-control cleanup',
  );
});

async function proveOwnerLossPhase(
  phase: 'before-listen' | 'after-initialize' | 'hanging-rpc',
): Promise<void> {
  const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  if (neighbor.pid === undefined) throw new Error('neighbor started without a pid');
  trackGroupLeader({ pid: neighbor.pid });
  const owner = startOwner('guarded', phase);
  const leader = await observe(() => numberFile('leader.pid'), 'owner-loss guard leader');
  const target = await observe(() => numberFile('target.pid'), 'guarded target');
  const member = await observe(() => numberFile('member.pid'), 'guarded descendant');
  expect(leader).not.toBe(target);
  trackGroupLeader({ pid: leader });
  if (phase !== 'before-listen')
    await until(
      () => marker(phase === 'hanging-rpc' ? 'rpc' : 'initialized'),
      `guarded ${phase} marker`,
    );
  if (owner.pid === undefined) throw new Error('owner started without a pid');
  process.kill(owner.pid, 'SIGKILL');
  await until(
    () => !processAlive(leader) && !processAlive(target) && !processAlive(member),
    `owner-loss cleanup during ${phase}`,
  );
  expect(processAlive(neighbor.pid)).toBe(true);
}

test('ownerLoss terminates the complete group before the target listens', () =>
  proveOwnerLossPhase('before-listen'));

test('ownerLoss terminates the complete group after target initialization', () =>
  proveOwnerLossPhase('after-initialize'));

test('ownerLoss terminates the complete group during a hanging RPC', () =>
  proveOwnerLossPhase('hanging-rpc'));

test('ownerLoss preserves command output, exit status, deadlines and caller cancellation', async () => {
  const complete = await runNativeCommand({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('catalog');process.stderr.write('evidence');process.exit(7)",
    ],
    ownerLoss: 'terminate',
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 100,
  });
  expect(complete.exitCode).toBe(7);
  expect(new TextDecoder().decode(complete.stdout)).toBe('catalog');
  expect(new TextDecoder().decode(complete.stderr)).toBe('evidence');

  const inherited = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    ownerLoss: 'terminate',
    stdio: 'inherit',
    timeoutMs: 2000,
  });
  expect(inherited.exitCode).toBe(0);

  await expect(
    runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      ownerLoss: 'terminate',
      timeoutMs: 20,
      stop: { target: 'group', graceMs: 0 },
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_LIMIT', reason: 'deadline' });

  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  const cancelled = runNativeCommand({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
    ownerLoss: 'terminate',
    signal: controller.signal,
    stop: { target: 'group', graceMs: 0 },
    onOutput: () => controller.abort(reason),
  });
  await expect(cancelled).rejects.toBe(reason);
});

test('ownerLoss preserves a leader-target cooperative stop', async () => {
  const stopped = join(root, 'cooperative-stop');
  const controller = new AbortController();
  const reason = new Error('stop cooperatively');
  const pending = runNativeCommand({
    executable: process.execPath,
    args: [
      '-e',
      `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)`,
    ],
    ownerLoss: 'terminate',
    signal: controller.signal,
    stop: { target: 'leader', graceMs: 1000 },
    onOutput: () => controller.abort(reason),
  });
  await expect(pending).rejects.toBe(reason);
  expect(await readFile(stopped, 'utf8')).toBe('stopped');
});

test('ownerLoss refuses an unavailable target, caller groups and uncertified platforms', async () => {
  await expect(
    runNativeCommand({
      executable: '/nonexistent-stitchkit-owner-loss-command',
      ownerLoss: 'terminate',
      timeoutMs: 2000,
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
  expect(() =>
    runNativeCommand({
      executable: process.execPath,
      ownerLoss: 'terminate',
      group: 'caller',
      timeoutMs: 100,
    }),
  ).toThrow("ownerLoss: 'terminate' requires group: 'own'");
  expect(ownerLossAvailable('linux')).toBe(true);
  expect(ownerLossAvailable('darwin')).toBe(true);
  expect(ownerLossAvailable('win32')).toBe(false);
  expect(ownerLossAvailable('freebsd')).toBe(false);
});
