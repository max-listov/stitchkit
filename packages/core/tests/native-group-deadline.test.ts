import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { stopCommandGroup } from '../src/process/group';

/*
 * The isolated programs below replace `process.kill`, `Date.now` and `process.platform` to drive
 * kernel answers a healthy host never gives (a clock that jumps, EPERM from Darwin, an id reused
 * between two signals). Real-process counterparts live elsewhere: the grace budget of a stubborn
 * child is measured in `native-command.test.ts` ("command grace and cleanup options control their
 * native budgets"), a descendant that survives its leader in `native-command-descendants.test.ts`,
 * and a group the kernel really no longer has is the last test of this file.
 */
const Samples = z.array(
  z.strictObject({
    skew: z.number(),
    elapsed: z.number(),
    signals: z.array(z.string()),
  }),
);

test('group grace ignores forward and backward wall-clock changes in an isolated process', () => {
  const entry = new URL('../src/process/group.ts', import.meta.url).href;
  const script = `
    import { stopCommandGroup } from ${JSON.stringify(entry)};
    const raw = Date.now;
    const samples = [];
    for (const skew of [0, -200, 200]) {
      const signals = [];
      process.kill = (_pid, signal) => { if (signal !== 0) signals.push(signal); return true; };
      Date.now = raw;
      const timer = setTimeout(() => { Date.now = () => raw() + skew; }, 5);
      const start = performance.now();
      await stopCommandGroup({
        pid: 2147483600,
        policy: { target: 'group', signal: 'SIGTERM', graceMs: 40 },
        cleanupTimeoutMs: 100,
        force: false,
      });
      clearTimeout(timer);
      samples.push({ skew, elapsed: performance.now() - start, signals });
    }
    console.log(JSON.stringify(samples));
  `;
  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4096,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const samples = Samples.parse(JSON.parse(result.stdout));
  expect(samples).toHaveLength(3);
  for (const sample of samples) {
    expect(sample.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(sample.elapsed).toBeGreaterThanOrEqual(30);
    expect(sample.elapsed).toBeLessThan(180);
  }
});

test('forced cleanup retains ESRCH success and the exact persistent Darwin permission cause', () => {
  const entry = new URL('../src/process/group.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { stopCommandGroup } from ${JSON.stringify(entry)};
    let calls = 0;
    process.kill = () => { calls++; throw Object.assign(new Error('absent'), { code: 'ESRCH' }); };
    const forced = {
      pid: 2147483600,
      policy: { target: 'group', signal: 'SIGTERM', graceMs: 0 },
      cleanupTimeoutMs: 40,
      force: true,
    };
    await stopCommandGroup(forced);
    assert.equal(calls, 1);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const cause = Object.assign(new Error('permission refused'), { code: 'EPERM' });
    process.kill = () => { throw cause; };
    const raw = Date.now;
    const timer = setTimeout(() => { Date.now = () => raw() + 200; }, 5);
    const start = performance.now();
    await assert.rejects(stopCommandGroup(forced), (error) => error === cause);
    clearTimeout(timer);
    assert.ok(performance.now() - start >= 30);
    assert.ok(performance.now() - start < 180);
    console.log('isolated group refusal controls: ok');
  `;
  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4096,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('isolated group refusal controls: ok');
});

test('an observed ESRCH ends the stop: no SIGKILL reaches a group id that may now be unrelated', () => {
  const entry = new URL('../src/process/group.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { stopCommandGroup } from ${JSON.stringify(entry)};
    // The group vanishes between TERM and the existence probe, and its id is reused at once.
    let recipient = 'owned';
    const delivered = [];
    process.kill = (_pid, signal) => {
      if (signal === 0) {
        recipient = 'unrelated';
        throw Object.assign(new Error('complete disappearance before reuse'), { code: 'ESRCH' });
      }
      delivered.push([signal, recipient]);
      return true;
    };
    const stop = {
      pid: 2147483600,
      policy: { target: 'group', signal: 'SIGTERM', graceMs: 40 },
      cleanupTimeoutMs: 100,
      force: false,
    };
    await stopCommandGroup(stop);
    assert.deepEqual(delivered, [['SIGTERM', 'owned']]);
    // The group is already gone when TERM is sent: nothing follows the ESRCH.
    const signals = [];
    process.kill = (_pid, signal) => {
      signals.push(signal);
      throw Object.assign(new Error('absent'), { code: 'ESRCH' });
    };
    await stopCommandGroup(stop);
    assert.deepEqual(signals, ['SIGTERM']);
    console.log('ESRCH ends group stop: ok');
  `;
  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4096,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('ESRCH ends group stop: ok');
});

test('a real group that is already gone ends the stop at once, without waiting out the grace', async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('Child did not start');
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  const began = performance.now();
  await stopCommandGroup({
    pid,
    policy: { target: 'group', signal: 'SIGTERM', graceMs: 5_000 },
    cleanupTimeoutMs: 10_000,
    force: false,
  });
  expect(performance.now() - began).toBeLessThan(1_000);
});
