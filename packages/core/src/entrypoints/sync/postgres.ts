/**
 * `stitchkit/sync/postgres` — the server half of a sync: version numbers that
 * commit in order, a ledger that runs each change once, and a feed of what
 * changed, inside the application's own transactions. A memory store and the
 * check every store keeps come with it.
 */

export type { PostgresQuery, PostgresSqlParameter } from '../../internal/postgres-query';
export {
  createSyncServerStore,
  type SyncApply,
  type SyncApplyDecision,
  type SyncFeedChange,
  type SyncFeedEntry,
  type SyncFeedPage,
  type SyncFeedRead,
  type SyncLedgerKey,
  type SyncLedgerRecord,
  type SyncPrune,
  type SyncPushChangeResult,
  type SyncPushOutcome,
  type SyncPushRequest,
  type SyncServerStore,
  type SyncStoreBackend,
  syncChangeFingerprint,
} from '../../sync/server-store';
export { checkSyncStore } from '../../sync/server-store-check';
export {
  type MemorySyncStoreConfig,
  type MemorySyncTransaction,
  memorySyncStore,
} from '../../sync/server-store-memory';
export {
  type PostgresSyncStoreConfig,
  postgresSyncStore,
  postgresSyncStoreDdl,
} from '../../sync/server-store-postgres';
