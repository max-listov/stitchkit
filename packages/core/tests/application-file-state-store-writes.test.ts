import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectoryInbox } from '../src/application/directory-inbox';
import {
  type DirectoryInboxState,
  DirectoryInboxStateSchema,
} from '../src/application/directory-inbox-contract';
import {
  createFileStateStore,
  createFileStateStoreOn,
  type FileStateStoreIO,
} from '../src/application/file-state-store';
import { writeAtomicFileData } from '../src/internal/atomic-file';
import { withExclusiveLock } from '../src/internal/with-exclusive-lock';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-state-writes-'));
  directories.push(path);
  return path;
}
const schema = z.object({ counter: z.int().nonnegative() }).strict();

/** The real write and lock, counting how often a store commits and fences. */
function countingIO() {
  const counts = { writes: 0, fences: 0 };
  const io: FileStateStoreIO = {
    write: (...args) => {
      counts.writes += 1;
      return writeAtomicFileData(...args);
    },
    lock: (path, run, options) =>
      withExclusiveLock(
        path,
        (lock) =>
          run({
            ...lock,
            assertHeld: () => {
              counts.fences += 1;
              return lock.assertHeld();
            },
          }),
        options,
      ),
  };
  return { counts, io };
}

test('an update that returns the state it was given writes nothing', async () => {
  const path = join(await directory(), 'state.json');
  const { counts, io } = countingIO();
  const store = createFileStateStoreOn(path, { schema }, io);
  await store.update(() => ({ state: { counter: 1 }, result: undefined }));
  expect(counts.writes).toBe(1);
  for (let attempt = 0; attempt < 5; attempt += 1)
    expect(
      await store.update((current) => ({ state: current ?? { counter: 0 }, result: 'same' })),
    ).toBe('same');
  expect(counts.writes).toBe(1);
  // Content decides, not identity: an equal copy writes nothing, a change in place is written.
  await store.update((current) => ({ state: { ...current, counter: 1 }, result: undefined }));
  expect(counts.writes).toBe(1);
  await store.update((current) => {
    const state = current ?? { counter: 0 };
    state.counter += 1;
    return { state, result: undefined };
  });
  expect(counts.writes).toBe(2);
  expect(await store.read()).toEqual({ counter: 2 });
});

test('a no-op update fences the lock once and a committing update twice', async () => {
  const path = join(await directory(), 'state.json');
  const { counts, io } = countingIO();
  const store = createFileStateStoreOn(path, { schema }, io);
  await store.update(() => ({ state: { counter: 1 }, result: undefined }));
  expect(counts.fences).toBe(2);
  counts.fences = 0;
  await store.update((current) => ({ state: current ?? { counter: 0 }, result: undefined }));
  expect(counts.fences).toBe(1);
});

test('the state read is bounded and an oversized file is refused, not treated as corrupt', async () => {
  const path = join(await directory(), 'state.json');
  const corrupt: unknown[] = [];
  const store = createFileStateStore(path, {
    schema,
    maxBytes: 32,
    corrupt: 'empty',
    onCorrupt: (failure) => void corrupt.push(failure),
  });
  await store.update(() => ({ state: { counter: 1 }, result: undefined }));
  await writeFile(path, `${JSON.stringify({ counter: 1, padding: 'x'.repeat(64) })}\n`);
  await expect(store.read()).rejects.toThrow('32-byte cap');
  await expect(
    store.update(() => ({ state: { counter: 2 }, result: undefined })),
  ).rejects.toThrow('32-byte cap');
  expect(corrupt).toEqual([]);
  expect(() => createFileStateStore(path, { schema, maxBytes: 0 })).toThrow('maxBytes');
});

test('an inbox pass over entries that already hold receipts commits no state write', async () => {
  const dir = await directory();
  const keys = Array.from(
    { length: 50 },
    (_, index) => `n${String(index).padStart(3, '0')}.json`,
  );
  const seeded: DirectoryInboxState = {
    schemaVersion: 1,
    claims: [],
    receipts: keys.map((key) => ({ key, completedAt: '2026-10-04T01:00:00.000Z' })),
    rejected: [],
  };
  await writeFile(join(dir, '.inbox-state.json'), `${JSON.stringify(seeded)}\n`);
  for (const key of keys) await writeFile(join(dir, key), '{}');
  const { counts, io } = countingIO();
  const resource = createDirectoryInbox({
    id: 'receipted',
    directory: dir,
    schema: z.unknown(),
    store: createFileStateStoreOn(
      join(dir, '.inbox-state.json'),
      {
        schema: DirectoryInboxStateSchema,
      },
      io,
    ),
    handle: () => {
      throw new Error('a receipted entry must not be delivered again');
    },
  });
  const { value: inbox } = await resource.start();
  expect(await inbox.flush()).toBe(0);
  expect((await readdir(dir)).filter((name) => name.startsWith('n'))).toEqual([]);
  expect(counts.writes).toBe(0);
});
