/**
 * A SQLite backend for a keyspace: one table, a key and a JSON payload.
 *
 * Typed against the minimal `exec`/`prepare`/`close` boundary the framework
 * already uses, which `bun:sqlite`'s `Database` and a thin `node:sqlite` wrapper
 * both satisfy structurally — so the caller passes the handle it already has and
 * adopts no driver of ours.
 */
import type { SqliteDatabase } from '../internal/sqlite';
import type { KeyspaceBackend, KeyspaceDeclaration } from './keyspace';

export interface SqliteKeyspaceBackendConfig {
  readonly database: SqliteDatabase;
  /**
   * The table to use. Defaults to `stitchkit_keyspace_<name>`.
   *
   * Must be a bare identifier — letters, digits and underscore. A table name
   * reaches SQLite as text inside DDL that no placeholder can carry, so this is
   * the one string here that cannot be parameterised, and an unchecked one would
   * make a keyspace name an injection point.
   */
  readonly table?: string;
  /**
   * Create the table when it is missing. Default true.
   *
   * Turn it off where migrations are owned elsewhere — then a missing table is
   * that owner's failure to hear about, not something this backend papers over.
   */
  readonly initialize?: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sqliteKeyspaceBackend<TValue>(
  declaration: KeyspaceDeclaration<TValue>,
  config: SqliteKeyspaceBackendConfig,
): KeyspaceBackend {
  const table = config.table ?? `stitchkit_keyspace_${declaration.name}`;
  if (!IDENTIFIER.test(table)) {
    throw new Error(
      `[stitchkit] sqliteKeyspaceBackend: "${table}" is not a bare SQL identifier. A table name cannot be a bound parameter, so it is checked here rather than interpolated on trust. Pass \`table\` explicitly when the keyspace name is not identifier-shaped.`,
    );
  }
  const database = config.database;
  if (config.initialize !== false) {
    database.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    );
  }

  return {
    async load() {
      const rows = database.prepare(`SELECT payload FROM ${table}`).all();
      return rows.map((row) => {
        const payload = Reflect.get(Object(row), 'payload');
        if (typeof payload !== 'string') {
          throw new Error(
            `[stitchkit] keyspace "${declaration.name}": a row in ${table} has no text payload.`,
          );
        }
        return JSON.parse(payload);
      });
    },
    async put(key, value) {
      database
        .prepare(
          `INSERT INTO ${table} (key, payload) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET payload = excluded.payload`,
        )
        .run(key, JSON.stringify(value));
    },
    async delete(key) {
      database.prepare(`DELETE FROM ${table} WHERE key = ?`).run(key);
    },
    // The database handle is **not** closed here. It was opened by the caller,
    // it may back several keyspaces and the agent-runtime store besides, and a
    // backend that closes a connection it did not open takes the rest of the
    // process down with it.
  };
}
