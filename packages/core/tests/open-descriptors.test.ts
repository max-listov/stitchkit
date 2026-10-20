import { afterEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsOpenDescriptor } from '../src/internal/open-descriptors';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stitchkit-descriptors-'));
  directories.push(dir);
  const path = join(dir, 'held');
  await writeFile(path, 'x');
  return path;
}

test('a descriptor this process holds is found, and none is reported once it closes', async () => {
  const path = await file();
  const identity = await stat(path);
  const handle = await open(path, 'r');
  try {
    expect(await holdsOpenDescriptor(path, identity)).toBe(true);
  } finally {
    await handle.close();
  }
  expect(await holdsOpenDescriptor(path, identity)).toBe(false);
});

test('a listing that does not show the probe descriptor proves nothing', async () => {
  const path = await file();
  // A BSD `/dev/fd` without fdescfs: only 0, 1 and 2, whatever is really open.
  const partial = join(path, '..', 'fd');
  await mkdir(partial);
  for (const name of ['0', '1', '2']) await writeFile(join(partial, name), '');
  expect(await holdsOpenDescriptor(path, await stat(path), partial)).toBeNull();
});

test('a file that is gone, replaced or a symlink is unknown, not unheld', async () => {
  const path = await file();
  const identity = await stat(path);
  const symlinked = join(path, '..', 'symlinked');
  await symlink(path, symlinked);
  expect(await holdsOpenDescriptor(symlinked, identity)).toBeNull();
  // A second name keeps the inode allocated, so the replacement cannot reuse its number.
  await link(path, join(path, '..', 'kept'));
  await rm(path);
  expect(await holdsOpenDescriptor(path, identity)).toBeNull();
  await writeFile(path, 'replacement');
  expect(await holdsOpenDescriptor(path, identity)).toBeNull();
});
