import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  NODE_QUEUE_ACTIVE_ENV,
  NODE_QUEUE_DISABLE_ENV,
  parseNodeQueueArgs,
  planNodeQueueExecution,
  supportsHostNodeQueue,
} from './node-queue';
import { verifyQueueLabel } from './verify';

const ROOT = join(import.meta.dir, '..');
const NODE_QUEUE_SCRIPT = join(import.meta.dir, 'node-queue.ts');
const VERIFY_SCRIPT = join(import.meta.dir, 'verify.ts');
const TEST_SUITES_SCRIPT = join(import.meta.dir, 'test-suites.ts');

const createdDirs: string[] = [];

afterEach(() => {
  for (const directory of createdDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

function writeExecutable(directory: string, name: string, source: string): string {
  const target = join(directory, name);
  writeFileSync(target, source, 'utf8');
  chmodSync(target, 0o755);
  return target;
}

/** Clean environment with isolated PATH and without inherited node-queue markers. */
function isolatedEnv(extraPathDirs: readonly string[], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[NODE_QUEUE_ACTIVE_ENV];
  delete env[NODE_QUEUE_DISABLE_ENV];
  const bunDir = dirname(process.execPath);
  const pathParts = [...extraPathDirs, bunDir, '/usr/bin', '/bin'];
  return { ...env, PATH: pathParts.join(':'), ...extra };
}

async function runProcess(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...argv], {
    cwd: ROOT,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Fake compatible `devkit` binary that records every `run` call and execs the wrapped command. */
function installFakeCompatibleDevkit(binDir: string, logPath: string): string {
  const runner = `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' 'Usage: devkit run --label <name> [--project <id>] [--kind <kind>] -- <command> [args...]'
  exit 0
fi
if [ "$1" = "run" ]; then
  "${process.execPath}" -e 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n");' "${logPath}" "$@"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then
      shift
      break
    fi
    shift
  done
  exec "$@"
fi
exit 2
`;
  return writeExecutable(binDir, 'devkit', runner);
}

describe('planNodeQueueExecution and argument parsing', () => {
  test('runs directly when devkit is missing from PATH', () => {
    let probed = false;
    const plan = planNodeQueueExecution({
      label: 'stitchkit-check',
      kind: 'quality',
      command: ['bun', 'run', 'check:scripts'],
      env: {},
      which: () => null,
      probe: () => {
        probed = true;
        return true;
      },
    });
    expect(plan).toEqual({ mode: 'direct' });
    expect(probed).toBe(false);
  });

  test('runs directly when devkit binary does not support the queue protocol', () => {
    const plan = planNodeQueueExecution({
      label: 'stitchkit-check',
      kind: 'quality',
      command: ['bun', 'run', 'check:scripts'],
      env: {},
      which: () => '/opt/bin/devkit',
      probe: () => false,
    });
    expect(plan).toEqual({ mode: 'direct' });
  });

  test('delegates through devkit run when binary is compatible', () => {
    const plan = planNodeQueueExecution({
      label: 'stitchkit-verify-fast',
      kind: 'verify',
      command: ['bun', 'scripts/verify.ts', '--fast'],
      env: { HOME: '/home/example-user', PATH: '/opt/bin:/usr/bin' },
      which: () => '/opt/bin/devkit',
      probe: () => true,
    });
    expect(plan).toEqual({
      mode: 'queued',
      argv: [
        '/opt/bin/devkit',
        'run',
        '--label',
        'stitchkit-verify-fast',
        '--project',
        'stitchkit',
        '--kind',
        'verify',
        '--',
        'bun',
        'scripts/verify.ts',
        '--fast',
      ],
      env: {
        HOME: '/home/example-user',
        PATH: '/opt/bin:/usr/bin',
        [NODE_QUEUE_ACTIVE_ENV]: '1',
      },
    });
  });

  test('omits --kind when not supplied and respects explicit opt-out and re-entrancy markers', () => {
    const withoutKind = planNodeQueueExecution({
      label: 'stitchkit-custom',
      command: ['bun', '-e', '0'],
      env: {},
      which: () => '/opt/bin/devkit',
      probe: () => true,
    });
    expect(withoutKind).toEqual({
      mode: 'queued',
      argv: [
        '/opt/bin/devkit',
        'run',
        '--label',
        'stitchkit-custom',
        '--project',
        'stitchkit',
        '--',
        'bun',
        '-e',
        '0',
      ],
      env: { [NODE_QUEUE_ACTIVE_ENV]: '1' },
    });

    let lookedUp = false;
    const which = () => {
      lookedUp = true;
      return '/opt/bin/devkit';
    };
    expect(
      planNodeQueueExecution({
        label: 'stitchkit-nested',
        kind: 'test',
        command: ['bun', 'test'],
        env: { [NODE_QUEUE_ACTIVE_ENV]: '1' },
        which,
        probe: () => true,
      }),
    ).toEqual({ mode: 'direct' });
    expect(
      planNodeQueueExecution({
        label: 'stitchkit-disabled',
        kind: 'test',
        command: ['bun', 'test'],
        env: { [NODE_QUEUE_DISABLE_ENV]: '0' },
        which,
        probe: () => true,
      }),
    ).toEqual({ mode: 'direct' });
    expect(lookedUp).toBe(false);
  });

  test('parses CLI options before -- and preserves wrapped command flags verbatim', () => {
    expect(
      parseNodeQueueArgs([
        '--label',
        'stitchkit-check',
        '--kind=quality',
        '--',
        'bun',
        'scripts/verify.ts',
        '--label',
        'inner',
      ]),
    ).toEqual({
      label: 'stitchkit-check',
      kind: 'quality',
      command: ['bun', 'scripts/verify.ts', '--label', 'inner'],
    });
    expect(() => parseNodeQueueArgs(['--kind', 'test', '--', 'bun', '-e', '1'])).toThrow(
      'Usage:',
    );
    expect(() =>
      parseNodeQueueArgs(['--label', 'x', '--kind', 'unknown', '--', 'bun', '-e', '1']),
    ).toThrow('invalid --kind');
    expect(() => parseNodeQueueArgs(['--label', 'x', '--'])).toThrow('Usage:');
    expect(() => parseNodeQueueArgs(['--label', 'x', 'bun', '-e', '1'])).toThrow(
      'unexpected argument',
    );
  });

  test('maps every verify profile flag to its dedicated queue label', () => {
    expect(verifyQueueLabel(new Set())).toBe('stitchkit-verify');
    expect(verifyQueueLabel(new Set(['--fast']))).toBe('stitchkit-verify-fast');
    expect(verifyQueueLabel(new Set(['--release']))).toBe('stitchkit-verify-release');
    expect(verifyQueueLabel(new Set(['--candidate']))).toBe('stitchkit-verify-candidate');
    expect(verifyQueueLabel(new Set(['--head']))).toBe('stitchkit-verify-head');
  });
});

describe('node-queue real-process behavior', () => {
  test('runs autonomously without devkit on PATH and preserves exit codes', async () => {
    const emptyBin = makeTempDir('sk-node-queue-empty-');
    const env = isolatedEnv([emptyBin]);
    const ok = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-smoke',
        '--kind',
        'test',
        '--',
        process.execPath,
        '-e',
        'console.log("active=" + process.env.STITCHKIT_NODE_QUEUE_ACTIVE)',
      ],
      env,
    );
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe('active=undefined');

    const fail = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-smoke',
        '--kind',
        'test',
        '--',
        process.execPath,
        '-e',
        'process.exit(7)',
      ],
      env,
    );
    expect(fail.exitCode).toBe(7);
  });

  test('delegates once through compatible devkit and skips re-queueing in nested calls', async () => {
    const scratch = makeTempDir('sk-node-queue-compat-');
    const logPath = join(scratch, 'devkit-calls.jsonl');
    installFakeCompatibleDevkit(scratch, logPath);
    const env = isolatedEnv([scratch]);

    const result = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-smoke',
        '--kind',
        'test',
        '--',
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-nested',
        '--kind',
        'quality',
        '--',
        process.execPath,
        '-e',
        'console.log("active=" + process.env.STITCHKIT_NODE_QUEUE_ACTIVE)',
      ],
      env,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('active=1');

    const calls = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'run',
      '--label',
      'stitchkit-smoke',
      '--project',
      'stitchkit',
      '--kind',
      'test',
      '--',
      process.execPath,
      NODE_QUEUE_SCRIPT,
      '--label',
      'stitchkit-nested',
      '--kind',
      'quality',
      '--',
      process.execPath,
      '-e',
      'console.log("active=" + process.env.STITCHKIT_NODE_QUEUE_ACTIVE)',
    ]);
  });

  test('ignores an incompatible devkit binary on PATH and runs autonomously', async () => {
    const scratch = makeTempDir('sk-node-queue-incompat-');
    const failingDevkit = writeExecutable(scratch, 'devkit', '#!/bin/sh\nexit 1\n');
    expect(supportsHostNodeQueue(failingDevkit)).toBe(false);

    const env = isolatedEnv([scratch]);
    const first = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-smoke',
        '--kind',
        'test',
        '--',
        process.execPath,
        '-e',
        'console.log("fallback-ok")',
      ],
      env,
    );
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout.trim()).toBe('fallback-ok');

    // A binary whose `run --help` exits 0 without --label/--project is also treated as unrelated.
    const unrelatedDevkit = writeExecutable(
      scratch,
      'devkit',
      '#!/bin/sh\necho "unrelated tool help"\nexit 0\n',
    );
    expect(supportsHostNodeQueue(unrelatedDevkit)).toBe(false);
  });

  test('verify.ts and test-suites.ts refuse invalid arguments before entering the node queue', async () => {
    const scratch = makeTempDir('sk-node-queue-validate-');
    const logPath = join(scratch, 'devkit-calls.jsonl');
    installFakeCompatibleDevkit(scratch, logPath);
    const env = isolatedEnv([scratch]);

    const badVerifyFlag = await runProcess([process.execPath, VERIFY_SCRIPT, '--bogus'], env);
    expect(badVerifyFlag.exitCode).not.toBe(0);
    expect(badVerifyFlag.stderr).toContain('Usage: verify.ts');

    const conflictVerify = await runProcess(
      [process.execPath, VERIFY_SCRIPT, '--fast', '--release'],
      env,
    );
    expect(conflictVerify.exitCode).not.toBe(0);
    expect(conflictVerify.stderr).toContain('select different gates');

    const badSuite = await runProcess(
      [process.execPath, TEST_SUITES_SCRIPT, 'nonexistent-suite'],
      env,
    );
    expect(badSuite.exitCode).not.toBe(0);
    expect(badSuite.stderr).toContain('no suite named nonexistent-suite');

    expect(existsSync(logPath)).toBe(false);
  });
});
