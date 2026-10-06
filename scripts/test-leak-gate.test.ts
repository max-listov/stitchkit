import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProcessStat } from './test-leak-gate';

const GATE = join(import.meta.dir, 'test-leak-gate.ts');
const hasProcfs = existsSync('/proc/self/stat') && process.platform === 'linux';

/** The real gate, as a child: it makes itself a subreaper, which must not leak into this test run. */
async function gate(script: string, env?: Record<string, string>) {
  const run = Bun.spawn(['bun', GATE, 'sh', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  return { stderr, exitCode };
}

/** Running means present and not a zombie: a killed process lingers as one until its reaper runs. */
function alive(pid: number): boolean {
  try {
    return parseProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8')).state !== 'Z';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

test('a process name with spaces and parentheses does not shift the stat fields', () => {
  expect(parseProcessStat('42 (we ird) name) S 7 42 99 0 -1 4194560')).toEqual({
    state: 'S',
    ppid: 7,
  });
  expect(() => parseProcessStat('42 (x)')).toThrow('Unreadable process stat');
});

test.skipIf(!hasProcfs)(
  'a clean command keeps its own exit code and reports nothing',
  async () => {
    expect(await gate('exit 3')).toEqual({ stderr: '', exitCode: 3 });
    expect(await gate('exit 0')).toEqual({ stderr: '', exitCode: 0 });
  },
);

// The negative control: a gate that has never seen a leak proves nothing about an empty report.
test.skipIf(!hasProcfs)(
  'a member left behind is named, killed, and fails a green command',
  async () => {
    const { stderr, exitCode } = await gate('sleep 31 >/dev/null 2>&1 </dev/null & exit 0');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('1 process(es) outlived');
    const pid = Number(/pid (\d+): sleep 31/.exec(stderr)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    const deadline = performance.now() + 2000;
    while (alive(pid) && performance.now() < deadline) await Bun.sleep(10);
    expect(alive(pid)).toBe(false);
  },
);

test.skipIf(!hasProcfs)(
  'a holder that leaves its session and group is still found',
  async () => {
    const { stderr, exitCode } = await gate(
      'setsid -f sleep 32 >/dev/null 2>&1 </dev/null; exit 0',
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/pid \d+: sleep 32/);
  },
);

test.skipIf(!hasProcfs)(
  'a member that ends inside the settle window is not a leak',
  async () => {
    expect(await gate('sleep 0.3 >/dev/null 2>&1 </dev/null & exit 0')).toEqual({
      stderr: '',
      exitCode: 0,
    });
  },
);

test.skipIf(!hasProcfs)(
  'a failing command keeps its own code even when it also leaked',
  async () => {
    const { stderr, exitCode } = await gate('sleep 33 >/dev/null 2>&1 </dev/null & exit 7');
    expect(exitCode).toBe(7);
    expect(stderr).toMatch(/pid \d+: sleep 33/);
  },
);

test.skipIf(!hasProcfs)(
  'the children of a left-behind process die with it and are named too',
  async () => {
    const { stderr, exitCode } = await gate(
      "sh -c 'sleep 35 & wait' >/dev/null 2>&1 </dev/null & exit 0",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/2 process\(es\) outlived/);
    const pid = Number(/pid (\d+): sleep 35/.exec(stderr)?.[1]);
    expect(Number.isInteger(pid)).toBe(true);
    const deadline = performance.now() + 2000;
    while (alive(pid) && performance.now() < deadline) await Bun.sleep(10);
    expect(alive(pid)).toBe(false);
  },
);
