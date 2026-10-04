import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createFileStateStore } from '../src/application/file-state-store';

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
      JSON.stringify({
        host: hostname(),
        pid: 2_000_000_000,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const first = createFileStateStore(path, {
      schema,
    });
    const second = createFileStateStore(path, {
      schema,
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
      JSON.stringify({
        host: hostname(),
        pid: process.pid,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    // Stale by more than one bound, less than the abandonment multiple: a
    // live holder may be blocking its event loop and still about to write.
    const old = new Date(Date.now() - 120);
    await utimes(lockPath, old, old);
    const store = createFileStateStore(path, {
      schema,
      lockTimeoutMs: 200,
    });
    await expect(
      store.update(() => ({ state: { counter: 1 }, result: undefined })),
    ).rejects.toThrow('gave up after 200 ms');
  });

  test('a readable legacy owner without host is preserved even when its timestamp is old', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    await writeFile(
      lockPath,
      JSON.stringify({ token: 'legacy', pid: process.pid, acquiredAt: 0 }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const store = createFileStateStore(path, {
      schema,
      lockTimeoutMs: 30,
    });
    await expect(
      store.update(() => ({ state: { counter: 1 }, result: undefined })),
    ).rejects.toThrow('gave up after 30 ms');
    expect(await store.read()).toBeNull();
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe('legacy');
  });

  test('an orphaned reclaim guard older than the stale bound does not disable reclaim for good', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const lockPath = `${path}.lock`;
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    await writeFile(
      lockPath,
      JSON.stringify({
        host: hostname(),
        pid: 2_000_000_000,
        acquiredAt: new Date(0).toISOString(),
      }),
    );
    await writeFile(`${lockPath}.reclaim`, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    await utimes(`${lockPath}.reclaim`, old, old);
    const store = createFileStateStore(path, {
      schema,
      lockTimeoutMs: 2_000,
    });
    await store.update(() => ({ state: { counter: 1 }, result: undefined }));
    expect(await store.read()).toEqual({ counter: 1 });
  });

  test('an update preserves unknown old temporary files and removes only its own staging file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stitchkit-state-'));
    directories.push(directory);
    const path = join(directory, 'counter.json');
    const schema = z.object({ counter: z.number().int().nonnegative() }).strict();
    const orphan = `${path}.tmp.99999.deadbeef`;
    await writeFile(orphan, '{"counter":0}');
    const old = new Date(Date.now() - 60_000);
    await utimes(orphan, old, old);
    const store = createFileStateStore(path, { schema });
    await store.update(() => ({ state: { counter: 1 }, result: undefined }));
    expect(await readFile(orphan, 'utf8')).toBe('{"counter":0}');
  });

  test('retired lock age options are refused at construction', () => {
    expect(() =>
      createFileStateStore('/nonexistent/x.json', {
        schema: z.object({ n: z.number() }),
        lockTimeoutMs: 1_000,
        // @ts-expect-error retired options cannot weaken lock ownership
        staleLockMs: 1_000,
      }),
    ).toThrow('lock age/retry options are unsupported');
  });
});
