/**
 * Every test suite of the repository, each in its own process, at once.
 *
 * The core suite is split by file into shards exactly as CI splits it (`--shard=N/4`), so one
 * slow file bounds a shard rather than the whole run. Each suite is an ordinary sequential
 * `bun test` under its own package script, so the leak gate still wraps the core shards. Output is
 * held per suite and printed whole when that suite ends, so parallel runs stay readable; any suite
 * that fails fails the step, and the summary names it.
 *
 * Usage: `bun scripts/test-suites.ts` (the root `test` script); `bun scripts/test-suites.ts scripts
 * 'scripts orphans'` runs the named suites only, as CI runs the repository scripts.
 */
import { availableParallelism } from 'node:os';

export const CORE_SHARDS = 4;

export interface Suite {
  readonly name: string;
  readonly command: readonly string[];
}

/**
 * The script tests that run without the process half of the leak gate: they prove that a
 * lane's orphans die once their parent is killed, by `kill(pid, 0)`, and under a subreaper a
 * dead orphan waits as the gate's unreaped child, which that probe still finds alive. Every
 * other script test keeps the whole gate.
 */
export const ORPHAN_LANE_TESTS: readonly string[] = [
  'scripts/lane-processes.test.ts',
  'scripts/load-lane.test.ts',
];

const SCRIPT_TESTS = [
  ...new Bun.Glob('scripts/*.test.ts').scanSync({ cwd: `${import.meta.dir}/..` }),
]
  .sort()
  .filter((file) => !ORPHAN_LANE_TESTS.includes(file));

const gatedScriptTests = (options: readonly string[], files: readonly string[]) => [
  'bun',
  'scripts/test-leak-gate.ts',
  ...options,
  '--',
  'bun',
  'test',
  ...files.map((file) => `./${file}`),
];

export function suites(shards = CORE_SHARDS): readonly Suite[] {
  return [
    ...Array.from({ length: shards }, (_, index) => ({
      name: `stitchkit ${index + 1}/${shards}`,
      command: ['bun', '--filter', 'stitchkit', 'test', `--shard=${index + 1}/${shards}`],
    })),
    { name: 'stitchkit-tui', command: ['bun', '--filter', 'stitchkit-tui', 'test'] },
    { name: 'create-stitchkit', command: ['bun', '--filter', 'create-stitchkit', 'test'] },
    // Explicit files: `bun test scripts/` is a substring filter and also matches the starter
    // template's own `scripts/` tests, which run in their template lane. Through the same leak
    // gate as the package suites, whose `test` scripts call it themselves.
    { name: 'scripts', command: gatedScriptTests(['--tmpdir'], SCRIPT_TESTS) },
    {
      name: 'scripts orphans',
      command: gatedScriptTests(['--tmpdir', '--no-process-check'], ORPHAN_LANE_TESTS),
    },
  ];
}

export interface SuiteResult {
  readonly name: string;
  readonly code: number;
  readonly seconds: number;
}

async function runSuite(suite: Suite, cwd: string): Promise<SuiteResult> {
  const started = performance.now();
  const child = Bun.spawn([...suite.command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = (performance.now() - started) / 1000;
  process.stdout.write(`\n[test] ── ${suite.name} ──\n${stdout}`);
  process.stderr.write(stderr);
  process.stderr.write(`[test] ${suite.name}: ${seconds.toFixed(1)}s, exit ${code}\n`);
  return { name: suite.name, code, seconds };
}

/** Run every suite, at most `width` at once; resolves with every result, never early. */
export async function runSuites(
  all: readonly Suite[],
  width: number,
  run: (suite: Suite) => Promise<SuiteResult>,
): Promise<readonly SuiteResult[]> {
  const queue = [...all];
  const results: SuiteResult[] = [];
  const worker = async (): Promise<void> => {
    for (let suite = queue.shift(); suite !== undefined; suite = queue.shift())
      results.push(await run(suite));
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, all.length)) }, worker));
  return results;
}

/** The suites named on the command line, every suite without names; an unknown name is refused. */
export function selectSuites(
  all: readonly Suite[],
  names: readonly string[],
): readonly Suite[] {
  if (names.length === 0) return all;
  const unknown = names.filter((name) => !all.some((suite) => suite.name === name));
  if (unknown.length > 0)
    throw new Error(
      `[test] no suite named ${unknown.join(', ')}; suites: ${all.map((suite) => suite.name).join(', ')}`,
    );
  return all.filter((suite) => names.includes(suite.name));
}

if (import.meta.main) {
  const root = `${import.meta.dir}/..`;
  const chosen = selectSuites(suites(), process.argv.slice(2));
  const results = await runSuites(chosen, availableParallelism(), (suite) =>
    runSuite(suite, root),
  );
  const failed = results.filter((result) => result.code !== 0);
  process.stderr.write(
    `[test] ${results.length - failed.length}/${results.length} suites passed${
      failed.length > 0 ? `; failed: ${failed.map((result) => result.name).join(', ')}` : ''
    }\n`,
  );
  process.exit(failed.length > 0 ? 1 : 0);
}
