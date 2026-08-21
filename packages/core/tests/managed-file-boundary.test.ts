import { describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  test('bootstraps only the final root on opt-in and revalidates concurrent creators', async () => {
    const fixture = await sandbox();
    try {
      const ownedRoot = join(fixture.root, 'owned');
      await expect(createManagedFileBoundary({ root: ownedRoot })).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
      });

      const boundaries = await Promise.all([
        createManagedFileBoundary({ root: ownedRoot, createRoot: true }),
        createManagedFileBoundary({ root: ownedRoot, createRoot: true }),
      ]);
      const rootInfo = await stat(ownedRoot);
      expect(rootInfo.isDirectory()).toBe(true);
      expect(rootInfo.mode & 0o077).toBe(0);
      await boundaries[0]?.write('created.bin', new Uint8Array([1]));
      expect((await boundaries[1]?.read('created.bin'))?.bytes).toEqual(new Uint8Array([1]));

      await expect(
        createManagedFileBoundary({
          root: join(fixture.root, 'missing-parent', 'owned'),
          createRoot: true,
        }),
      ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });

      const fileRoot = join(fixture.root, 'file-root');
      await writeFile(fileRoot, 'not a directory');
      await expect(
        createManagedFileBoundary({ root: fileRoot, createRoot: true }),
      ).rejects.toMatchObject({ code: 'FILE_NOT_REGULAR' });

      const canonicalRoot = join(fixture.root, 'canonical-root');
      const linkedRoot = join(fixture.root, 'linked-root');
      await mkdir(canonicalRoot);
      await symlink(canonicalRoot, linkedRoot);
      const linked = await createManagedFileBoundary({ root: linkedRoot });
      await linked.write('linked.bin', new Uint8Array([2]));
      expect(await readFile(join(canonicalRoot, 'linked.bin'))).toEqual(Buffer.from([2]));
    } finally {
      await fixture.dispose();
    }
  });

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

  test('inspects the bounded read prefix and returns only normalized metadata ownership', async () => {
    const fixture = await sandbox();
    try {
      await mkdir(join(fixture.root, 'nested'));
      await writeFile(join(fixture.root, 'nested', 'photo.bin'), new Uint8Array([1, 2, 3, 4]));
      let inspectedPrefix = new Uint8Array();
      let inspectedName = '';
      let inspectedSignal: AbortSignal | undefined;
      const untrustedOwnership = {
        path: '/srv/private/derived.png',
        size: 999,
        mediaType: 'image/example',
        name: 'inspected.png',
      };
      const files = await createManagedFileBoundary({
        root: fixture.root,
        inspectionBytes: 2,
        inspect: (input) => {
          inspectedPrefix = new Uint8Array(input.prefix);
          input.prefix[0] = 9;
          inspectedName = input.name;
          inspectedSignal = input.signal;
          return untrustedOwnership;
        },
      });

      const source = await files.read('nested/photo.bin');
      expect(inspectedPrefix).toEqual(new Uint8Array([1, 2]));
      expect(inspectedName).toBe('photo.bin');
      expect(inspectedSignal).toBeInstanceOf(AbortSignal);
      expect(source).toEqual({
        ref: {
          path: 'nested/photo.bin',
          size: 4,
          mediaType: 'image/example',
          name: 'inspected.png',
        },
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
    } finally {
      await fixture.dispose();
    }
  });

  test('bounds non-cooperative inspection by caller abort and deadline without committing writes', async () => {
    const fixture = await sandbox();
    try {
      await writeFile(join(fixture.root, 'existing.bin'), new Uint8Array([1]));
      let markReadStarted = (): void => undefined;
      const readStarted = new Promise<void>((resolveStarted) => {
        markReadStarted = resolveStarted;
      });
      let readInspectionSignal: AbortSignal | undefined;
      const readFiles = await createManagedFileBoundary({
        root: fixture.root,
        inspectionTimeoutMs: 10_000,
        inspect: ({ signal }) => {
          readInspectionSignal = signal;
          markReadStarted();
          return new Promise(() => undefined);
        },
      });
      const readController = new AbortController();
      const pendingRead = readFiles.read('existing.bin', { signal: readController.signal });
      await readStarted;
      const readReason = new Error('stop read inspection');
      readController.abort(readReason);
      await expect(pendingRead).rejects.toBe(readReason);
      expect(readInspectionSignal?.aborted).toBe(true);

      let markWriteStarted = (): void => undefined;
      const writeStarted = new Promise<void>((resolveStarted) => {
        markWriteStarted = resolveStarted;
      });
      const writeFiles = await createManagedFileBoundary({
        root: fixture.root,
        inspectionTimeoutMs: 10_000,
        inspect: () => {
          markWriteStarted();
          return new Promise(() => undefined);
        },
      });
      const writeController = new AbortController();
      const pendingWrite = writeFiles.write('never-committed.bin', new Uint8Array([2]), {
        signal: writeController.signal,
      });
      await writeStarted;
      writeController.abort(new Error('stop write inspection'));
      await expect(pendingWrite).rejects.toThrow('stop write inspection');
      expect(await readdir(fixture.root)).toEqual(['existing.bin']);

      const deadlineFiles = await createManagedFileBoundary({
        root: fixture.root,
        inspectionTimeoutMs: 5,
        inspect: () => new Promise(() => undefined),
      });
      await expect(deadlineFiles.read('existing.bin')).rejects.toMatchObject({
        code: 'FILE_INSPECTION_REJECTED',
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
