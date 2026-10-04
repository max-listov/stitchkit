import { expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectoryInbox } from '../src/application/directory-inbox';
import {
  type DirectoryInboxState,
  DirectoryInboxStateSchema,
} from '../src/application/directory-inbox-contract';
import { createFileStateStore } from '../src/application/file-state-store';
import type { StateStore } from '../src/application/state-store';
import {
  clock,
  deferred,
  identity,
  inboxDirectory,
  openInbox,
} from './application-directory-inbox-fixture';

test('concurrent inboxes share one claim and a long handler renews its lease', async () => {
  const dir = await inboxDirectory();
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const first = await openInbox(
    dir,
    async () => {
      attempts += 1;
      entered.resolve();
      await release.promise;
    },
    { leaseMs: 100 },
  );
  const second = await openInbox(
    dir,
    () => {
      attempts += 1;
    },
    { leaseMs: 100 },
  );
  await first.inbox.accept({ ...identity, entry: { text: 'long' } });
  const flushing = first.inbox.flush();
  await entered.promise;
  try {
    await Bun.sleep(180);
    expect(await second.inbox.flush()).toBe(0);
    expect(attempts).toBe(1);
  } finally {
    release.resolve();
  }
  expect(await flushing).toBe(1);
  expect((await first.inbox.state()).receipts).toHaveLength(1);
});

test('an expired handler cannot complete a successor lease or delete its file', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  const entered = deferred();
  const release = deferred();
  const first = await openInbox(
    dir,
    async () => {
      entered.resolve();
      await release.promise;
    },
    { clock: time.now, leaseMs: 60_000 },
  );
  const accepted = await first.inbox.accept({ ...identity, entry: { text: 'one' } });
  const original = first.inbox.flush();
  await entered.promise;
  time.advance(60_001);
  const successorEntered = deferred();
  const successorRelease = deferred();
  const second = await openInbox(
    dir,
    async () => {
      successorEntered.resolve();
      await successorRelease.promise;
    },
    { clock: time.now, leaseMs: 60_000 },
  );
  const successor = second.inbox.flush();
  await successorEntered.promise;
  const currentLease = (await second.inbox.state()).claims[0]?.leaseId;
  release.resolve();
  expect(await original).toBe(0);
  expect((await second.inbox.state()).claims[0]?.leaseId).toBe(currentLease);
  expect((await second.inbox.state()).receipts).toEqual([]);
  expect(await readdir(dir)).toContain(accepted.filename);
  successorRelease.resolve();
  expect(await successor).toBe(1);
});

test('an expired failure cannot release or postpone a successor lease', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  const entered = deferred();
  const fail = deferred();
  const first = await openInbox(
    dir,
    async () => {
      entered.resolve();
      await fail.promise;
      throw new Error('stale');
    },
    { clock: time.now, leaseMs: 60_000 },
  );
  await first.inbox.accept({ ...identity, entry: { text: 'one' } });
  const old = first.inbox.flush();
  await entered.promise;
  time.advance(60_001);
  const newEntered = deferred();
  const finish = deferred();
  const second = await openInbox(
    dir,
    async () => {
      newEntered.resolve();
      await finish.promise;
    },
    { clock: time.now, leaseMs: 60_000 },
  );
  const fresh = second.inbox.flush();
  await newEntered.promise;
  const claim = (await second.inbox.state()).claims[0];
  fail.resolve();
  expect(await old).toBe(0);
  expect((await second.inbox.state()).claims[0]).toEqual(claim);
  finish.resolve();
  expect(await fresh).toBe(1);
});

test('schema rejection after lease expiry leaves the entry unsettled', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  await writeFile(join(dir, 'invalid.json'), JSON.stringify({ text: 'one' }));
  const schema = z.object({ text: z.string() }).refine(() => {
    time.advance(60_001);
    return false;
  });
  const resource = createDirectoryInbox({
    id: 'expiry',
    directory: dir,
    schema,
    clock: time.now,
    leaseMs: 60_000,
    handle: () => {
      throw new Error('must not run');
    },
  });
  const { value } = await resource.start();
  expect(await value.flush()).toBe(0);
  expect((await value.state()).rejected).toEqual([]);
  expect(await readdir(dir)).toContain('invalid.json');
});

test('failed receipt commit never deletes the pending entry before a successor can retry', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  const base = createFileStateStore(join(dir, '.inbox-state.json'), {
    schema: DirectoryInboxStateSchema,
  });
  let fail = true;
  const store: StateStore<DirectoryInboxState> = {
    read: () => base.read(),
    update: (transition) =>
      base.update(async (current, context) => {
        const next = await transition(current, context);
        if (fail && next.state.receipts.length > (current?.receipts.length ?? 0))
          throw new Error('receipt commit failed');
        return next;
      }),
  };
  let effects = 0;
  const first = await openInbox(
    dir,
    () => {
      effects += 1;
    },
    { store, clock: time.now, leaseMs: 60_000 },
  );
  const accepted = await first.inbox.accept({ ...identity, entry: { text: 'one' } });
  await expect(first.inbox.flush()).rejects.toThrow('receipt commit failed');
  expect(await readdir(dir)).toContain(accepted.filename);
  expect((await first.inbox.state()).receipts).toEqual([]);
  fail = false;
  time.advance(60_001);
  const successor = await openInbox(
    dir,
    () => {
      effects += 1;
    },
    { store, clock: time.now, leaseMs: 60_000 },
  );
  expect(await successor.inbox.flush()).toBe(1);
  expect(effects).toBe(2); // Handler effects need their own idempotency key: delivery is at least once.
  expect(await readdir(dir)).not.toContain(accepted.filename);
});

test('delayed cleanup cannot delete a newly accepted file after receipt eviction, even with an equal timestamp', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  const base = createFileStateStore(join(dir, '.inbox-state.json'), {
    schema: DirectoryInboxStateSchema,
  });
  const cleanupEntered = deferred();
  const cleanupRelease = deferred();
  let pauseNext = false;
  let paused = false;
  const store: StateStore<DirectoryInboxState> = {
    read: () => base.read(),
    async update(transition) {
      if (pauseNext && !paused) {
        paused = true;
        cleanupEntered.resolve();
        await cleanupRelease.promise;
      }
      return base.update(async (current, context) => {
        const next = await transition(current, context);
        if (next.state.receipts.length > (current?.receipts.length ?? 0)) pauseNext = true;
        return next;
      });
    },
  };
  const first = await openInbox(dir, () => undefined, { store, clock: time.now });
  const accepted = await first.inbox.accept({ ...identity, entry: { text: 'old' } });
  const flushing = first.inbox.flush();
  await cleanupEntered.promise;
  const receipt = (await first.inbox.state()).receipts[0];
  expect(receipt).toBeDefined();
  const successor = await openInbox(dir, () => undefined, { store: base, clock: time.now });
  expect(await successor.inbox.flush()).toBe(0); // Completes the old generation's recovery cleanup.
  await base.update((current) => ({
    state: { ...DirectoryInboxStateSchema.parse(current), receipts: [] },
    result: undefined,
  }));
  expect((await successor.inbox.accept({ ...identity, entry: { text: 'new' } })).status).toBe(
    'accepted',
  );
  // Crash trace: this generation committed its receipt at the same clock tick,
  // and stopped before cleanup. The old cleanup must also compare the file inode.
  await base.update((current) => ({
    state: { ...DirectoryInboxStateSchema.parse(current), receipts: receipt ? [receipt] : [] },
    result: undefined,
  }));
  cleanupRelease.resolve();
  expect(await flushing).toBe(1);
  expect(JSON.parse(await readFile(join(dir, accepted.filename), 'utf8')).entry).toEqual({
    text: 'new',
  });
});
