import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandLauncher } from '../src/internal/bun-command';
import {
  identitySource,
  isZombieProcess,
  readDarwinPlatformUuid,
} from '../src/internal/process-identity';
import { ExclusiveLockError, withExclusiveLock } from '../src/internal/with-exclusive-lock';

/*
 * A command whose end is never reported: the child ran, and nothing tells the caller. The wait on
 * it has to end by itself — by the caller's signal or by the command's own deadline.
 */
function unanswered(): { launch: CommandLauncher; stopped: () => number } {
  let stopped = 0;
  return {
    launch: () => ({
      stdout: new Promise<string>(() => undefined),
      stop: () => {
        stopped += 1;
      },
    }),
    stopped: () => stopped,
  };
}

const platformDetection = identitySource.detect;

afterEach(() => {
  identitySource.detect = platformDetection;
  identitySource.forget();
});

async function withLockPath(body: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'stitchkit-unanswered-'));
  try {
    await body(join(directory, 'state.lock'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('a machine identity command whose end is never reported', () => {
  test('a first acquisition with a signal ends as LOCK_ABORTED when the signal fires', async () => {
    const command = unanswered();
    identitySource.forget();
    identitySource.detect = (signal) =>
      readDarwinPlatformUuid('ioreg', signal, { launch: command.launch, timeoutMs: 60_000 });
    await withLockPath(async (path) => {
      const controller = new AbortController();
      const reason = new Error('the caller left');
      setTimeout(() => controller.abort(reason), 50);
      const started = performance.now();
      let ran = false;
      const outcome = await withExclusiveLock(
        path,
        async () => {
          ran = true;
        },
        { timeoutMs: 60_000, signal: controller.signal },
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(ExclusiveLockError);
      expect(outcome).toMatchObject({ code: 'LOCK_ABORTED', cause: reason });
      expect(ran).toBe(false);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(command.stopped()).toBe(1);
      // Nothing was published from a detection that did not answer.
      expect(await readFile(path, 'utf8').catch(() => null)).toBeNull();
    });
  });

  test('a cancelled detection is not remembered: the next acquisition asks again', async () => {
    const command = unanswered();
    let asked = 0;
    identitySource.forget();
    identitySource.detect = (signal) => {
      asked += 1;
      return asked === 1
        ? readDarwinPlatformUuid('ioreg', signal, {
            launch: command.launch,
            timeoutMs: 60_000,
          })
        : Promise.resolve('machine-after-the-cancel');
    };
    await withLockPath(async (path) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await withExclusiveLock(path, async () => undefined, {
        signal: controller.signal,
      }).catch(() => undefined);
      const owner = await withExclusiveLock(path, async (lock) => lock.owner);
      expect(asked).toBe(2);
      expect(owner.machine).toBe('machine-after-the-cancel');
    });
  });

  test('a first acquisition without a signal proceeds once the command deadline passes', async () => {
    const command = unanswered();
    identitySource.forget();
    identitySource.detect = (signal) =>
      readDarwinPlatformUuid('ioreg', signal, { launch: command.launch, timeoutMs: 100 });
    await withLockPath(async (path) => {
      const started = performance.now();
      const owner = await withExclusiveLock(path, async (lock) => lock.owner);
      const elapsed = performance.now() - started;
      // The deadline, not the child, ended the wait: the record carries no machine.
      expect(owner.machine).toBeUndefined();
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(5_000);
      expect(command.stopped()).toBe(1);
    });
  });
});

describe('a zombie probe whose command end is never reported', () => {
  test('answers "present" at its deadline instead of waiting on the child', async () => {
    const command = unanswered();
    const absent = join(tmpdir(), 'stitchkit-no-such-proc-root');
    const started = performance.now();
    expect(
      await isZombieProcess(4242, {
        procRoot: absent,
        launch: command.launch,
        timeoutMs: 100,
      }),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(command.stopped()).toBe(1);
  });
});

describe('the platform launcher', () => {
  test('returns the stdout of a command that ended well and refuses one that did not', async () => {
    // The positive control of the seam above: the real launcher of this runtime, no replacement.
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-launcher-'));
    try {
      const good = join(directory, 'good');
      const bad = join(directory, 'bad');
      await Bun.write(good, '#!/bin/sh\necho \'"IOPlatformUUID" = "REAL-LAUNCH"\'\n');
      await Bun.write(bad, '#!/bin/sh\necho \'"IOPlatformUUID" = "NEVER"\'\nexit 3\n');
      await Bun.$`chmod 755 ${good} ${bad}`.quiet();
      expect(await readDarwinPlatformUuid(good)).toBe('REAL-LAUNCH');
      expect(await readDarwinPlatformUuid(bad)).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
