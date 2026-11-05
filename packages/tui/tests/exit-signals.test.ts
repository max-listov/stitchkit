import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dir, 'fixtures/exit-signal-app.tsx');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the fixture in a real pseudo-terminal and return its pid once it drew. */
async function start(mode: 'kit' | 'kit-owned' | 'bare') {
  const directory = mkdtempSync(join(tmpdir(), 'tui-exit-'));
  const pidFile = join(directory, 'pid');
  const shell = Bun.spawn(
    [
      'script',
      '-qec',
      `stty cols 80 rows 24; exec bun ${FIXTURE} ${mode} ${pidFile}`,
      '/dev/null',
    ],
    { cwd: join(import.meta.dir, '..'), stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
  );
  const deadline = performance.now() + 15_000;
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8') === '') {
    if (performance.now() > deadline) throw new Error(`${mode} fixture never started`);
    await Bun.sleep(25);
  }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  return {
    pid,
    /** Type into the terminal, as a person at the keyboard would. */
    async type(text: string) {
      shell.stdin.write(text);
      await shell.stdin.flush();
    },
    async stop() {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
      shell.kill('SIGKILL');
      await shell.exited;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function exitedWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return !alive(pid);
}

describe('a terminal application whose window closed', () => {
  test('exits within a second when it runs through runTerminalApp', async () => {
    const app = await start('kit');
    try {
      process.kill(app.pid, 'SIGHUP');
      expect(await exitedWithin(app.pid, 1000)).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  test('exits within a second on Ctrl-C, which raw mode delivers as a key', async () => {
    const app = await start('kit');
    try {
      // Give the screen a moment to mount its keyboard, as a person would.
      await Bun.sleep(300);
      await app.type('\x03');
      expect(await exitedWithin(app.pid, 1000)).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  test('exits on SIGQUIT, another signal OpenTUI catches', async () => {
    const app = await start('kit');
    try {
      process.kill(app.pid, 'SIGQUIT');
      expect(await exitedWithin(app.pid, 1000)).toBe(true);
    } finally {
      await app.stop();
    }
  }, 30_000);

  test('leaves signals to a host that owns the process and passes no exit signals', async () => {
    const app = await start('kit-owned');
    try {
      process.kill(app.pid, 'SIGHUP');
      expect(await exitedWithin(app.pid, 1500)).toBe(false);
    } finally {
      await app.stop();
    }
  }, 30_000);

  // OpenTUI listens for SIGHUP to restore the terminal, which cancels the default
  // exit: any timer then keeps a window-less process alive. This is the orphan.
  test('keeps running on OpenTUI alone (negative control)', async () => {
    const app = await start('bare');
    try {
      process.kill(app.pid, 'SIGHUP');
      expect(await exitedWithin(app.pid, 1500)).toBe(false);
    } finally {
      await app.stop();
    }
  }, 30_000);
});
