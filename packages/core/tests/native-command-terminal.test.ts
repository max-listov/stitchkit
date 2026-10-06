import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type NativeCommandOptions, runNativeCommand } from '../src/entrypoints/process';
import {
  NativeCommandOptionsSchema,
  type NativeCommandSettlement,
} from '../src/process/contract';
import { processAlive } from './support/process-state';

// The pseudo-terminal tests use util-linux `script -qec`; BSD `script` takes another syntax.
const UTIL_LINUX_SCRIPT = process.platform === 'linux' && Bun.which('script') !== null;

const PROBE = fileURLToPath(new URL('./fixtures/native-inherit-probe.ts', import.meta.url));

const pids: number[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0))
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Run the probe under a real pseudo-terminal (`script`) and return what the terminal showed. */
function underTerminal(stdio: 'pipe' | 'inherit', shell: string): string {
  const command = [process.execPath, PROBE, stdio, 'own', shell]
    .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
    .join(' ');
  const run = Bun.spawnSync(['script', '-qec', command, '/dev/null'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || run.stdout.toString());
  return run.stdout.toString();
}

describe("stdio: 'inherit'", () => {
  test.skipIf(!UTIL_LINUX_SCRIPT)(
    'a command sees the caller’s terminal as a terminal; a piped one does not',
    () => {
      const probe =
        'if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then echo on-tty; else echo off-tty; fi';
      expect(underTerminal('inherit', probe)).toContain('on-tty');
      expect(underTerminal('pipe', probe)).toContain('off-tty');
    },
    30_000,
  );

  test('the bytes go straight to the caller’s descriptors, and the result carries none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-inherit-'));
    roots.push(root);
    const sink = join(root, 'stdout');
    const run = Bun.spawn([process.execPath, PROBE, 'inherit', 'own', 'echo passthrough'], {
      stdout: Bun.file(sink),
      stderr: 'pipe',
    });
    expect(await run.exited).toBe(0);
    expect(await readFile(sink, 'utf8')).toBe('passthrough\n');
    const result = await runNativeCommand({
      executable: '/bin/sh',
      args: ['-c', 'exit 3'],
      timeoutMs: 5000,
      stdio: 'inherit',
    });
    expect(result).toMatchObject({ exitCode: 3, signal: null });
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(0);
  });

  test('an option that needs a pipe is refused by name', () => {
    const base = {
      executable: '/bin/sh',
      timeoutMs: 1000,
      stdio: 'inherit',
    } satisfies NativeCommandOptions;
    const refusals: { name: string; options: NativeCommandOptions }[] = [
      { name: 'capture', options: { ...base, capture: true, maxOutputBytes: 64 } },
      { name: 'onOutput', options: { ...base, onOutput: () => undefined } },
      { name: 'stdin', options: { ...base, stdin: new Uint8Array(1) } },
      { name: 'maxOutputBytes', options: { ...base, maxOutputBytes: 64 } },
      { name: 'drainTimeoutMs', options: { ...base, drainTimeoutMs: 100 } },
    ];
    for (const { name, options } of refusals)
      expect(() => runNativeCommand(options)).toThrow(
        `stdio: 'inherit' leaves no pipe for ${name}`,
      );
  });
});

function processGroup(pid: number): number {
  return Number(
    Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)])
      .stdout.toString()
      .trim(),
  );
}

describe("group: 'caller'", () => {
  test.skipIf(!UTIL_LINUX_SCRIPT)(
    'a Ctrl-C typed at the terminal reaches a command in the caller’s group, not one in its own',
    async () => {
      const interrupted = async (group: 'own' | 'caller') => {
        const shell = `trap 'echo got-int; exit 0' INT; echo ready; sleep 3 & wait`;
        const command = [process.execPath, PROBE, 'inherit', group, shell]
          .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
          .join(' ');
        const terminal = Bun.spawn(['script', '-qec', command, '/dev/null'], {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        let shown = '';
        const reading = (async () => {
          for await (const chunk of terminal.stdout) shown += new TextDecoder().decode(chunk);
        })();
        const deadline = performance.now() + 10_000;
        while (!shown.includes('ready') && performance.now() < deadline) await Bun.sleep(20);
        terminal.stdin.write('\x03');
        terminal.stdin.flush();
        await Promise.race([terminal.exited, Bun.sleep(6000)]);
        terminal.kill('SIGKILL');
        await reading.catch(() => undefined);
        return shown;
      };
      expect(await interrupted('caller')).toContain('got-int');
      expect(await interrupted('own')).not.toContain('got-int');
    },
    30_000,
  );

  test('the command joins the caller’s group; by default it leads one of its own', async () => {
    const leaderGroup = async (group: 'own' | 'caller') => {
      const result = await runNativeCommand({
        executable: '/bin/sh',
        args: ['-c', 'ps -o pgid= -p $$'],
        envPolicy: 'ambient',
        timeoutMs: 5000,
        capture: true,
        maxOutputBytes: 64,
        group,
      });
      return Number(new TextDecoder().decode(result.stdout).trim());
    };
    const caller = processGroup(process.pid);
    expect(await leaderGroup('caller')).toBe(caller);
    expect(await leaderGroup('own')).not.toBe(caller);
  });

  test('a stop signals only the leader, by the policy, and the caller survives it', async () => {
    const controller = new AbortController();
    const events: NativeCommandSettlement[] = [];
    const pending = runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      signal: controller.signal,
      group: 'caller',
      stop: { target: 'leader', signal: 'SIGINT', graceMs: 5000 },
      onLeaderStarted: () => controller.abort(new Error('operator stop')),
      onLeaderSettled: (event) => {
        events.push(event);
      },
    });
    await expect(pending).rejects.toThrow('operator stop');
    expect(events).toMatchObject([{ kind: 'stopped', signal: 'SIGINT', exitCode: null }]);
    expect(processAlive(process.pid)).toBe(true);
  });

  test('what the leader left behind is not the command’s to stop', async () => {
    const result = await runNativeCommand({
      executable: '/bin/sh',
      args: ['-c', 'sleep 30 >/dev/null 2>&1 </dev/null & echo $!'],
      timeoutMs: 5000,
      capture: true,
      maxOutputBytes: 64,
      group: 'caller',
    });
    const helper = Number(new TextDecoder().decode(result.stdout).trim());
    pids.push(helper);
    expect(result.descendantsStopped).toBe(false);
    expect(processAlive(helper)).toBe(true);
  });

  test('a group stop and a descendants policy are refused: there is no group to act on', () => {
    expect(() =>
      runNativeCommand({
        executable: '/bin/sh',
        timeoutMs: 1000,
        group: 'caller',
        stop: { target: 'group', graceMs: 0 },
      }),
    ).toThrow("group: 'caller' stops only the leader");
    const policies: NonNullable<NativeCommandOptions['descendants']>[] = [
      'leave',
      'terminate-after-leader',
    ];
    for (const descendants of policies)
      expect(() =>
        runNativeCommand({
          executable: '/bin/sh',
          timeoutMs: 1000,
          group: 'caller',
          descendants,
        }),
      ).toThrow('descendants does not apply');
    expect(
      NativeCommandOptionsSchema.parse({
        executable: '/bin/sh',
        timeoutMs: 1000,
        group: 'caller',
      }).stop,
    ).toEqual({ target: 'leader', signal: 'SIGTERM', graceMs: 100 });
  });
});

describe('the leader of a stopped command', () => {
  test('settles as stopped, with the stop’s cause and the signal the kernel reported', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const events: NativeCommandSettlement[] = [];
    const pending = runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      signal: controller.signal,
      stop: { target: 'group', signal: 'SIGTERM', graceMs: 2000 },
      onLeaderStarted: () => controller.abort(reason),
      onLeaderSettled: (event) => {
        events.push(event);
      },
    });
    await expect(pending).rejects.toBe(reason);
    expect(events).toEqual([
      { kind: 'stopped', cause: reason, exitCode: null, signal: 'SIGTERM' },
    ]);
  });

  test('a leader that cannot start still settles as error: no exit was ever observed', async () => {
    const events: NativeCommandSettlement[] = [];
    await expect(
      runNativeCommand({
        executable: '/nonexistent/command',
        timeoutMs: 1000,
        onLeaderSettled: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
    expect(events.map((event) => event.kind)).toEqual(['error']);
  });

  test('a leader that ended on its own settles as exit even when the drain is then stopped', async () => {
    const events: NativeCommandSettlement[] = [];
    // The leader exits 0 at once; its helper holds the pipe until the deadline stops the drain.
    await runNativeCommand({
      executable: '/bin/sh',
      args: ['-c', 'sleep 30 & exit 0'],
      timeoutMs: 500,
      descendants: 'leave',
      onLeaderSettled: (event) => {
        events.push(event);
      },
    }).catch(() => undefined);
    expect(events).toEqual([{ kind: 'exit', exitCode: 0, signal: null }]);
  });
});
