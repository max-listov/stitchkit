import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  NODE_QUEUE_ACTIVE_ENV,
  NODE_QUEUE_DISABLE_ENV,
  parseNodeQueueArgs,
  parseNodeQueueStepSpec,
  planNodeQueueStepsExecution,
  probeHostNodeQueue,
} from './node-queue';
import { buildVerifyStepPlan } from './verify-profiles';

const ROOT = join(import.meta.dir, '..');
const NODE_QUEUE_SCRIPT = join(import.meta.dir, 'node-queue.ts');

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

function isolatedEnv(extraPathDirs: readonly string[], extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env[NODE_QUEUE_ACTIVE_ENV];
  delete env[NODE_QUEUE_DISABLE_ENV];
  const bunDir = dirname(process.execPath);
  return { ...env, PATH: [...extraPathDirs, bunDir, '/usr/bin', '/bin'].join(':'), ...extra };
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

describe('node-queue step-plan (--plan -) support', () => {
  test('parses --step specifications and rejects mixing --step with --', () => {
    expect(parseNodeQueueStepSpec('stitchkit check::bun --filter stitchkit check')).toEqual({
      name: 'stitchkit check',
      argv: ['bun', '--filter', 'stitchkit', 'check'],
    });
    expect(
      parseNodeQueueArgs([
        '--label',
        'stitchkit-check',
        '--kind',
        'quality',
        '--step',
        'one::bun -e 1',
        '--step',
        'two::bun -e 2',
      ]),
    ).toEqual({
      label: 'stitchkit-check',
      kind: 'quality',
      steps: [
        { name: 'one', argv: ['bun', '-e', '1'] },
        { name: 'two', argv: ['bun', '-e', '2'] },
      ],
    });
    expect(() => parseNodeQueueStepSpec('missing-separator')).toThrow('expected --step');
    expect(() =>
      parseNodeQueueArgs(['--label', 'x', '--step', 'a::bun -e 0', '--', 'bun', '-e', '0']),
    ).toThrow('mutually exclusive');
  });

  test('tokenizes --step commands with single quotes, double quotes, escapes and spaces, and refuses malformed quotes', () => {
    expect(parseNodeQueueStepSpec(`eval::bun -e 'console.log("hello world")'`)).toEqual({
      name: 'eval',
      argv: ['bun', '-e', 'console.log("hello world")'],
    });
    expect(
      parseNodeQueueStepSpec(
        `quoted::"/opt/my tools/bun" -e "console.log('a \\"b\\" \\\\ c')" ""`,
      ),
    ).toEqual({
      name: 'quoted',
      argv: ['/opt/my tools/bun', '-e', `console.log('a "b" \\ c')`, ''],
    });
    expect(parseNodeQueueStepSpec('escaped::bun /tmp/my\\ dir/script.ts --flag=val')).toEqual({
      name: 'escaped',
      argv: ['bun', '/tmp/my dir/script.ts', '--flag=val'],
    });

    // Negative controls: unterminated quotes, trailing escape and empty executable are refused.
    expect(() => parseNodeQueueStepSpec(`bad::bun -e 'unterminated`)).toThrow(
      /unterminated ' quote/,
    );
    expect(() => parseNodeQueueStepSpec('bad::bun -e "unterminated')).toThrow(
      /unterminated " quote/,
    );
    expect(() => parseNodeQueueStepSpec('bad::bun trailing\\')).toThrow(/trailing backslash/);
    expect(() => parseNodeQueueStepSpec('bad::"" -e 1')).toThrow(/invalid --step value/);
  });

  test('plans queued-plan when host supports --plan, falls back to queued without --plan, and direct without devkit', () => {
    const steps = [
      { name: 'first', argv: ['bun', '-e', '1'] as [string, ...string[]] },
      { name: 'second', argv: ['bun', '-e', '2'] as [string, ...string[]] },
    ];
    const withPlan = planNodeQueueStepsExecution({
      label: 'stitchkit-build',
      kind: 'build',
      steps,
      fallbackCommand: ['bun', 'scripts/node-queue.ts'],
      env: {},
      which: () => '/opt/bin/devkit',
      probe: () => ({ supported: true, supportsPlan: true }),
    });
    expect(withPlan).toEqual({
      mode: 'queued-plan',
      argv: [
        '/opt/bin/devkit',
        'run',
        '--label',
        'stitchkit-build',
        '--project',
        'stitchkit',
        '--kind',
        'build',
        '--plan',
        '-',
      ],
      plan: { schema: 'run-step-plan/v1', steps },
      env: { [NODE_QUEUE_ACTIVE_ENV]: '1' },
    });

    const olderHost = planNodeQueueStepsExecution({
      label: 'stitchkit-build',
      kind: 'build',
      steps,
      fallbackCommand: ['bun', 'scripts/node-queue.ts'],
      env: {},
      which: () => '/opt/bin/devkit',
      probe: () => ({ supported: true, supportsPlan: false }),
    });
    expect(olderHost.mode).toBe('queued');

    const disabled = planNodeQueueStepsExecution({
      label: 'stitchkit-build',
      kind: 'build',
      steps,
      env: { [NODE_QUEUE_DISABLE_ENV]: '0' },
      which: () => '/opt/bin/devkit',
      probe: () => ({ supported: true, supportsPlan: true }),
    });
    expect(disabled).toEqual({ mode: 'direct-steps', steps });
  });

  test('buildVerifyStepPlan keeps sequential steps individual and preserves heavy-lane concurrency', () => {
    const fast = buildVerifyStepPlan({
      root: '/repo',
      sequential: ['lockfile', 'lint', 'build', 'check', 'test'],
      heavy: [],
      heavyConcurrency: 2,
      runtime: 'bun',
    });
    expect(fast.map((step) => step.name)).toEqual([
      'lockfile',
      'lint',
      'build',
      'check',
      'test',
    ]);
    expect(fast[0]?.argv).toEqual(['bun', 'run', 'lockfile']);
    expect(fast[2]?.argv).toEqual(['bun', 'run', 'build']);
    expect(fast[3]?.argv).toEqual([
      'bun',
      '/repo/scripts/verify.ts',
      '--internal-step',
      'check',
      '--built',
    ]);

    const fullSingle = buildVerifyStepPlan({
      root: '/repo',
      sequential: ['lockfile', 'build'],
      heavy: ['smoke:node', 'consumer-lane'],
      heavyConcurrency: 1,
      runtime: 'bun',
    });
    expect(fullSingle.map((step) => step.name)).toEqual([
      'lockfile',
      'build',
      'smoke:node',
      'consumer-lane',
    ]);

    const fullParallel = buildVerifyStepPlan({
      root: '/repo',
      sequential: ['lockfile', 'build'],
      heavy: ['smoke:node', 'consumer-lane'],
      heavyConcurrency: 2,
      runtime: 'bun',
    });
    expect(fullParallel.map((step) => step.name)).toEqual([
      'lockfile',
      'build',
      'heavy-lanes',
    ]);
    expect(fullParallel[2]?.argv).toEqual([
      'bun',
      '/repo/scripts/verify.ts',
      '--internal-heavy',
      '2',
      '--built',
      '--',
      'smoke:node',
      'consumer-lane',
    ]);

    const fullAuto = buildVerifyStepPlan({
      root: '/repo',
      sequential: ['lockfile', 'build'],
      heavy: ['smoke:node', 'consumer-lane'],
      heavyConcurrency: 'auto',
      runtime: 'bun',
    });
    expect(fullAuto.map((step) => step.name)).toEqual(['lockfile', 'build', 'heavy-lanes']);
    expect(fullAuto[2]?.argv).toEqual([
      'bun',
      '/repo/scripts/verify.ts',
      '--internal-heavy',
      'auto',
      '--built',
      '--',
      'smoke:node',
      'consumer-lane',
    ]);
  });
});

describe('node-queue step-plan real-process execution', () => {
  test('delegates --step plan via --plan - stdin on compatible devkit and runs directly without devkit', async () => {
    const scratch = makeTempDir('sk-node-queue-plan-');
    const capturedPath = join(scratch, 'captured.json');
    const devkitPath = writeExecutable(
      scratch,
      'devkit',
      `#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' 'Usage: devkit run --label <name> [--project <id>] [--kind <kind>] (--plan <file.json|-> | -- <command>)'
  exit 0
fi
if [ "$1" = "run" ]; then
  "${process.execPath}" -e '
    import { writeFileSync } from "node:fs";
    const stdin = await new Response(Bun.stdin.stream()).text();
    writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), plan: JSON.parse(stdin), active: process.env.STITCHKIT_NODE_QUEUE_ACTIVE }));
  ' "${capturedPath}" "$@"
  exit 0
fi
exit 2
`,
    );
    expect(probeHostNodeQueue(devkitPath)).toEqual({ supported: true, supportsPlan: true });

    const queued = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-check',
        '--kind',
        'quality',
        '--step',
        `first::${process.execPath} -e console.log(1)`,
        '--step',
        `second::${process.execPath} -e console.log(2)`,
      ],
      isolatedEnv([scratch]),
    );
    expect(queued.exitCode, queued.stderr).toBe(0);
    const captured = JSON.parse(readFileSync(capturedPath, 'utf8'));
    expect(captured.active).toBe('1');
    expect(captured.args).toEqual([
      'run',
      '--label',
      'stitchkit-check',
      '--project',
      'stitchkit',
      '--kind',
      'quality',
      '--plan',
      '-',
    ]);
    expect(captured.plan).toEqual({
      schema: 'run-step-plan/v1',
      steps: [
        { name: 'first', argv: [process.execPath, '-e', 'console.log(1)'] },
        { name: 'second', argv: [process.execPath, '-e', 'console.log(2)'] },
      ],
    });

    // Without devkit on PATH, --step executes sequentially and stops on the first failing step.
    const emptyBin = makeTempDir('sk-node-queue-no-devkit-');
    const direct = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-check',
        '--kind',
        'quality',
        '--step',
        `first::${process.execPath} -e 'console.log("step 1")'`,
        '--step',
        `second::${process.execPath} -e 'console.log("step 2")'`,
      ],
      isolatedEnv([emptyBin]),
    );
    expect(direct.exitCode, direct.stderr).toBe(0);
    expect(direct.stdout.trim().split('\n')).toEqual(['step 1', 'step 2']);

    const failing = await runProcess(
      [
        process.execPath,
        NODE_QUEUE_SCRIPT,
        '--label',
        'stitchkit-check',
        '--kind',
        'quality',
        '--step',
        `first::${process.execPath} -e process.exit(9)`,
        '--step',
        `second::${process.execPath} -e 'console.log("should-not-run")'`,
      ],
      isolatedEnv([emptyBin]),
    );
    expect(failing.exitCode).toBe(9);
    expect(failing.stdout).not.toContain('should-not-run');
  });
});
