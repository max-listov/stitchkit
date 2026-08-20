import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedFileBoundary, ManagedFileError } from '../src/files/boundary';

async function sandbox(): Promise<{ root: string; dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'sk-files-'));
  return {
    root,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe('managed file boundary', () => {
  test('binds one root and returns transport-safe refs without leaking it', async () => {
    const fixture = await sandbox();
    try {
      const files = await createManagedFileBoundary({ root: fixture.root });
      const ref = await files.write('result.bin', new Uint8Array([1, 2, 3]), {
        mediaType: 'application/octet-stream',
      });
      expect(ref).toEqual({
        path: 'result.bin',
        size: 3,
        mediaType: 'application/octet-stream',
      });
      expect(JSON.stringify(ref)).not.toContain(fixture.root);
      expect(await files.read(ref.path)).toEqual({
        ref: { path: 'result.bin', size: 3 },
        bytes: new Uint8Array([1, 2, 3]),
      });
    } finally {
      await fixture.dispose();
    }
  });

  test('rejects non-canonical paths and pre-existing symlinks outside the root', async () => {
    const fixture = await sandbox();
    const outside = await mkdtemp(join(tmpdir(), 'sk-files-outside-'));
    try {
      await writeFile(join(outside, 'secret.bin'), 'secret');
      await symlink(join(outside, 'secret.bin'), join(fixture.root, 'link.bin'));
      const files = await createManagedFileBoundary({ root: fixture.root });
      for (const path of ['', '/tmp/a', '../a', 'a/../b', 'a\\b', 'C:/a', 'a//b']) {
        await expect(files.read(path)).rejects.toMatchObject({
          code: 'FILE_INVALID_PATH',
        });
      }
      await expect(files.read('link.bin')).rejects.toMatchObject({
        code: 'FILE_OUTSIDE_ROOT',
      });
    } finally {
      await Promise.all([fixture.dispose(), rm(outside, { recursive: true, force: true })]);
    }
  });

  test('enforces the cap while reading the opened handle, not only from metadata', async () => {
    const fixture = await sandbox();
    try {
      await writeFile(join(fixture.root, 'large.bin'), new Uint8Array([1, 2, 3, 4]));
      const files = await createManagedFileBoundary({ root: fixture.root });
      await expect(files.read('large.bin', { maxBytes: 3 })).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    } finally {
      await fixture.dispose();
    }
  });

  test('reject is atomic by default and replace is an explicit atomic cutover', async () => {
    const fixture = await sandbox();
    try {
      await writeFile(join(fixture.root, 'target.bin'), 'old');
      const files = await createManagedFileBoundary({ root: fixture.root });
      await expect(
        files.write('target.bin', new TextEncoder().encode('new')),
      ).rejects.toBeInstanceOf(ManagedFileError);
      expect(await readFile(join(fixture.root, 'target.bin'), 'utf8')).toBe('old');

      await files.write('target.bin', new TextEncoder().encode('new'), { replace: true });
      expect(await readFile(join(fixture.root, 'target.bin'), 'utf8')).toBe('new');
      expect(
        (await readdir(fixture.root)).filter((name) => name.startsWith('.stitchkit-')),
      ).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('stream overflow and inspector rejection leave no visible target or temp', async () => {
    const fixture = await sandbox();
    try {
      const files = await createManagedFileBoundary({
        root: fixture.root,
        maxWriteBytes: 3,
        inspect: ({ prefix }) => {
          if (prefix[0] === 9) throw new Error('blocked signature');
          return { mediaType: 'application/safe' };
        },
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      });
      await expect(files.write('overflow.bin', stream)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
      await expect(files.write('blocked.bin', new Uint8Array([9]))).rejects.toMatchObject({
        code: 'FILE_INSPECTION_REJECTED',
      });
      expect(await readdir(fixture.root)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  test('an already-aborted write performs no filesystem mutation', async () => {
    const fixture = await sandbox();
    try {
      const files = await createManagedFileBoundary({ root: fixture.root });
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await expect(
        files.write('cancelled.bin', new Uint8Array([1]), { signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      expect(await readdir(fixture.root)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
