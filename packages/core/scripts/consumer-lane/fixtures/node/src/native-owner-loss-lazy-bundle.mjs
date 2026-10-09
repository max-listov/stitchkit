import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const root = isolatedDirectory();
const groups = new Set();
const pids = new Set();

function isolatedDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-lazy-owner-loss-'));
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules'))) {
      throw new Error(`${at} carries node_modules, so the bundle is not isolated`);
    }
    if (dirname(at) === at) break;
  }
  return directory;
}

function build(source, name) {
  const directory = join(root, name);
  mkdirSync(directory);
  const output = join(directory, 'app.js');
  execFileSync(
    process.execPath,
    ['build', join(sourceRoot, source), '--target=bun', `--outfile=${output}`],
    { stdio: 'pipe' },
  );
  assert.deepEqual(readdirSync(directory), ['app.js']);
  return output;
}

function run(path, args) {
  return execFileSync(process.execPath, [path, ...args], { encoding: 'utf8' });
}

function alive(pid) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    });
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

function kill(target) {
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function startOwner(bundle, directory, mode, phase) {
  const owner = spawn(process.execPath, [bundle, 'owner', mode, phase, directory], {
    stdio: 'ignore',
  });
  if (owner.pid === undefined) throw new Error('bundled owner started without a pid');
  pids.add(owner.pid);
  return owner.pid;
}

try {
  const lazy = build('native-owner-loss-lazy-app.ts', 'lazy');
  const staticEntry = build('native-owner-loss-static-app.ts', 'static');
  const noBootstrap = build('native-owner-loss-lazy-no-bootstrap.ts', 'negative-control');

  assert.equal(run(lazy, ['probe']).trim(), 'lazy owner-loss probe: ok');
  assert.equal(run(staticEntry, ['probe']).trim(), 'static owner-loss probe: ok');

  const forbiddenTarget = join(root, 'negative-target-started');
  const negative = spawnSync(process.execPath, [noBootstrap, 'probe', forbiddenTarget], {
    encoding: 'utf8',
  });
  assert.equal(negative.status, 23);
  assert.match(negative.stderr, /COMMAND_UNAVAILABLE/);
  assert.equal(existsSync(forbiddenTarget), false);

  const negativeRoot = join(root, 'unguarded');
  mkdirSync(negativeRoot);
  const unguardedOwner = startOwner(lazy, negativeRoot, 'unguarded', 'after-initialize');
  await waitFor(
    () => existsSync(join(negativeRoot, 'initialized')),
    'negative initialization',
  );
  const unguardedLeader = await waitFor(
    () => numberFile(negativeRoot, 'leader.pid'),
    'negative leader',
  );
  const unguardedTarget = await waitFor(
    () => numberFile(negativeRoot, 'target.pid'),
    'negative target',
  );
  const unguardedMember = await waitFor(
    () => numberFile(negativeRoot, 'member.pid'),
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
    const owner = startOwner(lazy, directory, 'guarded', phase);
    const leader = await waitFor(
      () => numberFile(directory, 'leader.pid'),
      `${phase} guard leader`,
    );
    const target = await waitFor(() => numberFile(directory, 'target.pid'), `${phase} target`);
    const member = await waitFor(
      () => numberFile(directory, 'member.pid'),
      `${phase} descendant`,
    );
    assert.notEqual(leader, target);
    groups.add(leader);
    pids.add(target);
    pids.add(member);
    if (phase !== 'before-listen') {
      await waitFor(
        () => existsSync(join(directory, phase === 'hanging-rpc' ? 'rpc' : 'initialized')),
        `${phase} marker`,
      );
    }
    kill(owner);
    await waitFor(
      () => !alive(leader) && !alive(target) && !alive(member),
      `${phase} complete group cleanup`,
    );
    assert.equal(alive(neighbor.pid), true);
  }

  console.log('packed lazy owner-loss bundle: ok');
} finally {
  for (const group of groups) kill(-group);
  for (const pid of pids) kill(pid);
  rmSync(root, { recursive: true, force: true });
}
