import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createFileStateStore } from '../src/application/file-state-store';
import type { StateStoreUpdateContext } from '../src/application/state-store';
import { serialStateStore } from './application-file-state-store-fixture';
import { until } from './support/until';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-state-fence-'));
  directories.push(path);
  return path;
}
const schema = z.object({ counter: z.int().nonnegative() }).strict();

test('a replaced lock generation refuses the stale write and preserves the replacement', async () => {
  const path = join(await directory(), 'state.json');
  const store = createFileStateStore(path, { schema });
  await store.update(() => ({ state: { counter: 1 }, result: undefined }));
  const replacement = JSON.stringify({ token: 'replacement', pid: process.pid });
  await expect(
    store.update(async () => {
      await unlink(`${path}.lock`);
      await writeFile(`${path}.lock`, replacement);
      return { state: { counter: 999 }, result: undefined };
    }),
  ).rejects.toMatchObject({ code: 'LOCK_LOST' });
  expect(await store.read()).toEqual({ counter: 1 });
  expect(await readFile(`${path}.lock`, 'utf8')).toBe(replacement);
});

test('escaped transaction guards refuse after success and failure in file and custom stores', async () => {
  const file = createFileStateStore(join(await directory(), 'state.json'), { schema });
  for (const store of [file, serialStateStore<{ counter: number }>()]) {
    let guard: StateStoreUpdateContext | undefined;
    await store.update(async (_, context) => {
      guard = context;
      await context.assertHeld();
      return { state: { counter: 1 }, result: undefined };
    });
    await expect(guard?.assertHeld()).rejects.toThrow('no longer active');
    await expect(
      store.update(async (_, context) => {
        guard = context;
        throw new Error('transition failed');
      }),
    ).rejects.toThrow('transition failed');
    await expect(guard?.assertHeld()).rejects.toThrow('no longer active');
    expect(await store.read()).toEqual({ counter: 1 });
  }
});

test('lockTimeoutMs zero admits an uncontended transition and refuses a held one', async () => {
  const path = join(await directory(), 'state.json');
  const store = createFileStateStore(path, { schema, lockTimeoutMs: 0 });
  await store.update(() => ({ state: { counter: 1 }, result: undefined }));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = store.update(async (current) => {
    enter();
    await gate;
    return { state: schema.parse(current), result: undefined };
  });
  await entered;
  try {
    await expect(
      store.update(() => ({ state: { counter: 2 }, result: undefined })),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
  } finally {
    release();
    await held;
  }
  expect(await store.read()).toEqual({ counter: 1 });
});

test('retired and nonfinite lock options fail before filesystem mutation', () => {
  for (const lockTimeoutMs of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      createFileStateStore('/nonexistent/state.json', { schema, lockTimeoutMs }),
    ).toThrow('nonnegative safe integer');
  expect(() =>
    // @ts-expect-error clean cutover: retryMs is no longer a public option
    createFileStateStore('/nonexistent/state.json', { schema, retryMs: 1 }),
  ).toThrow('unsupported');
});

test('SIGSTOP of a live transaction cannot cause an age takeover or a lost update', async () => {
  const dir = await directory();
  const path = join(dir, 'state.json');
  const ready = join(dir, 'ready');
  const proceed = join(dir, 'proceed');
  const child = Bun.spawn(
    [
      process.execPath,
      join(dirname(import.meta.path), 'application-file-state-store-child.ts'),
      path,
      ready,
      proceed,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    await until(() => existsSync(ready), 'the child to hold the lock');
    process.kill(child.pid, 'SIGSTOP');
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    const contender = createFileStateStore(path, { schema, lockTimeoutMs: 50 });
    await expect(
      contender.update(() => ({ state: { counter: 900 }, result: undefined })),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(await contender.read()).toBeNull();
    await writeFile(proceed, 'continue');
    process.kill(child.pid, 'SIGCONT');
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    await contender.update((current) => ({
      state: { counter: (current?.counter ?? 0) + 1 },
      result: undefined,
    }));
    expect(await contender.read()).toEqual({ counter: 2 });
  } finally {
    if (child.exitCode === null) {
      process.kill(child.pid, 'SIGCONT');
      child.kill();
      await child.exited;
    }
  }
});
