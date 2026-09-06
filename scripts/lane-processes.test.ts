import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  abandonedLaneProcesses,
  assertNothingSurvives,
  reapProcessesUnder,
  stopProcessGroup,
  supervisorPidIn,
  sweepAbandonedLaneProcesses,
  sweepAbandonedTemporaryDirectories,
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

/**
 * A lane clears its own tree, not only the groups it spawned.
 *
 * The role process groups cover the roles. They do not cover the other things
 * that run in the same directory — a database engine, a browser a test run left
 * behind. CI found exactly one such survivor and the fail-closed assertion
 * reported it, which is the assertion working; this is the sweep that keeps it
 * from firing on the lane's own leftovers.
 */
test.skipIf(!hasProcfs)(
  'a process living in the lane tree is reaped, not only refused',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
    try {
      await writeFile(join(directory, 'stray.ts'), 'setInterval(() => {}, 1000);');
      // Spawned WITHOUT `detached`, exactly like the helper commands a lane runs:
      // it belongs to no group of its own, so `stopProcessGroup` cannot see it.
      const stray = Bun.spawn(['bun', 'stray.ts'], {
        cwd: directory,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await settle(() => alive(stray.pid));
      await expect(assertNothingSurvives(directory)).rejects.toThrow(/still running inside/);

      expect(await reapProcessesUnder(directory)).toBeGreaterThan(0);

      await settle(() => !alive(stray.pid));
      await expect(assertNothingSurvives(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

/**
 * A lane owns its DIRECTORY too, not only the processes it starts.
 *
 * The half that was missing: `rm(workspace)` lives after the `finally`, a
 * `finally` covers a throw and not a signal, and SIGKILL runs nothing at all —
 * so every badly-ended run left its whole tree behind. Four of them, 3.3 GiB,
 * were found by a neighbouring project on a disk at 97% whose database was
 * answering `No space left on device`.
 */
async function laneDirectoryClaimedBy(
  keepAlive: boolean,
): Promise<{ directory: string; owner: ReturnType<typeof Bun.spawn> }> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
  const source = join(directory, 'owner.ts');
  await writeFile(
    source,
    [
      `import { claimLaneDirectory } from ${JSON.stringify(join(import.meta.dir, 'lane-processes.ts'))};`,
      `await claimLaneDirectory(${JSON.stringify(directory)});`,
      "console.log('claimed');",
      keepAlive ? 'setInterval(() => {}, 1000);' : '',
    ].join('\n'),
  );
  // Started OUTSIDE the tree on purpose: a live owner that has not yet chdir'd
  // into its workspace is exactly the case the cwd scan cannot see, and the one
  // where a sweep by "nothing is living inside it" would delete a running lane.
  const owner = Bun.spawn(['bun', source], {
    cwd: import.meta.dir,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = owner.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('claimed')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  reader.releaseLock();
  return { directory, owner };
}

test.skipIf(!hasProcfs)(
  'a lane directory whose owner is gone is swept by the next run',
  async () => {
    const { directory, owner } = await laneDirectoryClaimedBy(false);
    try {
      await owner.exited;
      expect(existsSync(directory)).toBe(true);

      expect(await sweepAbandonedTemporaryDirectories()).toContain(directory);

      expect(existsSync(directory)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a lane directory whose owner is still running is left alone',
  async () => {
    const { directory, owner } = await laneDirectoryClaimedBy(true);
    try {
      expect(await sweepAbandonedTemporaryDirectories()).not.toContain(directory);
      expect(existsSync(directory)).toBe(true);

      // And the moment the owner is gone, the same sweep reclaims it.
      await stopProcessGroup(owner);
      await settle(() => !alive(owner.pid));

      expect(await sweepAbandonedTemporaryDirectories()).toContain(directory);
      expect(existsSync(directory)).toBe(false);
    } finally {
      await stopProcessGroup(owner).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a young directory with no owner marker is kept, not guessed about',
  async () => {
    // Written by a lane from before the marker existed, or by one killed in the
    // moment between creating its directory and claiming it. Its owner cannot
    // be asked, so the fail-safe direction is to keep it.
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
    try {
      expect(await sweepAbandonedTemporaryDirectories()).not.toContain(directory);
      expect(existsSync(directory)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a signal to the lane itself gives its directory back',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-starter-lane-'));
    let removed = false;
    try {
      // The same miniature as above, with the registration the real lanes now
      // make: reaping the roles and leaving 1.6 GiB behind is half a cleanup.
      await writeFile(
        join(directory, 'lane.ts'),
        [
          `import { reapOnTermination, releaseLaneDirectory } from ${JSON.stringify(join(import.meta.dir, 'lane-processes.ts'))};`,
          `reapOnTermination(() => releaseLaneDirectory(${JSON.stringify(directory)}));`,
          "console.log('ready');",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const lane = Bun.spawn(['bun', join(directory, 'lane.ts')], {
        cwd: import.meta.dir,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const reader = lane.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('ready')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
      reader.releaseLock();

      lane.kill('SIGTERM');
      await lane.exited;
      await settle(() => !existsSync(directory));

      expect(existsSync(directory)).toBe(false);
      removed = true;
    } finally {
      if (!removed) await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

/**
 * The wiring, at the point of attachment.
 *
 * The behaviours above would all still pass if no lane ever called them, and
 * spawning a real lane to find out costs minutes and a database. So the two
 * lanes that create a directory under a lane prefix are read for the three
 * claims that make the leak impossible: they claim what they create, they sweep
 * what an earlier run abandoned, and they give their own tree back on a signal.
 */
test('every lane claims, sweeps and releases its directory', async () => {
  for (const lane of ['starter-lane.ts', 'supervised-lane.ts']) {
    const source = await readFile(join(import.meta.dir, lane), 'utf8');
    expect({ lane, claims: source.includes('claimLaneDirectory(workspace)') }).toEqual({
      lane,
      claims: true,
    });
    expect({ lane, sweeps: source.includes('sweepAbandonedTemporaryDirectories()') }).toEqual({
      lane,
      sweeps: true,
    });
    expect({ lane, releases: source.includes('releaseLaneDirectory(workspace)') }).toEqual({
      lane,
      releases: true,
    });
  }
});

test.skipIf(!hasProcfs)(
  'an old tree from any script here is swept, a young one and a stray file are not',
  async () => {
    // The lanes are the biggest leak, not the only one: an abandoned consumer
    // tree is 137 MiB, and every scaffolder test leaves a small directory. None
    // of them writes an owner marker, so age and emptiness are all there is to
    // go on — which is why the fail-safe direction is to keep.
    const old = await mkdtemp(join(tmpdir(), 'stitchkit-consumer-'));
    const young = await mkdtemp(join(tmpdir(), 'stitchkit-consumer-'));
    const strayFile = join(tmpdir(), `stitchkit-${Date.now()}-stray.log`);
    await writeFile(strayFile, 'a log someone is still reading\n');
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await utimes(old, sevenHoursAgo, sevenHoursAgo);
    await utimes(strayFile, sevenHoursAgo, sevenHoursAgo);
    try {
      const removed = await sweepAbandonedTemporaryDirectories();

      expect(removed).toContain(old);
      expect(existsSync(old)).toBe(false);
      // Young: a run that may still be going.
      expect(removed).not.toContain(young);
      expect(existsSync(young)).toBe(true);
      // A file is evidence, not a leftover, however old it is.
      expect(removed).not.toContain(strayFile);
      expect(existsSync(strayFile)).toBe(true);
    } finally {
      await rm(old, { recursive: true, force: true });
      await rm(young, { recursive: true, force: true });
      await rm(strayFile, { force: true });
    }
  },
  30_000,
);

test.skipIf(!hasProcfs)(
  'a tree someone is still reading from is kept, even with its owner gone',
  async () => {
    // The case the cwd scan cannot see, and not a theoretical one: a
    // neighbouring project's supervised backend was found holding three
    // descriptors inside an abandoned consumer tree while its own working
    // directory was in its own repository.
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-consumer-'));
    const target = join(directory, 'module.js');
    let reader: Bun.Subprocess<'ignore', 'pipe', 'ignore'> | undefined;
    try {
      await writeFile(target, 'export const x = 1;\n');
      await writeFile(
        join(tmpdir(), 'stitchkit-reader-probe.ts'),
        [
          "import { open } from 'node:fs/promises';",
          `const handle = await open(${JSON.stringify(target)}, 'r');`,
          "console.log('holding');",
          'setInterval(() => void handle, 1000);',
        ].join('\n'),
      );
      // Started OUTSIDE the tree, exactly like the process that was found.
      const spawned = Bun.spawn(['bun', join(tmpdir(), 'stitchkit-reader-probe.ts')], {
        cwd: import.meta.dir,
        stdout: 'pipe',
        stderr: 'ignore',
      });
      reader = spawned;
      const readerStdout = spawned.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      while (!seen.includes('holding')) {
        const { value, done } = await readerStdout.read();
        if (done) break;
        seen += decoder.decode(value);
      }
      readerStdout.releaseLock();

      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
      await utimes(directory, sevenHoursAgo, sevenHoursAgo);

      expect(await sweepAbandonedTemporaryDirectories()).not.toContain(directory);
      expect(existsSync(target)).toBe(true);

      // And once the reader lets go, the same sweep reclaims it.
      await stopProcessGroup(spawned);
      await settle(() => !alive(spawned.pid));
      await utimes(directory, sevenHoursAgo, sevenHoursAgo);

      expect(await sweepAbandonedTemporaryDirectories()).toContain(directory);
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (reader) await stopProcessGroup(reader).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
      await rm(join(tmpdir(), 'stitchkit-reader-probe.ts'), { force: true });
    }
  },
  30_000,
);
