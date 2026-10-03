import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

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
      await stopCommandGroup(2147483600, 40, 100);
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
    await stopCommandGroup(2147483600, 0, 40, true);
    assert.equal(calls, 1);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const cause = Object.assign(new Error('permission refused'), { code: 'EPERM' });
    process.kill = () => { throw cause; };
    const raw = Date.now;
    const timer = setTimeout(() => { Date.now = () => raw() + 200; }, 5);
    const start = performance.now();
    await assert.rejects(stopCommandGroup(2147483600, 0, 40, true), (error) => error === cause);
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

test('numeric PGID signaling cannot distinguish synthetic full-disappearance and reuse between signals', () => {
  const entry = new URL('../src/process/group.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { stopCommandGroup } from ${JSON.stringify(entry)};
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
    await stopCommandGroup(2147483600, 40, 100);
    assert.deepEqual(delivered, [['SIGTERM', 'owned'], ['SIGKILL', 'unrelated']]);
    console.log('synthetic PGID reuse boundary: ok');
  `;
  const result = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 4096,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('synthetic PGID reuse boundary: ok');
});
