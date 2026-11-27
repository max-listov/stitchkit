import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeCommandError, runNativeCommand } from 'stitchkit/process';

const ownerFixture = fileURLToPath(new URL('./native-owner-loss-owner.mjs', import.meta.url));
const targetFixture = fileURLToPath(
  new URL('./native-owner-loss-target.mjs', import.meta.url),
);
// A guarded start is three cold Node processes in series (owner, guard, target), and the lane
// runs this proof beside other native proofs: its latency belongs to the host, not to the
// property under proof. The bound matches the owner's own command deadline, past which the
// target is stopped anyway. Cleanup after the owner's SIGKILL is the guarantee under proof and
// keeps its own short bound.
const START_BUDGET_MS = 30_000;
const CLEANUP_BUDGET_MS = 5_000;
const OUTPUT_TAIL_BYTES = 4096;
const root = mkdtempSync(join(tmpdir(), 'packed-owner-loss-'));
const groups = new Set();
const pids = new Set();
const startTimings = [];

function alive(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return state.trim() !== '' && !state.trim().startsWith('Z');
  } catch {
    return false;
  }
}

function listed(directory) {
  try {
    return readdirSync(directory).sort().join(', ') || 'empty';
  } catch (error) {
    return `unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
}

function ownerState(owner) {
  const exit =
    owner.exit === undefined
      ? `alive=${alive(owner.pid)}`
      : `exited code=${owner.exit.code} signal=${owner.exit.signal}`;
  const output = owner.output.trim();
  return `owner ${owner.pid} ${exit}; owner output: ${output === '' ? 'none' : output}`;
}

/**
 * Wait for a fixture fact. A start wait fails at once when its owner exits first, and every
 * failure names the elapsed time, the phase directory and the owner's exit and output.
 */
async function waitFor(read, what, { budgetMs, owner, directory }) {
  const started = Date.now();
  const deadline = started + budgetMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return { value, ms: Date.now() - started };
    const context = () =>
      [
        `after ${Date.now() - started} ms`,
        ...(directory === undefined ? [] : [`files: ${listed(directory)}`]),
        ...(owner === undefined ? [] : [ownerState(owner)]),
      ].join('; ');
    if (owner?.exit !== undefined)
      throw new Error(`Owner exited before ${what} (${context()})`);
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what} within ${budgetMs} ms (${context()})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function started(read, what, owner, directory) {
  const { value, ms } = await waitFor(read, what, {
    budgetMs: START_BUDGET_MS,
    owner,
    directory,
  });
  startTimings.push(`${what} ${ms} ms`);
  return value;
}

async function cleaned(read, what, directory) {
  await waitFor(read, what, { budgetMs: CLEANUP_BUDGET_MS, directory });
}

function numberFile(directory, name) {
  const path = join(directory, name);
  if (!existsSync(path)) return;
  const value = Number(readFileSync(path, 'utf8'));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function startOwner(directory, mode, phase) {
  const child = spawn(
    process.execPath,
    [ownerFixture, mode, phase, directory, targetFixture],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (child.pid === undefined) throw new Error('owner started without a pid');
  pids.add(child.pid);
  const owner = { pid: child.pid, exit: undefined, output: '' };
  const keep = (chunk) => {
    owner.output = (owner.output + chunk).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout.setEncoding('utf8').on('data', keep);
  child.stderr.setEncoding('utf8').on('data', keep);
  child.once('exit', (code, signal) => {
    owner.exit = { code, signal };
  });
  child.once('error', (error) => {
    keep(`spawn error: ${error.message}`);
    owner.exit = { code: null, signal: null };
  });
  return owner;
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
  const unguarded = startOwner(negative, 'unguarded', 'after-initialize');
  await started(
    () => existsSync(join(negative, 'initialized')),
    'negative initialization',
    unguarded,
    negative,
  );
  const unguardedLeader = await started(
    () => numberFile(negative, 'leader.pid'),
    'negative leader',
    unguarded,
    negative,
  );
  const unguardedTarget = await started(
    () => numberFile(negative, 'target.pid'),
    'negative target',
    unguarded,
    negative,
  );
  const unguardedMember = await started(
    () => numberFile(negative, 'member.pid'),
    'negative descendant',
    unguarded,
    negative,
  );
  assert.equal(unguardedLeader, unguardedTarget);
  groups.add(unguardedLeader);
  pids.add(unguardedTarget);
  pids.add(unguardedMember);
  kill(unguarded.pid);
  await cleaned(() => !alive(unguarded.pid), 'negative owner death', negative);
  assert.equal(alive(unguardedTarget), true);
  assert.equal(alive(unguardedMember), true);
  kill(-unguardedLeader);
  await cleaned(
    () => !alive(unguardedTarget) && !alive(unguardedMember),
    'negative cleanup',
    negative,
  );

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
    const leader = await started(
      () => numberFile(directory, 'leader.pid'),
      `${phase} leader`,
      owner,
      directory,
    );
    const target = await started(
      () => numberFile(directory, 'target.pid'),
      `${phase} target`,
      owner,
      directory,
    );
    const member = await started(
      () => numberFile(directory, 'member.pid'),
      `${phase} member`,
      owner,
      directory,
    );
    assert.notEqual(leader, target);
    groups.add(leader);
    pids.add(target);
    pids.add(member);
    if (phase !== 'before-listen')
      await started(
        () => existsSync(join(directory, phase === 'hanging-rpc' ? 'rpc' : 'initialized')),
        `${phase} phase`,
        owner,
        directory,
      );
    kill(owner.pid);
    await cleaned(
      () => !alive(leader) && !alive(target) && !alive(member),
      `${phase} complete group cleanup`,
      directory,
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

  console.log(`packed native owner loss start latency: ${startTimings.join(', ')}`);
  console.log('packed native owner loss: ok');
} finally {
  for (const group of groups) kill(-group);
  for (const pid of pids) kill(pid);
  rmSync(root, { recursive: true, force: true });
}
