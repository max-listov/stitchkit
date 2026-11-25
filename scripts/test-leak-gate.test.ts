import { expect, test } from 'bun:test';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMissingProcess, parseGateArguments, parseProcessStat } from './test-leak-gate';
import { describeTempResidue, RUN_TEMP_PREFIX, runTempBase } from './test-temp-residue';

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

/** What a process still is, for a failure that must name its cause; undefined once it is gone. */
function survivor(pid: number): { state: string; ppid: number; wchan: string } | undefined {
  try {
    const { state, ppid } = parseProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (state === 'Z') return undefined;
    return { state, ppid, wchan: readFileSync(`/proc/${pid}/wchan`, 'utf8') };
  } catch (error) {
    if (isMissingProcess(error)) return undefined;
    throw error;
  }
}

/** Running means present and not a zombie: a killed process lingers as one until its reaper runs. */
function alive(pid: number): boolean {
  return survivor(pid) !== undefined;
}

test('a process name with spaces and parentheses does not shift the stat fields', () => {
  expect(parseProcessStat('42 (we ird) name) S 7 42 99 0 -1 4194560')).toEqual({
    state: 'S',
    ppid: 7,
  });
  expect(() => parseProcessStat('42 (x)')).toThrow('Unreadable process stat');
});

test('only process disappearance errors count as missing, never an unreadable process', () => {
  for (const code of ['ENOENT', 'ESRCH'])
    expect(isMissingProcess(Object.assign(new Error('gone'), { code }))).toBe(true);
  for (const code of ['EACCES', 'EIO', 'EMFILE'])
    expect(isMissingProcess(Object.assign(new Error('unreadable'), { code }))).toBe(false);
  expect(isMissingProcess(new Error('unknown read failure'))).toBe(false);
  expect(isMissingProcess({ code: 'ESRCH' })).toBe(false);
});

test.skipIf(!hasProcfs)(
  'a retired procfs descriptor returns ESRCH after a real process exits',
  async () => {
    const child = Bun.spawn(['sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'] });
    let descriptor: number | undefined;
    try {
      descriptor = openSync(`/proc/${child.pid}/stat`, 'r');
      expect(alive(child.pid)).toBe(true);
      child.kill('SIGKILL');
      await child.exited;
      let failure: unknown;
      try {
        readFileSync(descriptor, 'utf8');
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'ESRCH' });
      expect(isMissingProcess(failure)).toBe(true);
      expect(alive(child.pid)).toBe(false);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  },
);

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
    expect(survivor(pid)).toBeUndefined();
  },
);

test.skipIf(!hasProcfs)(
  'a process that is still there is described, not just reported',
  () => {
    expect(survivor(process.pid)).toEqual({
      state: expect.stringMatching(/^[A-Za-z]$/),
      ppid: process.ppid,
      wchan: expect.any(String),
    });
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

/** The real gate with `--tmpdir`, as a child; stdout carries what the command saw. */
async function tmpdirGate(script: string) {
  const run = Bun.spawn(['bun', GATE, '--tmpdir', '--', 'sh', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  // The not-measurable line of a host without a subreaper is not about temporary files.
  return {
    stdout,
    stderr: stderr.replace(/^\[test-gate\] process leak check not measurable.*\n/m, ''),
    exitCode,
  };
}

test('the gate reads its options before the command, and only before it', () => {
  expect(parseGateArguments(['bun', 'test'])).toEqual({
    tmpdir: false,
    noProcessCheck: false,
    command: ['bun', 'test'],
  });
  expect(parseGateArguments(['--tmpdir', '--', 'bun', 'test', '--tmpdir'])).toEqual({
    tmpdir: true,
    noProcessCheck: false,
    command: ['bun', 'test', '--tmpdir'],
  });
  expect(parseGateArguments(['--tmpdir', '--no-process-check', '--', 'bun', 'test'])).toEqual({
    tmpdir: true,
    noProcessCheck: true,
    command: ['bun', 'test'],
  });
  expect(() => parseGateArguments(['--tmpdir', '--'])).toThrow('Usage');
});

test('a clean command gets an empty TMPDIR of its own, as open as /tmp, removed after it', async () => {
  const { stdout, stderr, exitCode } = await tmpdirGate(
    'echo "$TMPDIR"; ls -A "$TMPDIR" | wc -l; ls -ld "$TMPDIR"; mkdir "$TMPDIR/own"; rmdir "$TMPDIR/own"',
  );
  expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 });
  const [directory, count, listing] = stdout.trim().split('\n');
  expect(directory?.startsWith(join(runTempBase(), RUN_TEMP_PREFIX))).toBe(true);
  expect(count?.trim()).toBe('0');
  expect(listing).toStartWith('drwxrwxrwt');
  expect(existsSync(directory ?? '/')).toBe(false);
});

// The negative control: an empty report from a gate that never saw residue proves nothing.
test('what a green command leaves in its TMPDIR is named, removed, and fails the run', async () => {
  const { stdout, stderr, exitCode } = await tmpdirGate(
    'echo "$TMPDIR"; mkdir "$TMPDIR/stitchkit-left-ab12"; : > "$TMPDIR/stitchkit-left-ab12/state.json"; : > "$TMPDIR/loose.sqlite"; exit 0',
  );
  expect(exitCode).toBe(1);
  expect(stderr).toContain('2 temporary entries left in the run');
  expect(stderr).toContain('  loose.sqlite (file)\n');
  expect(stderr).toContain('  stitchkit-left-ab12/ (1 entry)\n');
  expect(existsSync(stdout.trim())).toBe(false);
});

test('a failing command keeps its own code when it also left a temporary file', async () => {
  const { stderr, exitCode } = await tmpdirGate(': > "$TMPDIR/left"; exit 7');
  expect(exitCode).toBe(7);
  expect(stderr).toContain('1 temporary entry left');
  expect(stderr).toContain('  left (file)\n');
});

test('residue is described by kind and capped, so a large leak stays readable', () => {
  const many = Array.from({ length: 45 }, (_, index) => ({
    name: `stitchkit-spool-${index}`,
    kind: 'directory' as const,
    entries: 1,
  }));
  const report = describeTempResidue(many, 'bun test');
  expect(report).toContain('45 temporary entries');
  expect(report).toContain('  … and 5 more');
  expect(
    report.split('\n').filter((line) => line.startsWith('  stitchkit-spool-')),
  ).toHaveLength(40);
});
