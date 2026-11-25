/**
 * The tests that depend on timing, run under a saturated CPU, several times.
 *
 * A test that waits on a deadline, a grace period or a process group passes on
 * an idle machine and fails beside another project's gate: the 80 ms process
 * cleanup budget, the native command owner, the idle provider deadline. Each
 * such failure arrived first as "flaky" in a release and took a session to tell
 * from a defect. This lane runs them on purpose under the load that produced
 * those failures — one busy worker per core — each file `--rerun-each` times, so
 * a timing bound that does not hold is found at night, not in a release.
 * A diagnostic lane: it qualifies timing bounds and certifies nothing.
 */
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

/** Files whose tests failed only under another gate's load; each named by its record. */
export const LOAD_SENSITIVE_TESTS = [
  // Process cleanup within its grace budget after the leader exits (2026-11-21).
  'tests/agent-coding-tools.test.ts',
  'tests/coding-shell-native-owner.test.ts',
  'tests/process-group-settlement.test.ts',
  // Native command and owner lifetimes, red beside another heavy gate under host load.
  'tests/native-command.test.ts',
  'tests/native-owner-uid.test.ts',
  // Deadlines measured against the wall clock.
  'tests/agent-runtime-idle-deadline.test.ts',
  'tests/abort-deadline-helpers.test.ts',
  'tests/native-command-deadline.test.ts',
  'tests/native-command-owner-loss.test.ts',
] as const;

export const LOAD_RERUNS = 5;
/** The longest a busy worker lives, whatever became of the lane that started it. */
export const LOAD_WORKER_MAX_MS = 30 * 60_000;

/**
 * One busy worker. It burns its core in short slices and looks at its parent between them:
 * a lane killed outright runs no `finally`, and a worker reparented to init ends itself
 * within one slice instead of holding a core of a shared host until someone finds it.
 */
export const LOAD_WORKER_SCRIPT = [
  'const owner = process.ppid;',
  `const deadline = Date.now() + ${LOAD_WORKER_MAX_MS};`,
  'for (;;) {',
  '  const slice = Date.now() + 200;',
  '  while (Date.now() < slice) {}',
  '  if (process.ppid !== owner || Date.now() > deadline) process.exit(0);',
  '}',
].join('\n');

/** One busy worker per core: the pressure measured when these tests failed (`some avg10` near 80). */
function startLoad(workers: number): Bun.Subprocess[] {
  return Array.from({ length: workers }, () =>
    Bun.spawn([process.execPath, '-e', LOAD_WORKER_SCRIPT], {
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  );
}

async function main(): Promise<number> {
  const core = join(import.meta.dir, '../packages/core');
  const workers = availableParallelism();
  const load = startLoad(workers);
  const stop = () => {
    for (const worker of load) worker.kill('SIGKILL');
  };
  let run: Bun.Subprocess | undefined;
  // A signal ends the lane, not only its load: the test run goes with it.
  const interrupt = () => {
    stop();
    run?.kill('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    process.stderr.write(
      `[load-lane] ${workers} busy workers, ${LOAD_SENSITIVE_TESTS.length} files, each run ${LOAD_RERUNS} times\n`,
    );
    run = Bun.spawn(
      // Through the leak gate the package's own `test` uses: a survivor or a file left in the
      // run's TMPDIR fails the run by name.
      [
        process.execPath,
        '../../scripts/test-leak-gate.ts',
        '--tmpdir',
        '--',
        process.execPath,
        'test',
        `--rerun-each=${LOAD_RERUNS}`,
        ...LOAD_SENSITIVE_TESTS,
      ],
      { cwd: core, stdout: 'inherit', stderr: 'inherit' },
    );
    return await run.exited;
  } finally {
    stop();
  }
}

if (import.meta.main) process.exit(await main());
