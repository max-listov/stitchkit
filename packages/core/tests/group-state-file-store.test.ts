import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createFileStateStore } from '../src/server/file-state-store';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('file state store', () => {
  test('two independently-created stores cannot lose concurrent updates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    const first = createFileStateStore(path, { schema });
    const second = createFileStateStore(path, { schema });

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 === 0 ? first : second).update(async (current) => {
          await Bun.sleep(index % 3);
          const counter = (current?.counter ?? 0) + 1;
          return { state: { counter }, result: counter };
        }),
      ),
    );

    expect(await first.read()).toEqual({ counter: 40 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ counter: 40 });
  });

  test('corruption policy is explicit and observable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'state.json');
    await writeFile(path, '{broken');
    const failures: unknown[] = [];
    const schema = z.object({ value: z.string() }).strict();

    await expect(createFileStateStore(path, { schema }).read()).rejects.toBeDefined();
    expect(
      await createFileStateStore(path, {
        schema,
        corrupt: 'empty',
        onCorrupt: ({ error }) => {
          failures.push(error);
        },
      }).read(),
    ).toBeNull();
    expect(failures).toHaveLength(1);
  });

  test('one contender reclaims a stale lock only after its owner is provably gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead', pid: 2_000_000_000, acquiredAt: 0 }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const first = createFileStateStore(path, {
      schema,
      staleLockMs: 1,
      retryMs: 1,
    });
    const second = createFileStateStore(path, {
      schema,
      staleLockMs: 1,
      retryMs: 1,
    });
    await Promise.all(
      [first, second].map((store) =>
        store.update(async (current) => {
          await Bun.sleep(2);
          return {
            state: { counter: (current?.counter ?? 0) + 1 },
            result: undefined,
          };
        }),
      ),
    );
    expect(await first.read()).toEqual({ counter: 2 });
  });

  test('a stale timestamp alone cannot reclaim a lock owned by a live process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'live', pid: process.pid, acquiredAt: 0 }),
    );
    // Stale by more than one bound, less than the abandonment multiple: a
    // live holder may be blocking its event loop and still about to write.
    const old = new Date(Date.now() - 120);
    await utimes(lockPath, old, old);
    const store = createFileStateStore(path, {
      schema,
      staleLockMs: 50,
      lockTimeoutMs: 200,
      retryMs: 5,
    });
    await expect(
      store.update(() => ({ state: { counter: 1 }, result: undefined })),
    ).rejects.toThrow('timed out acquiring state lock');
  });

  test('a lock whose heartbeat is ten stale bounds old is abandoned whatever its pid says', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    // A reused pid (or one this user cannot probe) must not hold the state
    // hostage for ever: the heartbeat is the liveness signal the lock carries.
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'reused-pid', pid: process.pid, acquiredAt: 0 }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const store = createFileStateStore(path, {
      schema,
      staleLockMs: 1_000,
      lockTimeoutMs: 5_000,
      retryMs: 5,
    });
    await store.update(() => ({ state: { counter: 1 }, result: undefined }));
    expect(await store.read()).toEqual({ counter: 1 });
  });

  test('an orphaned reclaim guard older than the stale bound does not disable reclaim for good', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'dead', pid: 2_000_000_000, acquiredAt: 0 }),
    );
    await writeFile(`${lockPath}.reclaim`, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.reclaim`, old, old);
    const store = createFileStateStore(path, {
      schema,
      staleLockMs: 20,
      lockTimeoutMs: 2_000,
      retryMs: 5,
    });
    await store.update(() => ({ state: { counter: 1 }, result: undefined }));
    expect(await store.read()).toEqual({ counter: 1 });
  });

  test('temporary files a crashed writer left behind are swept on the first update', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    const orphan = `${path}.tmp.99999.deadbeef`;
    await writeFile(orphan, '{"counter":0}');
    const old = new Date(Date.now() - 60_000);
    await utimes(orphan, old, old);
    const store = createFileStateStore(path, { schema, staleLockMs: 20 });
    await store.update(() => ({ state: { counter: 1 }, result: undefined }));
    await expect(readFile(orphan, 'utf8')).rejects.toThrow();
  });

  test('a stale bound at or above the acquire timeout is refused at construction', () => {
    expect(() =>
      createFileStateStore('/nonexistent/x.json', {
        schema: z.object({ n: z.number() }),
        lockTimeoutMs: 1_000,
        staleLockMs: 1_000,
      }),
    ).toThrow('must be below lockTimeoutMs');
  });
});
