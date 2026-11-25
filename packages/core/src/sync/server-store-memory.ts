/**
 * The sync server store in memory — for tests and for a single process that
 * keeps nothing across restarts. It keeps the rules Postgres keeps: transactions
 * run one at a time on a working copy that replaces the committed tables only on
 * commit, so a reader never sees a version an open transaction holds, and a
 * throw leaves nothing behind. A transaction opened inside another one is
 * refused — it would wait for itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMutationQueue } from '../internal/mutation-queue';
import { assertNonNegativeSafeInteger } from '../internal/positive-integer';
import {
  createSyncServerStore,
  type SyncFeedChange,
  type SyncLedgerKey,
  type SyncLedgerRecord,
  type SyncServerStore,
} from './server-store';

/** The handle a memory transaction gives its work; it carries nothing a caller reads. */
export interface MemorySyncTransaction {
  readonly memory: true;
}

interface Tables {
  counters: Map<string, number>;
  feed: Map<string, SyncFeedChange & { readonly scope: string }>;
  ledger: Map<string, SyncLedgerRecord & { readonly scope: string }>;
}

const clone = (tables: Tables): Tables => ({
  counters: new Map(tables.counters),
  feed: new Map(tables.feed),
  ledger: new Map(tables.ledger),
});

/** Configuration options for `memorySyncStore`. */
export interface MemorySyncStoreConfig {
  /** The version before the first a scope hands out. Default 0. */
  readonly startAfter?: number;
  readonly now?: () => number;
}

/** Create an in-memory transactional `SyncServerStore` for tests and single-process hosts. */
export function memorySyncStore(
  config: MemorySyncStoreConfig = {},
): SyncServerStore<MemorySyncTransaction> {
  const startAfter = config.startAfter ?? 0;
  assertNonNegativeSafeInteger('[stitchkit] sync store: startAfter', startAfter, RangeError);
  let committed: Tables = { counters: new Map(), feed: new Map(), ledger: new Map() };
  let working: Tables | undefined;
  const queue = createMutationQueue();
  const inside = new AsyncLocalStorage<true>();
  const handle: MemorySyncTransaction = { memory: true };
  const open = (): Tables => {
    if (!working) throw new Error('[stitchkit] sync store: this call needs its transaction');
    return working;
  };
  const ledgerKey = (key: SyncLedgerKey) =>
    JSON.stringify([key.scope, key.replicaId, key.changeId]);
  return createSyncServerStore<MemorySyncTransaction>(
    {
      transaction: (work) => {
        if (inside.getStore())
          return Promise.reject(
            new Error('[stitchkit] sync store: a transaction cannot open another one'),
          );
        return queue(() =>
          inside.run(true, async () => {
            working = clone(committed);
            try {
              const result = await work(handle);
              committed = working;
              return result;
            } finally {
              working = undefined;
            }
          }),
        );
      },
      allocateVersions: async (_tx, scope, count) => {
        const tables = open();
        const last = (tables.counters.get(scope) ?? startAfter) + count;
        tables.counters.set(scope, last);
        return Array.from({ length: count }, (_, index) => last - count + 1 + index);
      },
      upsertFeed: async (_tx, scope, changes) => {
        const tables = open();
        for (const change of changes)
          tables.feed.set(JSON.stringify([scope, change.entity, change.entityId]), {
            scope,
            ...change,
          });
      },
      readLedger: async (_tx, key) => open().ledger.get(ledgerKey(key)),
      writeLedger: async (_tx, key, record) => {
        open().ledger.set(ledgerKey(key), { ...record, scope: key.scope });
      },
      changesAfter: async (scope, after, read) => {
        const tables = committed;
        const rows = [...tables.feed.values()]
          .filter(
            (row) =>
              row.scope === scope && row.version > (after ?? 0) && !(read.full && row.deleted),
          )
          .toSorted((left, right) => left.version - right.version);
        const page = rows.slice(0, read.limit);
        const hasMore = rows.length > read.limit;
        return {
          changes: page.map(({ scope: _scope, ...change }) => change),
          hasMore,
          nextCursor: hasMore ? (page.at(-1)?.version ?? null) : null,
          latestVersion: tables.counters.get(scope) ?? startAfter,
        };
      },
      prune: ({ before, scope }) =>
        queue(async () => {
          let removed = 0;
          for (const [key, record] of committed.ledger) {
            if (
              record.recordedAt < before &&
              (scope === undefined || record.scope === scope)
            ) {
              committed.ledger.delete(key);
              removed += 1;
            }
          }
          return removed;
        }),
    },
    config.now ? { now: config.now } : {},
  );
}
