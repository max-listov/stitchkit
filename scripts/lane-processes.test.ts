import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonedLaneProcesses,
  assertNothingSurvives,
  stopProcessGroup,
  supervisorPidIn,
  sweepAbandonedLaneProcesses,
} from './lane-processes';

const hasProcfs = existsSync('/proc/self/cwd');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(check: () => boolean, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !check()) await Bun.sleep(50);
}

/** A wrapper that starts a role and then does nothing — `bun run`, in miniature. */
async function laneDirectoryWithARole(): Promise<{
  directory: string;
  wrapper: ReturnType<typeof Bun.spawn>;
  rolePid: number;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
  await writeFile(
    join(directory, 'role.ts'),
    ['console.log(process.pid);', 'setInterval(() => {}, 1000);'].join('\n'),
  );
  await writeFile(
    join(directory, 'wrapper.ts'),
    [
      "const role = Bun.spawn(['bun', 'role.ts'], { cwd: import.meta.dir, stdout: 'inherit' });",
      "console.log('wrapper ' + role.pid);",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const wrapper = Bun.spawn(['bun', 'wrapper.ts'], {
    cwd: directory,
    detached: true,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  // The role prints its own pid; the wrapper prints the pid it spawned.
  const reader = wrapper.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!/^\d+$/m.test(seen) || !/wrapper \d+/.test(seen)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  reader.releaseLock();
  const rolePid = Number(/^(\d+)$/m.exec(seen)?.[1]);
  return { directory, wrapper, rolePid };
}

test.skipIf(!hasProcfs)(
  'stopping the group reaps the role behind the launcher, not only the launcher',
  async () => {
    const { directory, wrapper, rolePid } = await laneDirectoryWithARole();
    try {
      expect(alive(rolePid)).toBe(true);

      await stopProcessGroup(wrapper);

      await settle(() => !alive(rolePid));
      // Signalling the child alone leaves this one running: that is the whole
      // shape of the incident — a dead wrapper and a live role.
      expect(alive(rolePid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a run sweeps what a SIGKILLed predecessor left inside a deleted directory',
  async () => {
    const { directory, wrapper, rolePid } = await laneDirectoryWithARole();
    // SIGKILL is the one exit no handler survives — the OOM killer's signal.
    // The wrapper dies, the role does not, and the directory goes away.
    wrapper.kill('SIGKILL');
    await wrapper.exited;
    await rm(directory, { recursive: true, force: true });

    expect(alive(rolePid)).toBe(true);
    expect(await abandonedLaneProcesses()).toContain(rolePid);

    const swept = await sweepAbandonedLaneProcesses();

    expect(swept).toBeGreaterThan(0);
    await settle(() => !alive(rolePid));
    expect(alive(rolePid)).toBe(false);
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a signal to the lane itself reaps what it started',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
    try {
      await writeFile(
        join(directory, 'role.ts'),
        ['console.log(process.pid);', 'setInterval(() => {}, 1000);'].join('\n'),
      );
      // A lane in miniature: it registers the same handler the real ones do.
      await writeFile(
        join(directory, 'lane.ts'),
        [
          `import { reapOnTermination, stopProcessGroup } from ${JSON.stringify(join(import.meta.dir, 'lane-processes.ts'))};`,
          "const role = Bun.spawn(['bun', 'role.ts'], { cwd: import.meta.dir, detached: true, stdout: 'inherit' });",
          'reapOnTermination(() => stopProcessGroup(role));',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const lane = Bun.spawn(['bun', 'lane.ts'], {
        cwd: directory,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const reader = lane.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!/^\d+$/m.test(seen)) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
      reader.releaseLock();
      const rolePid = Number(/^(\d+)$/m.exec(seen)?.[1]);
      expect(alive(rolePid)).toBe(true);

      // Interrupting a lane is the run that used to leave the most behind: a
      // `finally` covers a throw, and a signal is not a throw.
      lane.kill('SIGTERM');
      await lane.exited;

      await settle(() => !alive(rolePid));
      expect(alive(rolePid)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'finishing with a survivor is a failure, not a warning',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
    try {
      await writeFile(join(directory, 'role.ts'), 'setInterval(() => {}, 1000);');
      const role = Bun.spawn(['bun', 'role.ts'], {
        cwd: directory,
        detached: true,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      try {
        await settle(() => alive(role.pid));
        await expect(assertNothingSurvives(directory)).rejects.toThrow(/still running inside/);
      } finally {
        await stopProcessGroup(role);
      }
      await expect(assertNothingSurvives(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

/**
 * A supervisor daemon is found by asking the daemon, not by trusting the
 * command that was supposed to kill it.
 *
 * The supervised lane ignored the exit codes of `pm2 delete` and `pm2 kill`,
 * and its survivor scan looked at working directories — which a daemon does not
 * share with the tree it supervises. So the lane could finish GREEN with a
 * daemon still running and still restarting its roles.
 */
test.skipIf(!hasProcfs)(
  'a live daemon named by its pid file is detected',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'supervised-lane-'));
    try {
      // No pid file at all is the ordinary "no daemon" answer.
      expect(await supervisorPidIn(home)).toBeUndefined();

      const child = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      try {
        await writeFile(join(home, 'pm2.pid'), `${child.pid}\n`);
        expect(await supervisorPidIn(home)).toBe(child.pid);
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }

      // Once it is gone the SAME pid file must report nothing — otherwise the
      // check turns every clean run red and gets switched off.
      await settle(() => !alive(child.pid));
      expect(await supervisorPidIn(home)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
