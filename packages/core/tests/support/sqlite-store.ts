import { Database } from 'bun:sqlite';
import {
  createSqliteAgentRuntimeStore,
  type SqliteAgentRuntimeStore,
  type SqliteDatabase,
  type SqliteValue,
} from '../../src/agent-runtime/sqlite';

/**
 * A SQLite agent store and the raw connection under it.
 *
 * The store hands its companions a host, not its connection. A test that
 * proves something about the bytes on disk — a migration, an index plan, a
 * row a reader must not see — opens the connection itself and keeps it.
 */
export function openSqliteStore(
  filename: string,
  options: { initialize?: boolean; wrap?: (database: SqliteDatabase) => SqliteDatabase } = {},
): { database: SqliteDatabase; sqlite: SqliteAgentRuntimeStore } {
  const raw = new Database(filename, { create: true, readwrite: true });
  raw.exec('PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON;');
  const database: SqliteDatabase = {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const statement = raw.query(sql);
      return {
        get: (...parameters: SqliteValue[]) => statement.get(...parameters),
        all: (...parameters: SqliteValue[]) => statement.all(...parameters),
        run: (...parameters: SqliteValue[]) => ({
          changes: statement.run(...parameters).changes,
        }),
      };
    },
    close: () => raw.close(),
  };
  const sqlite = createSqliteAgentRuntimeStore({
    database: options.wrap ? options.wrap(database) : database,
    ...(options.initialize !== undefined && { initialize: options.initialize }),
  });
  return { database, sqlite };
}
