import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from '../src/entrypoints/files';

const MACHINE = 'test-machine';

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stitchkit-lock-')));
  lockPath = join(dir, 'registry.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plantOwner(
  pid: number,
  machine = MACHINE,
  acquiredAt = new Date().toISOString(),
): void {
  writeFileSync(
    lockPath,
    `${JSON.stringify({ pid, host: hostname(), acquiredAt, machine })}\n`,
  );
}

/** A pid that existed and is provably gone: a child that ran and was reaped. */
async function deadPid(): Promise<number> {
  const child = spawn('true');
  const pid = child.pid;
  if (pid === undefined) throw new Error('no child pid');
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

const options = { machineIdentity: MACHINE };

describe('withExclusiveLock', () => {
  test('runs under the lock, records its owner, and releases on every outcome', async () => {
    const seen = await withExclusiveLock(
      lockPath,
      (lock) => {
        expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
        return lock;
      },
      options,
    );
    expect(seen.owner.pid).toBe(process.pid);
    expect(seen.reclaimed).toBe(false);
    expect(existsSync(lockPath)).toBe(false);

    await expect(
      withExclusiveLock(
        lockPath,
        () => {
          throw new Error('work failed');
        },
        options,
      ),
    ).rejects.toThrow('work failed');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a second caller waits its turn instead of failing', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const first = withExclusiveLock(
      lockPath,
      async () => {
        order.push('first:start');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        order.push('first:end');
      },
      options,
    );
    while (!release) await Bun.sleep(1);
    const second = withExclusiveLock(lockPath, () => order.push('second'), options);
    await Bun.sleep(40);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  test('an abort stops the wait at once, not at the deadline', async () => {
    plantOwner(process.pid);
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(new Error('caller gave up')), 30);
    const error = await withExclusiveLock(lockPath, () => undefined, {
      ...options,
      timeoutMs: 10_000,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExclusiveLockError);
    expect((error as ExclusiveLockError).code).toBe('LOCK_ABORTED');
    expect((error as ExclusiveLockError).cause).toEqual(new Error('caller gave up'));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('a timeout names the resource and whoever holds it', async () => {
    plantOwner(process.pid);
    const error = await withExclusiveLock(lockPath, () => undefined, {
      ...options,
      label: 'session registry',
      timeoutMs: 40,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExclusiveLockError);
    const refusal = error as ExclusiveLockError;
    expect(refusal.code).toBe('LOCK_TIMEOUT');
    expect(refusal.holder?.pid).toBe(process.pid);
    expect(refusal.message).toContain('"session registry"');
    expect(refusal.message).toContain(`pid ${process.pid} on ${hostname()}`);
  });

  test('a lock whose owner is provably dead on this machine is taken over', async () => {
    plantOwner(await deadPid());
    const lock = await withExclusiveLock(lockPath, (held) => held, options);
    expect(lock.reclaimed).toBe(true);
  });

  test('a live owner is never taken over, however old its lock', async () => {
    const sleeper = spawn('sleep', ['5']);
    try {
      plantOwner(sleeper.pid ?? 0, MACHINE, '2000-01-01T00:00:00.000Z');
      const error = await withExclusiveLock(lockPath, () => undefined, {
        ...options,
        timeoutMs: 60,
      }).catch((caught: unknown) => caught);
      expect((error as ExclusiveLockError).code).toBe('LOCK_TIMEOUT');
      expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(sleeper.pid);
    } finally {
      sleeper.kill();
    }
  });

  test('a dead pid recorded by another machine is not ours to judge', async () => {
    plantOwner(await deadPid(), 'another-machine');
    const error = await withExclusiveLock(lockPath, () => undefined, {
      ...options,
      timeoutMs: 40,
    }).catch((caught: unknown) => caught);
    expect((error as ExclusiveLockError).code).toBe('LOCK_TIMEOUT');
    expect(existsSync(lockPath)).toBe(true);
  });

  test('a lock with no owner is taken only after its grace period', async () => {
    writeFileSync(lockPath, '');
    const early = await withExclusiveLock(lockPath, () => undefined, {
      ...options,
      timeoutMs: 30,
    }).catch((caught: unknown) => caught);
    expect((early as ExclusiveLockError).code).toBe('LOCK_TIMEOUT');
    expect((early as ExclusiveLockError).holder).toBeNull();

    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    const lock = await withExclusiveLock(lockPath, (held) => held, options);
    expect(lock.reclaimed).toBe(true);
  });

  test('many waiters on one dead owner: one holder at a time', async () => {
    // Every waiter sees the same dead owner at the same moment. Without the
    // reclaim guard the second to unlink removes the lock the first has just
    // created, and two of them run at once.
    for (let round = 0; round < 3; round += 1) {
      plantOwner(await deadPid());
      let inside = 0;
      let most = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withExclusiveLock(
            lockPath,
            async () => {
              inside += 1;
              most = Math.max(most, inside);
              await Bun.sleep(2);
              inside -= 1;
            },
            options,
          ),
        ),
      );
      expect(most).toBe(1);
    }
  }, 20_000);

  test('releasing never removes a lock that is no longer this one', async () => {
    await withExclusiveLock(
      lockPath,
      () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, 'someone else');
      },
      options,
    );
    expect(readFileSync(lockPath, 'utf8')).toBe('someone else');
  });

  test('the lock file carries the mode asked for', async () => {
    const mode = await withExclusiveLock(lockPath, () => statSync(lockPath).mode & 0o777, {
      ...options,
      mode: 0o640,
    });
    expect(mode).toBe(0o640);
  });

  test('an ownerless lock is taken once it is older than the grace period set', async () => {
    writeFileSync(lockPath, '');
    const past = new Date(Date.now() - 2_000);
    utimesSync(lockPath, past, past);
    // Two seconds old: inside the default five-second grace, past a one-second one.
    const refused = await withExclusiveLock(lockPath, () => undefined, {
      ...options,
      timeoutMs: 20,
    }).catch((caught: unknown) => caught);
    expect((refused as ExclusiveLockError).code).toBe('LOCK_TIMEOUT');
    const lock = await withExclusiveLock(lockPath, (held) => held, {
      ...options,
      ownerlessGraceMs: 1_000,
    });
    expect(lock.reclaimed).toBe(true);
  });

  test('a negative or infinite budget is refused before anything is created', async () => {
    await expect(
      withExclusiveLock(lockPath, () => undefined, { timeoutMs: -1 }),
    ).rejects.toThrow(RangeError);
    expect(existsSync(lockPath)).toBe(false);
  });
});
