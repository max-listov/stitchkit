import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../src/entrypoints/files';
import { attemptExclusiveLock } from '../src/internal/exclusive-lock';
import * as lockOwner from '../src/internal/exclusive-lock-owner';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A lock whose recorded owner is provably gone, and the record of a live one. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lock-reclaim-judged-'));
  roots.push(root);
  const owner = await withExclusiveLock(join(root, 'owner'), (held) => held.owner);
  if (!owner.process) throw new Error('Native process identity is required by this control');
  const path = join(root, 'owner.lock');
  const gone = JSON.stringify({
    ...owner,
    process: { ...owner.process, bootId: 'previous-boot' },
  });
  const live = JSON.stringify({
    ...owner,
    acquiredAt: new Date(Date.now() + 1).toISOString(),
  });
  await writeFile(path, gone);
  return { path, gone, live };
}

/**
 * Let the reclaimer judge the lock under its guard, then change the file before it acts: what a
 * release followed by a new holder's create does in the time between the two.
 */
function changeAfterJudgement(path: string, change: () => Promise<void>) {
  const original = lockOwner.diagnose;
  let judgements = 0;
  return spyOn(lockOwner, 'diagnose').mockImplementation(async (lock, ...rest) => {
    const diagnosis = await original(lock, ...rest);
    // The first judgement is the unguarded look; the second is the one under the guard.
    if (lock?.path === path && ++judgements === 2) await change();
    return diagnosis;
  });
}

test('a new holder on the reused inode of the judged lock is not removed', async () => {
  const { path, live } = await fixture();
  const inode = (await stat(path)).ino;
  // The new lock has the judged file's inode and another record.
  const spy = changeAfterJudgement(path, () => writeFile(path, live));
  try {
    const attempt = await attemptExclusiveLock(path, { mode: 0o600, reclaim: true });
    if ('held' in attempt) await attempt.held.release();
    expect('held' in attempt).toBe(false);
    if ('held' in attempt) throw new Error('A live lock was removed');
    expect(String(attempt.diagnosis?.cause)).toContain(
      'replaced before it could be reclaimed',
    );
  } finally {
    spy.mockRestore();
  }
  expect(await readFile(path, 'utf8')).toBe(live);
  expect((await stat(path)).ino).toBe(inode);
});

test('a new holder created after the judged lock was released is not removed', async () => {
  const { path, live } = await fixture();
  let replacement = 0;
  // A release and a fresh create: the new file may or may not reuse the freed inode.
  const spy = changeAfterJudgement(path, async () => {
    await unlink(path);
    await writeFile(path, live);
    replacement = (await stat(path)).ino;
  });
  try {
    const attempt = await attemptExclusiveLock(path, { mode: 0o600, reclaim: true });
    if ('held' in attempt) await attempt.held.release();
    expect('held' in attempt).toBe(false);
  } finally {
    spy.mockRestore();
  }
  expect((await stat(path)).ino).toBe(replacement);
  expect(await readFile(path, 'utf8')).toBe(live);
});

test('a judged lock that is still the same file is reclaimed, and one released meanwhile is simply taken', async () => {
  const unchanged = await fixture();
  const reclaimed = await withExclusiveLock(unchanged.path, (held) => held.reclaimed, {
    timeoutMs: 0,
  });
  expect(reclaimed).toBe(true);

  const released = await fixture();
  const spy = changeAfterJudgement(released.path, () => unlink(released.path));
  try {
    const attempt = await attemptExclusiveLock(released.path, { mode: 0o600, reclaim: true });
    if (!('held' in attempt)) throw attempt.error;
    expect(JSON.parse(await readFile(released.path, 'utf8'))).toEqual(attempt.held.owner);
    await attempt.held.release();
  } finally {
    spy.mockRestore();
  }
});
