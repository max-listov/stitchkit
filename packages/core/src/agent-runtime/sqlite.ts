import type { SqliteDatabase } from '../internal/sqlite';
import { type AgentCompanionHost, createCompanionHost } from './companion-host';
import type { AgentConversationReader } from './conversations';
import { sqlArchive, sqlEvents } from './sql-events';
import { sqlHistory } from './sql-history';
import { sqlLedger } from './sql-ledger';
import { sqlConversationPurge } from './sql-purge';
import {
  type AgentSqlRead,
  listSqlConversations,
  pageSqlConversationMessages,
  scanSqlRecoverable,
} from './sql-reads';
import type { SqlStoreDriver } from './sql-rows';
import { sqlitePurgeInstalled } from './sqlite-purge';
import { initializeAgentRuntimeSqlite } from './sqlite-schema';
import {
  closeSqliteStore,
  createSqliteStoreState,
  enterSqliteScope,
  runSqliteTransaction,
  sqliteDialect,
} from './sqlite-transactions';
import { createAgentRuntimeStore } from './store-create';

export type { SqliteDatabase, SqliteStatement, SqliteValue } from '../internal/sqlite';

export interface SqliteAgentRuntimeStoreConfig {
  database: SqliteDatabase;
  /** Create or validate Stitchkit's namespaced schema. Default true. */
  initialize?: boolean;
}

export interface SqliteAgentRuntimeStore {
  store: ReturnType<typeof createAgentRuntimeStore>;
  conversations: AgentConversationReader;
  /**
   * Where the companions keep their rows — schedules, children, spills,
   * projections and the event search — in this store's own transactions.
   * Pass it to their factories; it is the same host the Postgres store gives.
   */
  host: AgentCompanionHost;
  /** Refuse new work, wait for queued operations, then close the owned connection. */
  close(): Promise<void>;
}

/**
 * The SQLite store: the shared SQL driver over one owned connection, and the
 * store built on it.
 *
 * Only the assembly lives here. The schema is in `sqlite-schema`, the
 * serialized transactions in `sqlite-transactions`, and the driver members —
 * written once for SQLite and Postgres — in `sql-ledger`, `sql-history`,
 * `sql-events`, `sql-purge` and `sql-reads`.
 */
export function createSqliteAgentRuntimeStore(
  config: SqliteAgentRuntimeStoreConfig,
): SqliteAgentRuntimeStore {
  const database = config.database;
  if (config.initialize !== false) {
    try {
      initializeAgentRuntimeSqlite(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  const state = createSqliteStoreState(database);
  const read: AgentSqlRead = (work) => runSqliteTransaction(state, 'read', work);
  const driver: SqlStoreDriver = {
    ...(sqlitePurgeInstalled(database) && {
      conversations: sqlConversationPurge(sqliteDialect),
    }),
    transaction: (work, options) =>
      runSqliteTransaction(state, options?.access ?? 'write', work),
    ...sqlLedger(sqliteDialect),
    history: sqlHistory(sqliteDialect),
    events: sqlEvents(sqliteDialect),
    archive: sqlArchive(sqliteDialect),
    scanRecoverable: (input) => scanSqlRecoverable(sqliteDialect, read, input),
  };
  return {
    store: createAgentRuntimeStore(driver),
    host: createCompanionHost({
      dialect: sqliteDialect,
      driver,
      enterScope: (work) => enterSqliteScope(state, work),
    }),
    conversations: {
      list: (input) => listSqlConversations(sqliteDialect, read, input),
      messages: (input) => pageSqlConversationMessages(sqliteDialect, read, input),
    },
    close: () => closeSqliteStore(state),
  };
}
