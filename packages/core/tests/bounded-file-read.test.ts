import { afterEach, beforeEach, expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundedFileReadError,
  openRegularFile,
  readBoundedFile,
} from '../src/internal/bounded-file-read';
import { closeAfter, closeAfterSync } from '../src/internal/close-after';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'stitchkit-bounded-read-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const refusal = async (run: () => Promise<unknown>): Promise<BoundedFileReadError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof BoundedFileReadError) return error;
    throw error;
  }
  throw new Error('expected a BoundedFileReadError');
};

test('rejectSymlinks alone decides whether a symlink leaf is followed', async () => {
  await writeFile(join(root, 'real'), 'bytes');
  await symlink(join(root, 'real'), join(root, 'link'));
  const followed = await readBoundedFile(join(root, 'link'), 16);
  expect(new TextDecoder().decode(followed.bytes)).toBe('bytes');
  const refused = await refusal(() =>
    readBoundedFile(join(root, 'link'), 16, { rejectSymlinks: true }),
  );
  expect(refused.code).toBe('FILE_UNSAFE_LINK');
  expect(refused.message).toBe('managed file leaf is a symlink');
  expect(refused.cause).toMatchObject({ code: 'ELOOP' });
  // A dangling symlink is a symlink too, not absence.
  await symlink(join(root, 'gone'), join(root, 'dangling'));
  expect(
    (
      await refusal(() =>
        readBoundedFile(join(root, 'dangling'), 16, { rejectSymlinks: true }),
      )
    ).code,
  ).toBe('FILE_UNSAFE_LINK');
});

test('an oversized file carries its observation whatever its link count', async () => {
  await writeFile(join(root, 'big'), '0123456789');
  await link(join(root, 'big'), join(root, 'alias'));
  const single = await refusal(() => readBoundedFile(join(root, 'big'), 5));
  expect(single.code).toBe('FILE_TOO_LARGE');
  expect(single.observation).toMatchObject({ size: 10, nlink: 2 });
  const strict = await refusal(() =>
    readBoundedFile(join(root, 'big'), 5, { singleLink: true }),
  );
  expect(strict.code).toBe('FILE_UNSAFE_LINK');
  expect(strict.observation).toMatchObject({ size: 10, nlink: 2 });
});

test('the descriptor open refuses what is not a regular file and hands a regular one to its caller', async () => {
  await mkdir(join(root, 'directory'));
  await writeFile(join(root, 'file'), 'abc');
  expect((await refusal(() => openRegularFile(join(root, 'directory')))).code).toBe(
    'FILE_NOT_REGULAR',
  );
  const { handle, before } = await openRegularFile(join(root, 'file'), {
    rejectSymlinks: true,
  });
  try {
    expect(before).toMatchObject({ size: 3, nlink: 1 });
  } finally {
    await handle.close();
  }
});

test('closeAfter reports the failure of the work, and a close failure only when the work succeeded', async () => {
  const closeFault = new Error('close failed');
  const workFault = new Error('work failed');
  const closes: string[] = [];
  const handle = (fault?: Error) => ({
    async close() {
      closes.push('close');
      if (fault) throw fault;
    },
  });
  expect(await closeAfter(handle(), async () => 'done')).toBe('done');
  await expect(closeAfter(handle(closeFault), async () => 'done')).rejects.toBe(closeFault);
  await expect(
    closeAfter(handle(closeFault), async () => {
      throw workFault;
    }),
  ).rejects.toBe(workFault);
  expect(closes).toHaveLength(3);
  const syncCloses: string[] = [];
  const close = (fault?: Error) => () => {
    syncCloses.push('close');
    if (fault) throw fault;
  };
  expect(closeAfterSync(close(), () => 'done')).toBe('done');
  expect(() => closeAfterSync(close(closeFault), () => 'done')).toThrow(closeFault);
  expect(() =>
    closeAfterSync(close(closeFault), () => {
      throw workFault;
    }),
  ).toThrow(workFault);
  expect(syncCloses).toHaveLength(3);
});
