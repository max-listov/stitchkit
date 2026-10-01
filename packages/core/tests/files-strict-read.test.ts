import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedFileBoundary } from '../src/entrypoints/files';
import { readManagedDescriptor } from '../src/files/read';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stitchkit-read-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('strict link options refuse symlink and descriptor hardlink while defaults accept them', async () => {
  await writeFile(join(root, 'file'), 'bytes');
  await symlink('file', join(root, 'sym'));
  await link(join(root, 'file'), join(root, 'hard'));
  const files = await createManagedFileBoundary({ root });
  expect(new TextDecoder().decode((await files.read('sym')).bytes)).toBe('bytes');
  await expect(files.read('sym', { rejectSymlinks: true })).rejects.toMatchObject({
    code: 'FILE_UNSAFE_LINK',
  });
  expect((await files.read('hard', { observe: true })).observation?.nlink).toBe(2);
  await expect(files.read('hard', { singleLink: true })).rejects.toMatchObject({
    code: 'FILE_UNSAFE_LINK',
  });
  await expect(files.read('missing')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
});

test('regular admission refuses directory and native FIFO without waiting for a writer', async () => {
  const files = await createManagedFileBoundary({ root });
  await mkdir(join(root, 'dir'));
  await expect(files.read('dir')).rejects.toMatchObject({ code: 'FILE_NOT_REGULAR' });
  const made = spawnSync('mkfifo', [join(root, 'fifo')]);
  expect(made.status).toBe(0);
  await expect(files.read('fifo')).rejects.toMatchObject({ code: 'FILE_NOT_REGULAR' });
});

for (const stable of [false, true]) {
  test(`descriptor stability option detects change and closes handle (${stable})`, async () => {
    const target = join(root, 'file');
    await writeFile(target, 'before');
    const fd = await open(target, 'r');
    let stats = 0;
    let closed = false;
    const result = readManagedDescriptor(
      target,
      'file',
      100,
      { stable, observe: true },
      { bytes: 20, timeoutMs: 100 },
      async () => ({
        stat: async () => {
          if (++stats === 2) await writeFile(target, 'after-and-bigger');
          return fd.stat();
        },
        read: fd.read.bind(fd),
        close: async () => {
          closed = true;
          await fd.close();
        },
      }),
    );
    if (stable) await expect(result).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    else expect(new TextDecoder().decode((await result).bytes)).toBe('before');
    expect(closed).toBe(true);
  });
}

test('real stream growth exceeds byte budget and closes descriptor', async () => {
  const target = join(root, 'file');
  await writeFile(target, 'a');
  const fd = await open(target, 'r');
  let closed = false;
  let reads = 0;
  await expect(
    readManagedDescriptor(target, 'file', 4, {}, { bytes: 4, timeoutMs: 100 }, async () => ({
      stat: fd.stat.bind(fd),
      close: async () => {
        closed = true;
        await fd.close();
      },
      read: async (...args: Parameters<typeof fd.read>) => {
        if (++reads === 1) await writeFile(target, 'abcdef');
        return fd.read(...args);
      },
    })),
  ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  expect(closed).toBe(true);
});

test('abort and IO failure close descriptors and preserve native cause', async () => {
  const target = join(root, 'file');
  await writeFile(target, 'a');
  for (const abort of [true, false]) {
    const fd = await open(target, 'r');
    let closed = false;
    const controller = new AbortController();
    const cause = new Error('read failed');
    const result = readManagedDescriptor(
      target,
      'file',
      4,
      { signal: controller.signal },
      { bytes: 4, timeoutMs: 100 },
      async () => ({
        stat: async () => {
          if (abort) controller.abort(cause);
          return fd.stat();
        },
        read: async () => {
          throw cause;
        },
        close: async () => {
          closed = true;
          await fd.close();
        },
      }),
    );
    await expect(result).rejects.toBe(cause);
    expect(closed).toBe(true);
  }
});

test('descriptor close failure cannot hide a primary read failure', async () => {
  const target = join(root, 'file');
  await writeFile(target, 'a');
  for (const readFails of [true, false]) {
    const fd = await open(target, 'r');
    const primary = new Error('primary read failed');
    const cleanup = new Error('close acknowledgement failed');
    const result = readManagedDescriptor(
      target,
      'file',
      4,
      {},
      { bytes: 4, timeoutMs: 100 },
      async () => ({
        stat: fd.stat.bind(fd),
        read: async (...args: Parameters<typeof fd.read>) => {
          if (readFails) throw primary;
          return fd.read(...args);
        },
        close: async () => {
          await fd.close();
          throw cleanup;
        },
      }),
    );
    await expect(result).rejects.toBe(readFails ? primary : cleanup);
  }
});

test('strict nofollow refuses dangling and cyclic symlinks instead of reporting absence', async () => {
  await symlink('missing', join(root, 'dangling'));
  await symlink('cycle', join(root, 'cycle'));
  const files = await createManagedFileBoundary({ root });
  for (const name of ['dangling', 'cycle'])
    await expect(files.read(name, { rejectSymlinks: true })).rejects.toMatchObject({
      code: 'FILE_UNSAFE_LINK',
    });
  await expect(files.read('missing', { rejectSymlinks: true })).rejects.toMatchObject({
    code: 'FILE_NOT_FOUND',
  });
});

test('one-byte short reads reuse bounded blocks instead of retaining one full allocation per byte', async () => {
  const { readHandle } = await import('../src/files/file-io');
  const allocations = new Set<Uint8Array>();
  let read = 0;
  const count = 100_000;
  const bytes = await readHandle(
    {
      read: async (buffer, offset) => {
        allocations.add(buffer);
        if (read === count) return { bytesRead: 0 };
        buffer[offset] = read++ % 251;
        return { bytesRead: 1 };
      },
    },
    count,
  );
  expect(bytes.length).toBe(count);
  expect(allocations.size).toBe(2);
  expect([...allocations].reduce((sum, buffer) => sum + buffer.length, 0)).toBe(count + 1);
  expect(bytes.every((value, index) => value === index % 251)).toBe(true);
});
