import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCommandError, runNativeCommand } from 'stitchkit/process';

const ownerFixture = fileURLToPath(new URL('./native-owner-loss-owner.mjs', import.meta.url));
const targetFixture = fileURLToPath(
  new URL('./native-owner-loss-target.mjs', import.meta.url),
);
const root = mkdtempSync(join(tmpdir(), 'packed-owner-loss-'));
const groups = new Set();
const pids = new Set();

function alive(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return state.trim() !== '' && !state.trim().startsWith('Z');
  } catch {
    return false;
  }
}

async function waitFor(read, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function numberFile(directory, name) {
  const path = join(directory, name);
  if (!existsSync(path)) return;
  const value = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function startOwner(directory, mode, phase) {
  const owner = spawn(
    process.execPath,
    [ownerFixture, mode, phase, directory, targetFixture],
    {
      stdio: 'ignore',
    },
  );
  if (owner.pid === undefined) throw new Error('owner started without a pid');
  pids.add(owner.pid);
  return owner.pid;
}

function kill(target) {
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

try {
  const negative = join(root, 'negative');
  mkdirSync(negative);
  const unguardedOwner = startOwner(negative, 'unguarded', 'after-initialize');
  await waitFor(() => existsSync(join(negative, 'initialized')), 'negative initialization');
  const unguardedLeader = await waitFor(
    () => numberFile(negative, 'leader.pid'),
    'negative leader',
  );
  const unguardedTarget = await waitFor(
    () => numberFile(negative, 'target.pid'),
    'negative target',
  );
  const unguardedMember = await waitFor(
    () => numberFile(negative, 'member.pid'),
    'negative descendant',
  );
  assert.equal(unguardedLeader, unguardedTarget);
  groups.add(unguardedLeader);
  pids.add(unguardedTarget);
  pids.add(unguardedMember);
  kill(unguardedOwner);
  await waitFor(() => !alive(unguardedOwner), 'negative owner death');
  assert.equal(alive(unguardedTarget), true);
  assert.equal(alive(unguardedMember), true);
  kill(-unguardedLeader);
  await waitFor(() => !alive(unguardedTarget) && !alive(unguardedMember), 'negative cleanup');

  const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  if (neighbor.pid === undefined) throw new Error('neighbor started without a pid');
  groups.add(neighbor.pid);

  for (const phase of ['before-listen', 'after-initialize', 'hanging-rpc']) {
    const directory = join(root, phase);
    mkdirSync(directory);
    const owner = startOwner(directory, 'guarded', phase);
    const leader = await waitFor(() => numberFile(directory, 'leader.pid'), `${phase} leader`);
    const target = await waitFor(() => numberFile(directory, 'target.pid'), `${phase} target`);
    const member = await waitFor(() => numberFile(directory, 'member.pid'), `${phase} member`);
    assert.notEqual(leader, target);
    groups.add(leader);
    pids.add(target);
    pids.add(member);
    if (phase !== 'before-listen')
      await waitFor(
        () => existsSync(join(directory, phase === 'hanging-rpc' ? 'rpc' : 'initialized')),
        `${phase} phase`,
      );
    kill(owner);
    await waitFor(
      () => !alive(leader) && !alive(target) && !alive(member),
      `${phase} complete group cleanup`,
    );
    assert.equal(alive(neighbor.pid), true);
  }

  const provider = await runNativeCommand({
    executable: process.execPath,
    args: [
      '-e',
      "process.stdout.write('catalog');process.stderr.write('provider');process.exit(7)",
    ],
    ownerLoss: 'terminate',
    timeoutMs: 2000,
    capture: true,
    maxOutputBytes: 100,
  });
  assert.equal(provider.exitCode, 7);
  assert.equal(new TextDecoder().decode(provider.stdout), 'catalog');
  assert.equal(new TextDecoder().decode(provider.stderr), 'provider');

  const inherited = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    ownerLoss: 'terminate',
    stdio: 'inherit',
    timeoutMs: 2000,
  });
  assert.equal(inherited.exitCode, 0);

  await assert.rejects(
    runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      ownerLoss: 'terminate',
      timeoutMs: 20,
      stop: { target: 'group', graceMs: 0 },
    }),
    (error) =>
      error instanceof NativeCommandError &&
      error.code === 'COMMAND_LIMIT' &&
      error.reason === 'deadline',
  );

  const controller = new AbortController();
  const cancellation = new Error('packed owner cancelled');
  await assert.rejects(
    runNativeCommand({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('ready');setInterval(()=>{},1000)"],
      ownerLoss: 'terminate',
      signal: controller.signal,
      stop: { target: 'group', graceMs: 0 },
      onOutput: () => controller.abort(cancellation),
    }),
    (error) => error === cancellation,
  );

  const cooperativeMarker = join(root, 'cooperative-stop');
  const cooperative = new AbortController();
  const cooperativeReason = new Error('packed cooperative stop');
  await assert.rejects(
    runNativeCommand({
      executable: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(cooperativeMarker)},'stopped');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)`,
      ],
      ownerLoss: 'terminate',
      signal: cooperative.signal,
      stop: { target: 'leader', graceMs: 1000 },
      onOutput: () => cooperative.abort(cooperativeReason),
    }),
    (error) => error === cooperativeReason,
  );
  assert.equal(readFileSync(cooperativeMarker, 'utf8'), 'stopped');

  await assert.rejects(
    runNativeCommand({
      executable: '/nonexistent-packed-owner-loss-target',
      ownerLoss: 'terminate',
      timeoutMs: 2000,
    }),
    (error) => error instanceof NativeCommandError && error.code === 'COMMAND_UNAVAILABLE',
  );

  console.log('packed native owner loss: ok');
} finally {
  for (const group of groups) kill(-group);
  for (const pid of pids) kill(pid);
  rmSync(root, { recursive: true, force: true });
}
