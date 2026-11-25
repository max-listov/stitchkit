import { expect, test } from 'bun:test';
import { z } from 'zod';
import { ORPHAN_LANE_TESTS, runSuites, type Suite, selectSuites, suites } from './test-suites';

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

/** The `test` script of each workspace package, by package name. */
async function packageTestScripts(): Promise<Map<string, string | undefined>> {
  const scripts = new Map<string, string | undefined>();
  for (const manifest of new Bun.Glob('packages/*/package.json').scanSync({
    cwd: `${import.meta.dir}/..`,
    absolute: true,
  })) {
    const parsed = z
      .object({ name: z.string(), scripts: z.record(z.string(), z.string()).optional() })
      .parse(await Bun.file(manifest).json());
    scripts.set(parsed.name, parsed.scripts?.test);
  }
  return scripts;
}

/**
 * The one suite that runs without the process half of the gate, and why: its lane tests prove
 * that orphans die once their parent is killed, which a subreaper adopting them would hide.
 */
const WITHOUT_PROCESS_CHECK = new Set(['scripts orphans']);

/** The test files a suite command names, as `scripts/x.test.ts`. */
const filesOf = (suite: Suite | undefined): string[] =>
  (suite?.command ?? [])
    .filter((part) => part.endsWith('.test.ts'))
    .map((part) => part.replace(/^\.\//, ''));

test('only the files that prove an orphan’s fate skip the process check; every other script test keeps it', () => {
  const all = suites(4);
  const scripts = all.find((suite) => suite.name === 'scripts');
  const orphans = all.find((suite) => suite.name === 'scripts orphans');
  expect(filesOf(orphans)).toEqual([...ORPHAN_LANE_TESTS]);
  expect(ORPHAN_LANE_TESTS).toEqual([
    'scripts/lane-processes.test.ts',
    'scripts/load-lane.test.ts',
  ]);
  const every = [
    ...new Bun.Glob('scripts/*.test.ts').scanSync({ cwd: `${import.meta.dir}/..` }),
  ];
  expect([...filesOf(scripts), ...filesOf(orphans)].sort()).toEqual(every.sort());
  expect(filesOf(scripts)).not.toContain('scripts/load-lane.test.ts');
  expect(scripts?.command).not.toContain('--no-process-check');
});

// A suite outside the gate would leave its temporary files and processes unseen again.
test('every suite runs under the leak gate with its own TMPDIR', async () => {
  const scripts = await packageTestScripts();
  for (const suite of suites(4)) {
    const command = suite.command.join(' ');
    const filtered = /^bun --filter (\S+) test\b/.exec(command)?.[1];
    const gated = filtered === undefined ? command : scripts.get(filtered);
    const options = WITHOUT_PROCESS_CHECK.has(suite.name)
      ? '--tmpdir --no-process-check'
      : '--tmpdir';
    expect({ suite: suite.name, gated }).toEqual({
      suite: suite.name,
      gated: expect.stringMatching(
        new RegExp(
          `^bun (\\.\\./\\.\\./)?scripts/test-leak-gate\\.ts ${options} -- bun test\\b`,
        ),
      ),
    });
  }
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

test('named suites run alone, as CI runs the repository scripts; an unknown name is refused', () => {
  const all = suites(4);
  expect(selectSuites(all, []).length).toBe(all.length);
  expect(selectSuites(all, ['scripts', 'scripts orphans']).map((suite) => suite.name)).toEqual(
    ['scripts', 'scripts orphans'],
  );
  expect(() => selectSuites(all, ['script'])).toThrow('no suite named script');
});
