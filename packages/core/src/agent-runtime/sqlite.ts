import type { AgentStoreEventEnvelope, AppendAgentStoreEvent } from '../durability/events';
import type { SqliteDatabase } from '../internal/sqlite';
import type { AgentConversationReader } from './conversations';
import { sqliteArchive, sqliteEvents } from './sqlite-events';
import { sqliteHistory } from './sqlite-history';
import { sqliteAdmissions, sqliteHeads, sqliteRuns, sqliteSeeds } from './sqlite-ledger';
import { sqliteConversationPurge } from './sqlite-purge';
import {
  listSqliteConversations,
  pageSqliteConversationMessages,
  scanSqliteRecoverable,
} from './sqlite-reads';
import type { SqliteStoreDriver } from './sqlite-rows';
import { initializeAgentRuntimeSqlite } from './sqlite-schema';
import {
  closeSqliteStore,
  createSqliteStoreState,
  runSqliteStoreScope,
  runSqliteTransaction,
} from './sqlite-transactions';
import { createAgentRuntimeStore } from './store-create';

export type { SqliteDatabase, SqliteStatement, SqliteValue } from '../internal/sqlite';

export interface SqliteAgentRuntimeStoreConfig {
  database: SqliteDatabase;
  /** Create or validate Stitchkit's namespaced schema. Default true. */
  initialize?: boolean;
}

export interface SqliteAgentRuntimeStore {
  store: ReturnType<typeof createAgentRuntimeStore<SqliteDatabase>>;
  conversations: AgentConversationReader;
  /**
   * The connection the store owns — for the SQLite-bound companions
   * (`createSqliteAgentProjectionStore`, `createSqliteAgentEventSearch`,
   * `createSqliteAgentSpillStore`, `createSqliteAgentChildManager`,
   * `createAgentScheduleService`), which share it rather than open a second.
   * Without this a consumer following the guide had to copy the adapter out
   * of the package source to reach any of them.
   */
  database: SqliteDatabase;
  /**
   * One write transaction shared with the store's own serialization.
   *
   * The companions that keep rows beside the ledger — spills, schedules,
   * children, projections — write their row and append their event here, in
   * the same transaction the store's operations queue behind. A bare write on
   * the shared connection used to land inside whatever store transaction was
   * open at that moment: a conflict's ROLLBACK took the row with it while the
   * event, queued separately, was still written.
   */
  transaction<RESULT>(
    work: (scope: SqliteStoreTransaction) => Promise<RESULT>,
  ): Promise<RESULT>;
  /** Refuse new work, wait for queued operations, then close the owned connection. */
  close(): Promise<void>;
}

/** What a companion may do inside one store transaction. */
export interface SqliteStoreTransaction {
  database: SqliteDatabase;
  appendEvent(input: AppendAgentStoreEvent): Promise<AgentStoreEventEnvelope>;
}

/**
 * The SQLite store: the normalized driver over one owned connection, and the
 * store built on it.
 *
 * Only the assembly lives here. The schema is in `sqlite-schema`, the
 * serialized transactions in `sqlite-transactions`, the driver members in
 * `sqlite-ledger`, `sqlite-history` and `sqlite-events`, the reads that open
 * their own transaction in `sqlite-reads`, and the purge in `sqlite-purge`.
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
  const driver: SqliteStoreDriver = {
    conversations: sqliteConversationPurge(database),
    transaction: (work, options) =>
      runSqliteTransaction(state, options?.access ?? 'write', work),
    head: sqliteHeads,
    runs: sqliteRuns,
    admissions: sqliteAdmissions,
    seeds: sqliteSeeds,
    history: sqliteHistory,
    events: sqliteEvents,
    archive: sqliteArchive,
    scanRecoverable: (input) => scanSqliteRecoverable(state, input),
  };

  return {
    store: createAgentRuntimeStore(driver),
    database,
    transaction: (work) => runSqliteStoreScope(state, driver, work),
    conversations: {
      list: (input) => listSqliteConversations(state, input),
      messages: (input) => pageSqliteConversationMessages(state, input),
    },
    close: () => closeSqliteStore(state),
  };
}
