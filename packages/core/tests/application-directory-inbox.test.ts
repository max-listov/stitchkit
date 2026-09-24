import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { StateStore } from '../src/application/state-store';
import type {
  DirectoryInboxConfig,
  DirectoryInboxDelivery,
  DirectoryInboxRejection,
  DirectoryInboxState,
} from '../src/entrypoints/application';
import { createDirectoryInbox } from '../src/entrypoints/application/directory-inbox';

/*
 * A directory another program drops entries into — a release transition, say —
 * and the application takes each one at least once. Taken and done are two
 * records, so a restart neither loses an entry nor repeats a finished one.
 */

const Transition = z.object({ from: z.string(), to: z.string() }).strict();
type Transition = z.infer<typeof Transition>;

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-inbox-'));
  directories.push(path);
  return path;
}

const drop = (dir: string, name: string, value: unknown) =>
  writeFile(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

function clockAt(start = Date.parse('2026-09-23T10:00:00.000Z')) {
  let now = start;
  return {
    now: () => new Date(now),
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

/** The inbox as a restarted process builds it: a fresh instance over the same directory. */
async function open(
  dir: string,
  handle: DirectoryInboxConfig<Transition>['handle'],
  options: Partial<DirectoryInboxConfig<Transition>> = {},
) {
  const resource = createDirectoryInbox({
    id: 'release-inbox',
    directory: dir,
    schema: Transition,
    handle,
    ...options,
  });
  const { value } = await resource.start();
  return { resource, inbox: value };
}

const context = {} as never;

/** Wait for a condition, not a duration: a poll on a slow disk takes what it takes. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe('createDirectoryInbox', () => {
  test('a restart after the first entry delivers the second and never repeats the first', async () => {
    const dir = await directory();
    const seen: string[] = [];
    const handle = ({ key }: DirectoryInboxDelivery<Transition>) => {
      seen.push(key);
    };
    await drop(dir, '001.json', { from: '1', to: '2' });
    expect(await (await open(dir, handle)).inbox.flush()).toBe(1);

    // The process died after the receipt and before removing the file.
    await drop(dir, '001.json', { from: '1', to: '2' });
    await drop(dir, '002.json', { from: '2', to: '3' });
    const restarted = await open(dir, handle);
    expect(await restarted.inbox.flush()).toBe(1);
    expect(seen).toEqual(['001.json', '002.json']);
    expect((await readdir(dir)).filter((name) => /^[^.].*\.json$/.test(name))).toEqual([]);
    expect((await restarted.inbox.state()).receipts.map((receipt) => receipt.key)).toEqual([
      '002.json',
      '001.json',
    ]);
  });

  test('an entry taken by a process that died is taken again once its lease runs out', async () => {
    const dir = await directory();
    const clock = clockAt();
    await drop(dir, 'cut.json', { from: '1', to: '2' });
    // The first process takes the entry and never finishes.
    const dying = await open(dir, () => new Promise<void>(() => undefined), {
      clock: clock.now,
      leaseMs: 60_000,
    });
    void dying.inbox.flush();
    await Bun.sleep(50);

    const attempts: number[] = [];
    const successor = await open(
      dir,
      ({ attempt }) => {
        attempts.push(attempt);
      },
      { clock: clock.now, leaseMs: 60_000 },
    );
    expect(await successor.inbox.flush()).toBe(0);
    clock.advance(60_001);
    expect(await successor.inbox.flush()).toBe(1);
    expect(attempts).toEqual([2]);
  });

  test('a handler that throws leaves the entry, reports it and takes it again after a backoff', async () => {
    const dir = await directory();
    const clock = clockAt();
    const errors: unknown[] = [];
    let fail = true;
    const attempts: number[] = [];
    const { inbox } = await open(
      dir,
      ({ attempt }) => {
        attempts.push(attempt);
        if (fail) throw new Error('telegram unreachable');
      },
      { clock: clock.now, onError: (error) => void errors.push(error) },
    );
    await drop(dir, 'retry.json', { from: '1', to: '2' });
    expect(await inbox.flush()).toBe(0);
    expect(await readdir(dir)).toContain('retry.json');
    expect(await inbox.flush()).toBe(0);
    fail = false;
    clock.advance(1_000);
    expect(await inbox.flush()).toBe(1);
    expect(attempts).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });

  test('an entry that fails its schema is set aside and the next is delivered', async () => {
    const dir = await directory();
    const rejected: DirectoryInboxRejection[] = [];
    const seen: string[] = [];
    const { inbox } = await open(dir, ({ key }) => void seen.push(key), {
      onRejected: (rejection) => void rejected.push(rejection),
    });
    await drop(dir, '001.json', { from: 1 });
    await drop(dir, '002.json', '{not json');
    await drop(dir, '003.json', { from: '3', to: '4' });
    expect(await inbox.flush()).toBe(1);
    expect(seen).toEqual(['003.json']);
    expect(rejected.map((item) => `${item.key}:${item.reason}`)).toEqual([
      '001.json:invalid',
      '002.json:invalid',
    ]);
    expect(rejected[0]?.detail).toContain('from');
    expect((await readdir(join(dir, 'rejected'))).sort()).toEqual(['001.json', '002.json']);
  });

  test('an entry over maxEntryBytes is set aside unread', async () => {
    const dir = await directory();
    let handled = 0;
    const { inbox } = await open(dir, () => void handled++, { maxEntryBytes: 16 });
    await drop(dir, 'large.json', { from: 'x'.repeat(64), to: 'y' });
    await inbox.flush();
    expect(handled).toBe(0);
    expect((await inbox.state()).rejected).toMatchObject([
      { key: 'large.json', reason: 'too-large' },
    ]);
  });

  test('maxAttempts sets an entry aside instead of retrying it forever', async () => {
    const dir = await directory();
    const clock = clockAt();
    let calls = 0;
    const { inbox } = await open(
      dir,
      () => {
        calls += 1;
        throw new Error('always');
      },
      { clock: clock.now, maxAttempts: 2 },
    );
    await drop(dir, 'poison.json', { from: '1', to: '2' });
    for (let round = 0; round < 4; round += 1) {
      await inbox.flush();
      clock.advance(10 * 60_000);
    }
    expect(calls).toBe(2);
    expect((await inbox.state()).rejected).toMatchObject([
      { key: 'poison.json', reason: 'attempt-limit' },
    ]);
    expect(await readdir(join(dir, 'rejected'))).toEqual(['poison.json']);
  });

  test('retain bounds the receipts kept', async () => {
    const dir = await directory();
    const { inbox } = await open(dir, () => undefined, { retain: 2 });
    for (const name of ['a.json', 'b.json', 'c.json'])
      await drop(dir, name, { from: 'x', to: 'y' });
    expect(await inbox.flush()).toBe(3);
    expect((await inbox.state()).receipts.map((receipt) => receipt.key)).toEqual([
      'c.json',
      'b.json',
    ]);
  });

  test('a supplied store holds the state instead of the directory file', async () => {
    const dir = await directory();
    let state: DirectoryInboxState | null = null;
    const store: StateStore<DirectoryInboxState> = {
      read: async () => state,
      async update(transition) {
        const next = await transition(state);
        state = next.state;
        return next.result;
      },
    };
    const { inbox } = await open(dir, () => undefined, { store });
    await drop(dir, 'one.json', { from: '1', to: '2' });
    await inbox.flush();
    expect(state).toMatchObject({ receipts: [{ key: 'one.json' }] });
    expect(await readdir(dir)).not.toContain('.inbox-state.json');
  });

  test('delivers only after activation, polls at pollIntervalMs and stops at stopAdmission', async () => {
    const dir = await directory();
    const seen: string[] = [];
    const { resource } = await open(dir, ({ key }) => void seen.push(key), {
      pollIntervalMs: 10,
      dependsOn: ['telegram'],
    });
    expect(resource.dependsOn).toEqual(['telegram']);
    await drop(dir, 'early.json', { from: '1', to: '2' });
    await Bun.sleep(40);
    expect(seen).toEqual([]);

    await resource.activate?.(context);
    await until(() => seen.length > 0);
    expect(seen).toEqual(['early.json']);
    await drop(dir, 'polled.json', { from: '2', to: '3' });
    await until(() => seen.length > 1);
    expect(seen).toEqual(['early.json', 'polled.json']);

    await resource.stopAdmission?.(context);
    await resource.drain?.(context);
    await drop(dir, 'late.json', { from: '3', to: '4' });
    await Bun.sleep(40);
    expect(seen).toEqual(['early.json', 'polled.json']);
    await resource.close?.(context);
  });

  test('force aborts the delivery in flight', async () => {
    const dir = await directory();
    let aborted = false;
    let started = false;
    const { resource } = await open(
      dir,
      ({ signal }) =>
        new Promise<void>((_, reject) => {
          started = true;
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      { pollIntervalMs: 10 },
    );
    await drop(dir, 'slow.json', { from: '1', to: '2' });
    await resource.activate?.(context);
    // Force a delivery that is in flight, which is what this is about — not a
    // race with the first poll.
    await until(() => started);
    await resource.force?.(context);
    expect(aborted).toBe(true);
    expect(await readdir(dir)).toContain('slow.json');
  });
});
