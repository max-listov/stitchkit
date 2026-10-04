import { expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectoryInbox } from '../src/application/directory-inbox';
import {
  type DirectoryInboxConfig,
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

test('programmatic acceptance is durable, deduplicated across restart and delivers the original full identity', async () => {
  const dir = await inboxDirectory();
  const producer = await openInbox(dir, () => {
    throw new Error('not activated');
  });
  const accepted = await producer.inbox.accept({ ...identity, entry: { text: 'first' } });
  expect(accepted.status).toBe('accepted');
  expect(JSON.parse(await readFile(join(dir, accepted.filename), 'utf8'))).toEqual({
    schemaVersion: 1,
    identity,
    entry: { text: 'first' },
  });
  const seen: unknown[] = [];
  const restarted = await openInbox(dir, ({ entry, identity: actual }) => {
    seen.push({ entry, identity: actual });
  });
  expect(await restarted.inbox.accept({ ...identity, entry: { text: 'changed' } })).toEqual({
    ...accepted,
    status: 'duplicate',
  });
  expect(await restarted.inbox.flush()).toBe(1);
  expect(seen).toEqual([{ entry: { text: 'first' }, identity }]);
  expect(
    await restarted.inbox.accept({ ...identity, entry: { text: 'after receipt' } }),
  ).toEqual({ ...accepted, status: 'duplicate' });
  expect(await restarted.inbox.flush()).toBe(0);
});

test('same keys from different sources are distinct and concurrent acceptance never overwrites', async () => {
  const dir = await inboxDirectory();
  const first = await openInbox(dir, () => undefined);
  const second = await openInbox(dir, () => undefined);
  const results = await Promise.all([
    first.inbox.accept({ ...identity, entry: { text: 'A' } }),
    second.inbox.accept({ ...identity, entry: { text: 'B' } }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'duplicate']);
  expect(results[0]?.filename).toBe(results[1]?.filename);
  const other = await second.inbox.accept({
    ...identity,
    source: 'other',
    entry: { text: 'C' },
  });
  expect(other.status).toBe('accepted');
  expect(other.filename).not.toBe(results[0]?.filename);
  expect((await readdir(dir)).filter((name) => name.startsWith('intake-'))).toHaveLength(2);
});

test('UTF-8 bytes at N are accepted and N+1 is rejected without a queue file', async () => {
  const entry = { text: 'ёж' };
  const bytes = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: 1, identity, entry }),
  ).byteLength;
  const exactDir = await inboxDirectory();
  const exact = await openInbox(exactDir, () => undefined, { maxEntryBytes: bytes });
  expect((await exact.inbox.accept({ ...identity, entry })).status).toBe('accepted');
  expect(await exact.inbox.flush()).toBe(1);
  const smallDir = await inboxDirectory();
  const small = await openInbox(smallDir, () => undefined, { maxEntryBytes: bytes - 1 });
  await expect(small.inbox.accept({ ...identity, entry })).rejects.toThrow('maxEntryBytes');
  expect(await readdir(smallDir)).toEqual([]);
});

test('schema, identity and lossless JSON failures create no durable side effect', async () => {
  const dir = await inboxDirectory();
  const { inbox } = await openInbox(dir, () => undefined);
  await expect(
    inbox.accept({ source: '', key: 'one', entry: { text: 'x' } }),
  ).rejects.toBeDefined();
  await expect(
    inbox.accept({ ...identity, key: 'x'.repeat(1_025), entry: { text: 'x' } }),
  ).rejects.toBeDefined();
  // @ts-expect-error a public payload is checked both statically and at runtime
  await expect(inbox.accept({ ...identity, entry: { text: 1 } })).rejects.toBeDefined();
  const resource = createDirectoryInbox({
    id: 'json',
    directory: dir,
    schema: z.unknown(),
    handle: () => undefined,
  });
  const { value } = await resource.start();
  const cyclic: { next?: unknown } = {};
  cyclic.next = cyclic;
  for (const entry of [undefined, NaN, -0, 1n, new Date(), [undefined], cyclic])
    await expect(value.accept({ ...identity, entry })).rejects.toThrow('lossless JSON');
  expect(await readdir(dir)).toEqual([]);
});

test('capacity includes pending legacy files, permits duplicates and releases capacity after delivery', async () => {
  const dir = await inboxDirectory();
  const { inbox } = await openInbox(dir, () => undefined, { maxPendingEntries: 1 });
  const one = await inbox.accept({ ...identity, entry: { text: 'one' } });
  expect((await inbox.accept({ ...identity, entry: { text: 'duplicate' } })).status).toBe(
    'duplicate',
  );
  await expect(
    inbox.accept({ ...identity, key: 'two', entry: { text: 'two' } }),
  ).rejects.toThrow('maxPendingEntries');
  expect((await readdir(dir)).filter((name) => name.startsWith('intake-'))).toEqual([
    one.filename,
  ]);
  await inbox.flush();
  await writeFile(join(dir, 'legacy.json'), JSON.stringify({ text: 'legacy' }));
  await expect(
    inbox.accept({ ...identity, key: 'two', entry: { text: 'two' } }),
  ).rejects.toThrow('maxPendingEntries');
  await inbox.flush();
  expect(
    (await inbox.accept({ ...identity, key: 'two', entry: { text: 'two' } })).status,
  ).toBe('accepted');
});

test('producer can buffer before activation and rejects acceptance after stopAdmission or close', async () => {
  const dir = await inboxDirectory();
  let delivered = 0;
  const { inbox, resource } = await openInbox(dir, () => {
    delivered += 1;
  });
  await inbox.accept({ ...identity, entry: { text: 'buffered' } });
  await Bun.sleep(30);
  expect(delivered).toBe(0);
  await resource.stopAdmission?.({} as never);
  await expect(
    inbox.accept({ ...identity, key: 'late', entry: { text: 'late' } }),
  ).rejects.toThrow('not accepting');
  await resource.close?.({} as never);
  expect(delivered).toBe(0);
  expect((await readdir(dir)).filter((name) => name.startsWith('intake-'))).toHaveLength(1);
});

test('an expired rejected entry remains deduplicated by its durable rejected envelope', async () => {
  const dir = await inboxDirectory();
  const time = clock();
  const resource = await openInbox(
    dir,
    () => {
      throw new Error('rejected');
    },
    { clock: time.now, maxAttempts: 1, retain: 1 },
  );
  const accepted = await resource.inbox.accept({ ...identity, entry: { text: 'one' } });
  await resource.inbox.flush();
  time.advance(1_000);
  await resource.inbox.flush();
  expect(await readdir(join(dir, 'rejected'))).toEqual([accepted.filename]);
  expect((await resource.inbox.accept({ ...identity, entry: { text: 'retry' } })).status).toBe(
    'duplicate',
  );
});

test('an aborted uncooperative handler leaves its entry unsettled even if it returns later', async () => {
  const dir = await inboxDirectory();
  const entered = deferred();
  const release = deferred();
  const { resource, inbox } = await openInbox(dir, async () => {
    entered.resolve();
    await release.promise;
  });
  const accepted = await inbox.accept({ ...identity, entry: { text: 'one' } });
  const flushing = inbox.flush();
  await entered.promise;
  await resource.force?.({} as never);
  expect(await flushing).toBe(0);
  release.resolve();
  await Bun.sleep(20);
  expect((await inbox.state()).receipts).toEqual([]);
  expect(await readdir(dir)).toContain(accepted.filename);
});

test('lost acceptance acknowledgement is recovered as duplicate without replacing the published payload', async () => {
  const dir = await inboxDirectory();
  const base = createFileStateStore(join(dir, '.inbox-state.json'), {
    schema: DirectoryInboxStateSchema,
  });
  let fail = true;
  const store: StateStore<DirectoryInboxState> = {
    read: () => base.read(),
    update: (transition) =>
      base.update(async (current, context) => {
        const next = await transition(current, context);
        if (fail) {
          fail = false;
          throw new Error('state write refused after publication');
        }
        return next;
      }),
  };
  const seen: string[] = [];
  const { inbox } = await openInbox(
    dir,
    ({ entry }) => {
      seen.push(entry.text);
    },
    { store },
  );
  await expect(inbox.accept({ ...identity, entry: { text: 'original' } })).rejects.toThrow(
    'after publication',
  );
  expect((await readdir(dir)).filter((name) => name.startsWith('intake-'))).toHaveLength(1);
  expect((await inbox.accept({ ...identity, entry: { text: 'changed' } })).status).toBe(
    'duplicate',
  );
  expect(await inbox.flush()).toBe(1);
  expect(seen).toEqual(['original']);
});

test('close waits for already accepted storage work and rejects later producers', async () => {
  const dir = await inboxDirectory();
  const base = createFileStateStore(join(dir, '.inbox-state.json'), {
    schema: DirectoryInboxStateSchema,
  });
  const entered = deferred();
  const release = deferred();
  const store: StateStore<DirectoryInboxState> = {
    read: () => base.read(),
    update: (transition) =>
      base.update(async (current, context) => {
        const next = await transition(current, context);
        entered.resolve();
        await release.promise;
        return next;
      }),
  };
  const { inbox, resource } = await openInbox(dir, () => undefined, { store });
  const accepting = inbox.accept({ ...identity, entry: { text: 'before close' } });
  await entered.promise;
  let closed = false;
  const closing = Promise.resolve(resource.close?.({} as never)).then(() => {
    closed = true;
  });
  await Bun.sleep(20);
  expect(closed).toBe(false);
  await expect(
    inbox.accept({ ...identity, key: 'late', entry: { text: 'late' } }),
  ).rejects.toThrow('not accepting');
  release.resolve();
  expect((await accepting).status).toBe('accepted');
  await closing;
  expect(closed).toBe(true);
});

test('inbox limits refuse nonfinite, fractional, zero and oversized configurations at construction', () => {
  const invalid: Partial<DirectoryInboxConfig<{ text: string }>>[] = [
    ...[0, 9, 2_147_483_648, NaN].map((pollIntervalMs) => ({ pollIntervalMs })),
    ...[0, 99, 2_147_483_648, Infinity].map((leaseMs) => ({ leaseMs })),
    ...[0, 10_001, 1.5].map((maxAttempts) => ({ maxAttempts })),
    ...[0, Infinity, Number.MAX_SAFE_INTEGER + 1].map((maxEntryBytes) => ({ maxEntryBytes })),
    ...[0, 100_001, 1.5].map((maxPendingEntries) => ({ maxPendingEntries })),
    ...[0, 100_001, 1.5].map((retain) => ({ retain })),
  ];
  for (const options of invalid)
    expect(() =>
      createDirectoryInbox({
        id: 'bounds',
        directory: '/nonexistent/inbox',
        schema: z.object({ text: z.string() }),
        handle: () => undefined,
        ...options,
      }),
    ).toThrow();
});
