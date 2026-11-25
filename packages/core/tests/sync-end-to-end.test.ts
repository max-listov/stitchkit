/**
 * The two halves together: a client session paging a server feed. The case a
 * consuming app ships wrong — an entity deleted while a full snapshot is being
 * paged, after its page went by — must still disappear on the client.
 */
import { expect, test } from 'bun:test';
import {
  createSyncSession,
  type SyncPageHeader,
  type SyncPageRequest,
  type SyncSnapshotResume,
  staleAfterFullSync,
} from '../src/entrypoints/sync';
import { memorySyncStore, type SyncFeedChange } from '../src/entrypoints/sync/postgres';

type Page = SyncPageHeader & { readonly changes: readonly SyncFeedChange[] };

test('an entity deleted during a paged full snapshot is deleted on the client too', async () => {
  const store = memorySyncStore();
  const scope = 'account';
  await store.transaction((tx) =>
    store.publish(
      tx,
      scope,
      ['a', 'b', 'c'].map((entityId) => ({ entity: 'task', entityId, deleted: false })),
    ),
  );
  const client = new Map<string, boolean>();
  let cursor: number | null = null;
  let pages = 0;
  const session = createSyncSession<Page>({
    isConnected: () => true,
    readCursor: () => cursor,
    beginFullSync: () => {
      cursor = null;
    },
    send: (request) => {
      void store
        .changesAfter(scope, request.after, { limit: 1, full: request.full })
        .then(async (feed) => {
          pages += 1;
          // After the first page went by, `a` is deleted on the server.
          if (pages === 1)
            await store.transaction((tx) =>
              store.publish(tx, scope, [{ entity: 'task', entityId: 'a', deleted: true }]),
            );
          return session.handleResponse({
            sessionId: request.sessionId,
            requestId: request.requestId,
            hasMore: feed.hasMore,
            nextCursor: feed.nextCursor,
            latestVersion: feed.latestVersion,
            full: request.full,
            changes: feed.changes,
          });
        });
    },
    apply: (page) => {
      for (const change of page.changes)
        if (change.deleted) client.delete(change.entityId);
        else client.set(change.entityId, true);
    },
    saveCursor: (version) => {
      cursor = version ?? cursor;
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    schedule: () => () => undefined,
  });
  await session.requestSync();
  for (let turn = 0; turn < 50 && session.diagnostics().mode !== null; turn += 1)
    await Bun.sleep(1);
  await Bun.sleep(5);
  expect(session.diagnostics().mode).toBeNull();
  expect([...client.keys()].toSorted()).toEqual(['b', 'c']);
});

test('a server-promoted full snapshot delivers every record below the client’s old cursor without skipping pages', async () => {
  const store = memorySyncStore();
  const scope = 'account';
  await store.transaction(async (tx) => {
    await store.publish(
      tx,
      scope,
      ['t1', 't2', 't3', 't4', 't5'].map((entityId) => ({
        entity: 'task',
        entityId,
        deleted: false,
      })),
    );
    await store.publish(
      tx,
      scope,
      Array.from({ length: 49 }, (_, index) => ({
        entity: 'task',
        entityId: `churn-${index}`,
        deleted: true,
      })),
    );
    await store.publish(tx, scope, [{ entity: 'task', entityId: 't6', deleted: false }]);
  });

  const client = new Map<string, boolean>([['stale', true]]);
  const requests: Array<{ after: number | null; full: boolean }> = [];
  const savedProgress: Array<number | SyncSnapshotResume> = [];
  let cursor: number | null = 50;

  const session = createSyncSession<Page>({
    isConnected: () => true,
    readCursor: () => cursor,
    beginFullSync: () => {
      cursor = null;
      client.clear();
    },
    saveProgress: (progress) => {
      savedProgress.push(progress);
    },
    send: (request) => {
      requests.push({ after: request.after, full: request.full });
      const promoted = !request.full && request.after !== null && request.after <= 50;
      const full = request.full || promoted;
      const after = promoted ? null : request.after;
      void store.changesAfter(scope, after, { limit: 2, full }).then((feed) =>
        session.handleResponse({
          sessionId: request.sessionId,
          requestId: request.requestId,
          hasMore: feed.hasMore,
          nextCursor: feed.nextCursor,
          latestVersion: feed.latestVersion,
          full,
          changes: feed.changes,
        }),
      );
    },
    apply: (page) => {
      for (const change of page.changes)
        if (change.deleted) client.delete(change.entityId);
        else client.set(change.entityId, true);
    },
    saveCursor: (version) => {
      cursor = version ?? cursor;
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    retry: { minDelayMs: 1, maxDelayMs: 5, jitter: 0 },
  });

  await session.requestSync();
  for (let turn = 0; turn < 100 && session.diagnostics().mode !== null; turn += 1)
    await Bun.sleep(1);
  await Bun.sleep(10);
  session.stop();

  expect(session.diagnostics().mode).toBeNull();
  expect(session.diagnostics().lastFailure).toBeNull();
  expect([...client.keys()].toSorted()).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
  expect(requests).toEqual([
    { after: 50, full: false },
    { after: 2, full: true },
    { after: 4, full: true },
  ]);
  const snapshot = expect.any(String);
  expect(savedProgress).toEqual([
    { snapshot, after: 2, from: 55 },
    { snapshot, after: 4, from: 55 },
  ]);
  expect(cursor).toBe(55);
});

test('a snapshot by version cut by a restart continues as a snapshot: a delete made while it ran still arrives', async () => {
  const store = memorySyncStore();
  const scope = 'account';
  const publish = (entries: ReadonlyArray<readonly [string, boolean]>) =>
    store.transaction((tx) =>
      store.publish(
        tx,
        scope,
        entries.map(([entityId, deleted]) => ({ entity: 'task', entityId, deleted })),
      ),
    );
  await publish(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => [id, false] as const));
  // What survives the restart: the projection and whatever the session saved.
  const client = new Map<string, boolean>();
  const durable: { saved: number | SyncSnapshotResume | null } = { saved: null };
  const events: string[] = [];
  const open = (afterPage: (page: number) => Promise<unknown>) => {
    const waiting: SyncPageRequest[] = [];
    const session = createSyncSession<Page>({
      isConnected: () => true,
      readCursor: () => durable.saved,
      beginFullSync: () => {
        durable.saved = null;
      },
      saveProgress: (progress) => {
        durable.saved = progress;
      },
      rebasePending: () => {
        events.push('rebase');
      },
      send: (request) => waiting.push(request),
      apply: (page) => {
        for (const change of page.changes)
          if (change.deleted) client.delete(change.entityId);
          else client.set(change.entityId, true);
      },
      saveCursor: (version) => {
        durable.saved = version ?? durable.saved;
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      schedule: () => () => undefined,
    });
    const pump = async (pages = Number.POSITIVE_INFINITY) => {
      for (let page = 1; page <= pages; page += 1) {
        const request = waiting.shift();
        if (!request) return;
        const feed = await store.changesAfter(scope, request.after, {
          limit: 2,
          full: request.full,
        });
        await session.handleResponse({
          sessionId: request.sessionId,
          requestId: request.requestId,
          hasMore: feed.hasMore,
          nextCursor: feed.nextCursor,
          latestVersion: feed.latestVersion,
          full: request.full,
          changes: feed.changes,
        });
        await afterPage(page);
      }
    };
    return { session, pump };
  };
  // The snapshot begins at version 6. After its first page `a` is deleted (7) and `c`, `d`
  // change (8, 9); after its second `b` changes (10). Its third page stands at 9 — past the
  // delete — when the process stops.
  const before = open(async (page) => {
    if (page === 1)
      await publish([
        ['a', true],
        ['c', false],
        ['d', false],
      ]);
    if (page === 2) await publish([['b', false]]);
  });
  await before.session.requestSync();
  await before.pump(3);
  before.session.stop();

  const after = open(async () => undefined);
  await after.session.requestSync();
  await after.pump();

  expect([...client.keys()].toSorted()).toEqual(['b', 'c', 'd', 'e', 'f']);
  expect(events).toEqual(['rebase']);
  expect(durable.saved).toBe(10);
});

test('a snapshot continued after a restart keeps its id, so the rows it marked before stay live', async () => {
  const store = memorySyncStore();
  const scope = 'account';
  await store.transaction((tx) =>
    store.publish(
      tx,
      scope,
      ['a', 'b', 'c', 'd', 'e', 'f'].map((entityId) => ({
        entity: 'task',
        entityId,
        deleted: false,
      })),
    ),
  );
  // Durable: each row with the snapshot that last named it, and the saved progress. `z` is a
  // row an earlier snapshot named that the server no longer has.
  const rows = new Map<string, string | null>([['z', 'an-earlier-snapshot']]);
  const durable: { saved: number | SyncSnapshotResume | null } = { saved: null };
  const removed: string[] = [];
  const open = () => {
    const waiting: SyncPageRequest[] = [];
    const session = createSyncSession<Page>({
      isConnected: () => true,
      readCursor: () => durable.saved,
      beginFullSync: () => {
        durable.saved = null;
      },
      saveProgress: (progress) => {
        durable.saved = progress;
      },
      // The guide's cleanup: the rows this snapshot marked are the ones it named.
      rebasePending: (snapshot) => {
        const named = new Set(
          [...rows].filter(([, mark]) => mark === snapshot).map(([id]) => id),
        );
        for (const id of staleAfterFullSync({ local: rows.keys(), server: named })) {
          rows.delete(id);
          removed.push(id);
        }
      },
      send: (request) => waiting.push(request),
      apply: (page, { snapshot }) => {
        for (const change of page.changes)
          if (change.deleted) rows.delete(change.entityId);
          // An incremental page keeps the mark: only a snapshot names its rows.
          else rows.set(change.entityId, snapshot ?? rows.get(change.entityId) ?? null);
      },
      saveCursor: (version) => {
        durable.saved = version ?? durable.saved;
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      schedule: () => () => undefined,
    });
    const pump = async (pages = Number.POSITIVE_INFINITY) => {
      for (let page = 1; page <= pages; page += 1) {
        const request = waiting.shift();
        if (!request) return;
        const feed = await store.changesAfter(scope, request.after, {
          limit: 2,
          full: request.full,
        });
        await session.handleResponse({
          sessionId: request.sessionId,
          requestId: request.requestId,
          hasMore: feed.hasMore,
          nextCursor: feed.nextCursor,
          latestVersion: feed.latestVersion,
          full: request.full,
          changes: feed.changes,
        });
      }
    };
    return { session, pump };
  };
  const before = open();
  await before.session.requestSync();
  await before.pump(2);
  before.session.stop();
  const marked = new Set(['a', 'b', 'c', 'd'].map((id) => rows.get(id) ?? null));
  expect(marked.size).toBe(1);
  expect(durable.saved).toMatchObject({ after: 4, from: 6, snapshot: [...marked][0] });

  const after = open();
  await after.session.requestSync();
  await after.pump();

  expect([...rows.keys()].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  expect(removed).toEqual(['z']);
  expect(new Set(rows.values())).toEqual(marked);
});
