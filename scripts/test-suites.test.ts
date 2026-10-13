import { expect, test } from 'bun:test';
import { runSuites, type Suite, suites } from './test-suites';

test('the core shards cover 1..N of N and every package suite is present', () => {
  const all = suites(4);
  const shards = all.flatMap((suite) =>
    suite.command.filter((part) => part.startsWith('--shard=')),
  );
  expect(shards).toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
  expect(all.map((suite) => suite.name)).toContain('stitchkit-tui');
  expect(all.map((suite) => suite.name)).toContain('create-stitchkit');
  expect(all.map((suite) => suite.name)).toContain('scripts');
});

test('every suite runs, a failure does not stop the others, and the width is kept', async () => {
  let active = 0;
  let widest = 0;
  const all: Suite[] = Array.from({ length: 6 }, (_, index) => ({
    name: `suite ${index}`,
    command: [],
  }));
  const results = await runSuites(all, 3, async (suite) => {
    active += 1;
    widest = Math.max(widest, active);
    await Bun.sleep(2);
    active -= 1;
    return { name: suite.name, code: suite.name === 'suite 1' ? 1 : 0, seconds: 0 };
  });
  expect(results.map((result) => result.name).sort()).toEqual(all.map((suite) => suite.name));
  expect(results.filter((result) => result.code !== 0).map((result) => result.name)).toEqual([
    'suite 1',
  ]);
  expect(widest).toBe(3);
});
