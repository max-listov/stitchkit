import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from '../src/entrypoints/files';

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stitchkit-held-lock-'));
  path = join(directory, 'lock');
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

async function lost(run: () => Promise<void>): Promise<void> {
  try {
    await run();
    throw new Error('Expected a lost-lock refusal');
  } catch (error) {
    if (!(error instanceof ExclusiveLockError)) throw error;
    expect(error.code).toBe('LOCK_LOST');
  }
}

test('assertHeld admits only the original live descriptor/path generation', async () => {
  const lock = await withExclusiveLock(path, async (held) => {
    await held.assertHeld();
    return held;
  });
  await lost(() => lock.assertHeld());
});

test('assertHeld refuses a replaced path and release preserves the replacement', async () => {
  await withExclusiveLock(path, async (held) => {
    const original = await readFile(path);
    await unlink(path);
    await writeFile(path, original);
    await lost(() => held.assertHeld());
  });
  expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid);
});

test('assertHeld refuses a changed owner record on the original inode', async () => {
  await withExclusiveLock(path, async (held) => {
    await writeFile(path, JSON.stringify({ pid: process.pid, token: 'replacement' }));
    await lost(() => held.assertHeld());
  });
});

test('assertHeld refuses symlink redirection without reading its target', async () => {
  const other = join(directory, 'other');
  await writeFile(other, 'untouched');
  await withExclusiveLock(path, async (held) => {
    await unlink(path);
    await symlink(other, path);
    await lost(() => held.assertHeld());
  });
  expect(await readFile(other, 'utf8')).toBe('untouched');
});

test('a readable legacy pid/token owner is unknown, never ownerless age reclaim', async () => {
  const bytes = JSON.stringify({ token: 'legacy', pid: process.pid, acquiredAt: 1 });
  await writeFile(path, bytes);
  await utimes(path, new Date(0), new Date(0));
  let runs = 0;
  try {
    await withExclusiveLock(
      path,
      () => {
        runs += 1;
      },
      {
        timeoutMs: 15,
        ownerlessGraceMs: 0,
      },
    );
    throw new Error('Expected an unknown-owner refusal');
  } catch (error) {
    if (!(error instanceof ExclusiveLockError)) throw error;
    expect(error.code).toBe('LOCK_TIMEOUT');
  }
  expect(runs).toBe(0);
  expect(await readFile(path, 'utf8')).toBe(bytes);
});

test('genuinely empty ownerless records retain declared age recovery', async () => {
  await writeFile(path, '');
  await utimes(path, new Date(0), new Date(0));
  await withExclusiveLock(
    path,
    async (held) => {
      expect(held.reclaimed).toBe(true);
      await held.assertHeld();
    },
    { ownerlessGraceMs: 0 },
  );
});
