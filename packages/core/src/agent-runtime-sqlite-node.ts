import { DatabaseSync } from 'node:sqlite';
import {
  type AgentRuntimeSqliteDatabase,
  type AgentRuntimeSqliteValue,
  createSqliteAgentRuntimeStore,
  type SqliteAgentRuntimeStore,
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
  const boundary: AgentRuntimeSqliteDatabase = {
    exec: (sql) => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        get: (...parameters: AgentRuntimeSqliteValue[]) => statement.get(...parameters),
        all: (...parameters: AgentRuntimeSqliteValue[]) => statement.all(...parameters),
        run: (...parameters: AgentRuntimeSqliteValue[]) => {
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
