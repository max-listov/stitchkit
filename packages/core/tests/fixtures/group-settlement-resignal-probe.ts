import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopCommandGroup } from '../../src/process/group';
import { GroupSettlementError } from '../../src/process/group-diagnostics';
import { GROUP_EXIT_QUICK_LOOKS } from '../../src/process/group-settlement';

const root = await mkdtemp(join(tmpdir(), 'group-resignal-'));
const ps = join(root, 'ps');
const originalPath = process.env.PATH;
const realKill = process.kill;
const realNow = performance.now;
const group = 2147483600;
const stop = {
  pid: group,
  policy: { target: 'group', signal: 'SIGTERM', graceMs: 0 },
  cleanupTimeoutMs: 2000,
  force: true,
} satisfies Parameters<typeof stopCommandGroup>[0];
// The first look, the quick looks before any snapshot, then the look after the snapshot.
const afterSnapshot = 2 + GROUP_EXIT_QUICK_LOOKS;
const absent = () => Object.assign(new Error('owned group gone'), { code: 'ESRCH' });
const table = (rows: string) =>
  writeFile(ps, `#!/bin/sh\nprintf '%s\\n' '${rows}'\n`, { mode: 0o755 });
process.env.PATH = `${root}:${originalPath}`;
try {
  await table(`${group} S<`);
  let kills = 0;
  let probes = 0;
  const track = (target: number, signal?: string | number) => {
    assert.equal(target, -group, 'signals stay inside the owned group');
    if (signal === 0) probes++;
    else {
      assert.equal(signal, 'SIGKILL');
      kills++;
    }
  };

  // A member surviving the first KILL is stopped by the second, within the same budget.
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 0 && kills === 2) throw absent();
    return true;
  };
  await stopCommandGroup(stop);
  assert.equal(kills, 2);

  // Fresh kernel absence overrides a live snapshot: never signal a possibly reused id.
  kills = probes = 0;
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 0 && probes === afterSnapshot) throw absent();
    return true;
  };
  await stopCommandGroup(stop);
  assert.equal(kills, 1);
  assert.equal(probes, afterSnapshot);

  // Absence within the quick looks ends the stop before any snapshot is taken.
  kills = probes = 0;
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 0 && probes === 2) throw absent();
    return true;
  };
  await table('this table would refuse the stop if it were read');
  await stopCommandGroup(stop);
  assert.equal(kills, 1);
  assert.equal(probes, 2);
  await table(`${group} S<`);

  // Absence at the repeated KILL is terminal too: no next probe or signal.
  kills = probes = 0;
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 'SIGKILL' && kills === 2) throw absent();
    return true;
  };
  await stopCommandGroup(stop);
  assert.equal(kills, 2);
  assert.equal(probes, afterSnapshot);

  // Dead members, invalid tables and failed observations never cause a blind re-signal.
  for (const rows of [`${group} Z\n${group} X`, 'invalid table', 'exit 73']) {
    kills = probes = 0;
    process.kill = (target, signal) => {
      track(target, signal);
      return true;
    };
    if (rows === 'exit 73') await writeFile(ps, '#!/bin/sh\nexit 73\n');
    else await table(rows);
    if (rows.includes(' Z')) await stopCommandGroup(stop);
    else
      await assert.rejects(stopCommandGroup(stop), (error: unknown) => {
        assert.ok(error instanceof GroupSettlementError);
        assert.ok(error.cause instanceof Error);
        return true;
      });
    assert.equal(kills, 1);
  }

  await table(`${group} S<`);
  // Persistent live states still hit the original absolute bound, with observations.
  let clock = 0;
  Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
  kills = probes = 0;
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 'SIGKILL' && kills === 3) clock = 2000;
    return true;
  };
  await assert.rejects(stopCommandGroup(stop), (error: unknown) => {
    assert.ok(error instanceof GroupSettlementError);
    assert.match(error.message, /"failure":"deadline"/);
    assert.match(error.message, /"lastStates":\["S<"\]/);
    return true;
  });
  assert.equal(kills, 3);

  // A ps snapshot using the last budget does not earn one signal beyond the deadline.
  clock = 0;
  kills = probes = 0;
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 0 && probes === afterSnapshot) clock = 2000;
    return true;
  };
  await assert.rejects(stopCommandGroup(stop), /settlement was not confirmed/);
  assert.equal(kills, 1);

  // A refused repeated signal keeps its exact cause; it is never interpreted as death.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  clock = 0;
  kills = probes = 0;
  const denied = Object.assign(new Error('repeat permission refused'), { code: 'EPERM' });
  process.kill = (target, signal) => {
    track(target, signal);
    if (signal === 'SIGKILL' && kills >= 2) {
      clock += 1000;
      throw denied;
    }
    return true;
  };
  await assert.rejects(stopCommandGroup(stop), (error: unknown) => {
    assert.ok(error instanceof GroupSettlementError);
    assert.equal(error.cause, denied);
    return true;
  });
  assert.equal(kills, 3, 'Darwin refusal retries inside the same deadline');
  assert.equal(clock, 2000);
  console.log('bounded live-group re-signal controls: ok');
} finally {
  process.kill = realKill;
  Object.defineProperty(performance, 'now', { value: realNow });
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
}
