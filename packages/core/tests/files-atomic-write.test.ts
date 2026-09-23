import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from '../src/entrypoints/files';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stitchkit-atomic-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const forms = [
  ['async', writeFileAtomic],
  [
    'sync',
    async (...args: Parameters<typeof writeFileAtomicSync>) => writeFileAtomicSync(...args),
  ],
] as const;

describe.each(forms)('writeFileAtomic (%s)', (_form, write) => {
  test('writes strings and bytes, replacing what was there', async () => {
    const target = join(dir, 'state.json');
    await write(target, 'first');
    await write(target, new TextEncoder().encode('second'));
    expect(readFileSync(target, 'utf8')).toBe('second');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  test('the mode is the one asked for, not what the umask leaves of it', async () => {
    const previous = process.umask(0o077);
    try {
      const target = join(dir, 'tool');
      await write(target, '#!/bin/sh\n', { mode: 0o755 });
      expect(statSync(target).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(previous);
    }
  });

  test('without a mode the file is private', async () => {
    const target = join(dir, 'private');
    await write(target, 'secret');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test('a symlink at the target is replaced, never written through', async () => {
    // The bytes must not land in whatever the link points at.
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'untouched');
    const target = join(dir, 'config');
    symlinkSync(victim, target);
    await write(target, 'new');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  test('a failed replace leaves the target alone and no staging file behind', async () => {
    // A directory cannot be renamed over: the write succeeds, the rename fails.
    const target = join(dir, 'occupied');
    mkdirSync(target);
    writeFileSync(join(target, 'inside'), 'kept');
    await expect(write(target, 'x')).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(['occupied']);
    expect(readFileSync(join(target, 'inside'), 'utf8')).toBe('kept');
  });

  test('a large write is complete, not the first chunk of it', async () => {
    const target = join(dir, 'large');
    const bytes = new Uint8Array(8 * 1024 * 1024).map((_, index) => index % 251);
    await write(target, bytes);
    expect(readFileSync(target).equals(Buffer.from(bytes))).toBe(true);
  });
});

test('the asynchronous form lets the event loop run while it writes', async () => {
  // The reason it exists: a synchronous rename on a loaded machine held a
  // daemon's main thread for seconds. Here a timer must fire before the write
  // resolves; the synchronous form cannot let it.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 0);
  try {
    await writeFileAtomic(join(dir, 'big'), new Uint8Array(64 * 1024 * 1024));
    expect(ticks).toBeGreaterThan(0);
    const before = ticks;
    writeFileAtomicSync(join(dir, 'big-sync'), new Uint8Array(1024));
    expect(ticks).toBe(before);
  } finally {
    clearInterval(timer);
  }
});
