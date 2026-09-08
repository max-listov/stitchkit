import { expect, test } from 'bun:test';
import {
  availableMemoryGib,
  chooseHeavyConcurrency,
  HEAVY_LANE_MEMORY_GIB,
  runBounded,
  startMemoryFloor,
} from './verify';

test('bounded release lanes never exceed the declared local concurrency', async () => {
  let active = 0;
  let peak = 0;
  const completed: string[] = [];
  await runBounded(['a', 'b', 'c', 'd', 'e'], 2, async (step) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    completed.push(step);
    active -= 1;
  });
  expect(peak).toBe(2);
  expect(completed.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
});

test('a failing lane is named before its siblings are cancelled', async () => {
  // The whole point: in a backgrounded run the only visible evidence used to be
  // a cluster of SIGTERM lines, which reads as the job being killed from
  // outside. Three release runs were misread that way.
  const lines: string[] = [];
  await expect(
    runBounded(
      ['ok', 'boom'],
      1,
      async (step) => {
        if (step === 'boom') throw new Error('`bun run boom` exited with 1');
      },
      (line) => lines.push(line),
    ),
  ).rejects.toThrow('exited with 1');
  expect(lines[0]).toContain('boom FAILED');
  expect(lines[0]).toContain('exited with 1');
  expect(lines.join('')).toContain('cancelling the other heavy lanes');
});

test('a failing lane reports the memory floor it ran through', async () => {
  // Why the number is here at all: the one failure this gate has produced was
  // read as an out-of-memory kill, and a reproduction with 7.1 GiB to spare
  // said otherwise. The floor turns that question into a line of output.
  const lines: string[] = [];
  const samples = [9.5, 6.25, 8.1];
  await expect(
    runBounded(
      ['boom'],
      1,
      async () => {
        throw new Error('`bun run boom` exited with 1');
      },
      (line) => lines.push(line),
      () => {
        let lowest = Number.POSITIVE_INFINITY;
        for (const sample of samples) lowest = Math.min(lowest, sample);
        return () => lowest;
      },
    ),
  ).rejects.toThrow('exited with 1');
  expect(lines.join('')).toContain('memory floor while the lanes ran: 6.25 GiB available');
});

test('an unmeasurable host says so instead of printing a number', async () => {
  // The third outcome. "Could not measure" printed as a figure would be a
  // measurement that never happened.
  const lines: string[] = [];
  await expect(
    runBounded(
      ['boom'],
      1,
      async () => {
        throw new Error('boom');
      },
      (line) => lines.push(line),
      () => () => undefined,
    ),
  ).rejects.toThrow('boom');
  expect(lines.join('')).toContain('not measurable on this host');
  expect(lines.join('')).not.toContain('GiB available');
});

test('the floor keeps the lowest sample, not the last', async () => {
  const readings = [9, 4.5, 7];
  let index = 0;
  const stop = startMemoryFloor(() => readings[Math.min(index++, readings.length - 1)], 1);
  while (index < readings.length) await Bun.sleep(2);
  await Bun.sleep(2);
  // 9 first, then 4.5, then 7: the answer is the dip, not where it ended.
  expect(stop()).toBe(4.5);
});

test('a host with no memory reading never starts a sampler', () => {
  let calls = 0;
  const stop = startMemoryFloor(() => {
    calls += 1;
    return undefined;
  }, 1);
  expect(stop()).toBeUndefined();
  expect(calls).toBe(1);
});

test('a lane that succeeds reports nothing', () => {
  // The negative half: a reporter that fires on success would bury the one line
  // that matters.
  const lines: string[] = [];
  const ran: string[] = [];
  return runBounded(
    ['a', 'b'],
    2,
    async (step) => {
      ran.push(step);
    },
    (line) => lines.push(line),
  ).then(() => {
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(lines).toEqual([]);
  });
});

test('an explicit setting wins over any measurement', () => {
  // Both directions: the variable is not overridden by a host that could afford
  // more, nor by one that could afford less.
  expect(chooseHeavyConcurrency('2', () => 1).concurrency).toBe(2);
  expect(chooseHeavyConcurrency('1', () => 64).concurrency).toBe(1);
  expect(chooseHeavyConcurrency('4', () => 64).concurrency).toBe(4);
  expect(chooseHeavyConcurrency('2', () => 1).because).toContain('VERIFY_HEAVY_CONCURRENCY=2');
});

test('a setting that is not a positive integer is refused, not defaulted', () => {
  expect(() => chooseHeavyConcurrency('two', () => 64)).toThrow('positive integer');
  expect(() => chooseHeavyConcurrency('0', () => 64)).toThrow('positive integer');
  expect(() => chooseHeavyConcurrency('1.5', () => 64)).toThrow('positive integer');
});

test('memory decides only when nobody has', () => {
  // Measured on the host this was written for: one heavy lane holds ~3.3 GiB,
  // and 5.8 GiB available is where the pair started timing out.
  // `undefined` selects the parameter default, which reads the operator's own
  // VERIFY_HEAVY_CONCURRENCY and turned this test red under a real override;
  // the empty string is the explicit "not set".
  expect(chooseHeavyConcurrency('', () => 5.8).concurrency).toBe(1);
  expect(chooseHeavyConcurrency('', () => 8).concurrency).toBe(2);
  // The boundary itself, from both sides, so the threshold is a decision and
  // not an accident of the two numbers above.
  expect(chooseHeavyConcurrency('', () => HEAVY_LANE_MEMORY_GIB * 2).concurrency).toBe(2);
  expect(chooseHeavyConcurrency('', () => HEAVY_LANE_MEMORY_GIB * 2 - 0.1).concurrency).toBe(
    1,
  );
  // Never zero, however little is left.
  expect(chooseHeavyConcurrency('', () => 0.1).concurrency).toBe(1);
  // Never more than the ceiling, however much there is.
  expect(chooseHeavyConcurrency('', () => 512).concurrency).toBe(2);
});

test('a host that cannot be measured keeps the historical default and says so', () => {
  const choice = chooseHeavyConcurrency('', () => undefined);
  expect(choice.concurrency).toBe(2);
  expect(choice.because).toContain('could not be read');
});

test('available memory is read from MemAvailable, and unreadable is not zero', () => {
  const meminfo =
    'MemTotal:       23000000 kB\nMemFree:         1000000 kB\nMemAvailable:    6082560 kB\n';
  expect(availableMemoryGib(meminfo)).toBeCloseTo(5.8, 1);
  // A file without the field is "unknown", not "none": returning 0 would silently
  // pin every host to one lane.
  expect(availableMemoryGib('MemTotal: 23000000 kB\n')).toBeUndefined();
  expect(availableMemoryGib('')).toBeUndefined();
});
