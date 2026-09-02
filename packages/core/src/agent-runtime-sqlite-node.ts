import { DatabaseSync } from 'node:sqlite';
import {
  createSqliteAgentRuntimeStore,
  type SqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from './agent-runtime/sqlite';

export interface NodeSqliteAgentRuntimeStoreConfig {
  filename: string;
  readOnly?: boolean;
  initialize?: boolean;
}

/** Node built-in `node:sqlite` binding with non-blocking lock refusal on contention. */
export function createNodeSqliteAgentRuntimeStore(
  config: NodeSqliteAgentRuntimeStoreConfig,
): SqliteAgentRuntimeStore {
  if (config.readOnly && config.initialize !== false) {
    throw new TypeError('A read-only SQLite agent-runtime store requires initialize: false');
  }
  const database = new DatabaseSync(config.filename, {
    readOnly: config.readOnly ?? false,
  });
  database.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
  const boundary: SqliteDatabase = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => {
          const result = statement.run(...parameters);
          return { changes: Number(result.changes) };
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
  SqliteAgentRuntimeStore,
  SqliteAgentRuntimeStoreConfig,
  SqliteDatabase,
  SqliteStatement,
  SqliteValue,
} from './agent-runtime/sqlite';
export {
  createSqliteAgentRuntimeStore,
  initializeAgentRuntimeSqlite,
} from './agent-runtime/sqlite';
