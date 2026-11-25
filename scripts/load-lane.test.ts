import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOAD_RERUNS, LOAD_SENSITIVE_TESTS, LOAD_WORKER_SCRIPT } from './load-lane';

const root = join(import.meta.dir, '..');

test('the load lane names files that exist and runs each of them more than once', () => {
  for (const file of LOAD_SENSITIVE_TESTS)
    expect(existsSync(join(root, 'packages/core', file)), file).toBe(true);
  expect(LOAD_RERUNS).toBeGreaterThan(1);
});

test('the load lane runs at night and is not release evidence', () => {
  const load = readFileSync(join(root, '.github/workflows/load.yml'), 'utf8');
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  expect(load).toContain('schedule:');
  expect(load).not.toContain('push:');
  expect(load).toContain('bun run load-lane');
  // CI's required evidence never waits for it.
  expect(ci).not.toContain('load-lane');
});

test('every load-sensitive test file declares explicit timing bounds, and long process-group tests declare a test timeout', () => {
  const boundPattern =
    /\b(?:timeoutMs|shellTimeoutMs|idleTimeoutMs|FIXTURE_TIMEOUT_MS|createCommandDeadline|withSignalDeadline|withConnectionDeadline)\b/;
  for (const file of LOAD_SENSITIVE_TESTS) {
    const source = readFileSync(join(root, 'packages/core', file), 'utf8');
    expect(boundPattern.test(source), `${file} must declare an explicit timing bound`).toBe(
      true,
    );
  }
  // `kills owned descendants…` runs four sequential shell-limit scenarios whose combined waits can
  // approach Bun's default 5 s under CPU load; it must declare its own Bun test timeout.
  const codingTools = readFileSync(
    join(root, 'packages/core/tests/agent-coding-tools.test.ts'),
    'utf8',
  );
  const start = codingTools.indexOf(
    "test('kills owned descendants and bounds retained pipes on exit, timeout, abort and output limit'",
  );
  expect(start).toBeGreaterThan(-1);
  const end = codingTools.indexOf('\n  }\n', start);
  const block = codingTools.slice(start, end);
  expect(block).toMatch(/\}\s*,\s*(?:\{\s*timeout\s*:\s*\d[\d_]*\s*\}|\d[\d_]*)\s*\);/);
});

test('a busy worker ends itself when the lane that started it is killed', async () => {
  // The owner stands for the lane: it starts one worker, names it and waits to be killed.
  const owner = Bun.spawn(
    [
      process.execPath,
      '-e',
      [
        `const worker = Bun.spawn([process.execPath, '-e', ${JSON.stringify(LOAD_WORKER_SCRIPT)}], { stdout: 'ignore', stderr: 'ignore' });`,
        "process.stdout.write(String(worker.pid) + '\\n');",
        'await new Promise(() => {});',
      ].join('\n'),
    ],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const reader = owner.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  const workerPid = Number(new TextDecoder().decode(first.value).trim());
  expect(Number.isInteger(workerPid) && workerPid > 0).toBe(true);
  const alive = (): boolean => {
    try {
      process.kill(workerPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    expect(alive()).toBe(true);
    owner.kill('SIGKILL');
    await owner.exited;
    const deadline = Date.now() + 5_000;
    while (alive() && Date.now() < deadline) await Bun.sleep(50);
    expect(alive()).toBe(false);
  } finally {
    if (alive()) process.kill(workerPid, 'SIGKILL');
  }
}, 15_000);
