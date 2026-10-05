import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { link, mkdtemp, open, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from '../src/entrypoints/files';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}
function gate(): Gate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, open: release };
}

/**
 * Stall the first owner-record write of the process, the way a GC pause, SIGSTOP or a slow
 * filesystem would, and report when it is stalled. Later writes are not delayed.
 */
async function stallFirstOwnerWrite(): Promise<{
  stalled: Promise<void>;
  resume(): void;
  restore(): void;
}> {
  const probe = await open(tmpdir());
  const prototype: { writeFile: unknown } = Object.getPrototypeOf(probe);
  await probe.close();
  const original = prototype.writeFile;
  if (typeof original !== 'function') throw new Error('FileHandle.writeFile is unavailable');
  const reached = gate();
  const resumed = gate();
  let armed = true;
  prototype.writeFile = async function (this: unknown, ...args: unknown[]) {
    if (armed) {
      armed = false;
      reached.open();
      await resumed.promise;
    }
    return Reflect.apply(original, this, args);
  };
  return {
    stalled: reached.promise,
    resume: resumed.open,
    restore() {
      prototype.writeFile = original;
    },
  };
}

test('a holder stalled before its owner write never lets a second callback in under default options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lock-owner-first-'));
  roots.push(root);
  const path = join(root, 'resource.lock');
  const stall = await stallFirstOwnerWrite();
  const inside = gate();
  const release = gate();
  let entered = 0;
  let live = 0;
  let peak = 0;
  const enter = async (hold: Promise<void> | undefined) => {
    entered++;
    live++;
    peak = Math.max(peak, live);
    inside.open();
    await hold;
    live--;
  };
  try {
    // Default options everywhere except the wait: the stalled holder makes one attempt.
    const stalledHolder = withExclusiveLock(path, () => enter(undefined), {
      timeoutMs: 0,
    }).catch((error: unknown) => error);
    await stall.stalled;
    const nameVisibleWhileStalled = existsSync(path);
    // Whatever the stalled holder created is ancient by the time a contender looks.
    const old = new Date(Date.now() - 60_000);
    for (const entry of await readdir(root)) await utimes(join(root, entry), old, old);

    const contender = withExclusiveLock(path, () => enter(release.promise));
    await inside.promise;
    stall.resume();
    const outcome = await stalledHolder;
    release.open();
    await contender;

    expect(entered).toBe(1);
    expect(peak).toBe(1);
    expect(outcome).toBeInstanceOf(ExclusiveLockError);
    // A holder that dies at the stall point leaves no lock name behind.
    expect(nameVisibleWhileStalled).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally {
    stall.restore();
    stall.resume();
    release.open();
  }
});

test('a lock file always carries its owner record from the moment its name exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lock-owner-visible-'));
  roots.push(root);
  const path = join(root, 'resource.lock');
  const seen: string[] = [];
  await withExclusiveLock(path, async (lock) => {
    seen.push(await Bun.file(path).text());
    expect(JSON.parse(seen[0] ?? '')).toMatchObject({
      pid: process.pid,
      acquiredAt: lock.owner.acquiredAt,
    });
  });
  expect(existsSync(path)).toBe(false);
});

test('an empty reclaim guard left by an older writer is taken under default options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lock-old-guard-'));
  roots.push(root);
  const path = join(root, 'resource.lock');
  const dead = JSON.stringify({
    host: hostname(),
    pid: 2_000_000_000,
    acquiredAt: new Date(0).toISOString(),
  });
  await writeFile(path, dead);
  await writeFile(`${path}.reclaim`, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  await utimes(`${path}.reclaim`, old, old);
  expect(await withExclusiveLock(path, (lock) => lock.reclaimed, { timeoutMs: 2_000 })).toBe(
    true,
  );
});

const deadOwner = () =>
  JSON.stringify({
    host: hostname(),
    pid: 2_000_000_000,
    acquiredAt: new Date(0).toISOString(),
  });
const STAGED = '.lock-00000000-0000-4000-8000-000000000001.tmp';

test('a holder that died between link and unlink leaves a lock that is still reclaimed, and its staging file goes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lock-two-names-'));
  roots.push(root);
  const path = join(root, 'resource.lock');
  // The state a SIGKILL leaves: the lock name and the staging name share one inode.
  await writeFile(join(root, STAGED), deadOwner());
  await link(join(root, STAGED), path);
  // A staging file of another dead holder, killed before it reached the link.
  await writeFile(join(root, '.lock-00000000-0000-4000-8000-000000000002.tmp'), deadOwner());
  expect(await withExclusiveLock(path, (lock) => lock.reclaimed, { timeoutMs: 2_000 })).toBe(
    true,
  );
  expect(await readdir(root)).toEqual([]);
});

test('a lock with a second name that is not its own staging file is still refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lock-foreign-link-'));
  roots.push(root);
  const path = join(root, 'resource.lock');
  await writeFile(path, deadOwner());
  await link(path, join(root, 'foreign-name'));
  const error = await withExclusiveLock(path, () => undefined, { timeoutMs: 30 }).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExclusiveLockError);
  expect(await readdir(root)).toContain('foreign-name');
});
