import { Database } from 'bun:sqlite';
import {
  type AgentRuntimeSqliteDatabase,
  type AgentRuntimeSqliteValue,
  createSqliteAgentRuntimeStore,
  type SqliteAgentRuntimeStore,
} from './agent-runtime/sqlite';

export interface BunSqliteAgentRuntimeStoreConfig {
  filename: string;
  create?: boolean;
  initialize?: boolean;
}

/** Bun `bun:sqlite` binding with non-blocking lock refusal on same-thread contention. */
export function createBunSqliteAgentRuntimeStore(
  config: BunSqliteAgentRuntimeStoreConfig,
): SqliteAgentRuntimeStore {
  const database = new Database(config.filename, {
    create: config.create ?? true,
    readwrite: true,
  });
  database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
  const boundary: AgentRuntimeSqliteDatabase = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.query(sql);
      return {
        get: (...parameters: AgentRuntimeSqliteValue[]) => statement.get(...parameters),
        all: (...parameters: AgentRuntimeSqliteValue[]) => statement.all(...parameters),
        run: (...parameters: AgentRuntimeSqliteValue[]) => {
          const result = statement.run(...parameters);
          return { changes: result.changes };
        },
      };
    },
    close: () => database.close(),
  };
  return createSqliteAgentRuntimeStore({
    database: boundary,
    initialize: config.initialize,
  });
}

export type {
  AgentRuntimeSqliteDatabase,
  AgentRuntimeSqliteStatement,
  AgentRuntimeSqliteValue,
  SqliteAgentRuntimeStore,
  SqliteAgentRuntimeStoreConfig,
} from './agent-runtime/sqlite';
export {
  createSqliteAgentRuntimeStore,
  initializeAgentRuntimeSqlite,
} from './agent-runtime/sqlite';
