/**
 * Several independent migration lists in one SQLite file, and a synchronous `expo-sqlite`
 * handle under the runner.
 *
 * A phone keeps more than one group of tables in one file — a queue of unsent changes and a
 * copy of what the server holds — and each group owns its migrations: a group added later
 * starts at version 1 without renumbering the other. Each list is recorded in a ledger of its
 * own, so version 1 of one list is not version 1 of the other.
 *
 * The `expo-sqlite` handle below is shaped after the published declarations of
 * `expo-sqlite@58.0.18` (`build/SQLiteDatabase.d.ts`, `build/NativeStatement.d.ts`, read
 * 2026-11-24): `execSync(source)`, `getFirstSync(source, params)`, `getAllSync(source, params)`
 * and `runSync(source, params)` with `SQLiteBindValue = string | number | null | boolean |
 * Uint8Array | ArrayBuffer` — no `bigint` — and a `runSync` result of
 * `{ lastInsertRowId, changes }`. The three convenience calls prepare, execute and finalize a
 * statement each, so the wrapper leaves no native statement open.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { DatabaseSync } from 'node:sqlite';
import {
  type AsyncSqliteConnection,
  defineSqliteMigrations,
  runSqliteMigrations,
  runSqliteMigrationsAsync,
  SqliteMigrationLedgerMismatchError,
} from '../src/application/sqlite-migrations';
import type { SqliteDatabase, SqliteValue } from '../src/internal/sqlite';

const queue = defineSqliteMigrations([
  { version: 1, name: 'queue', statements: ['CREATE TABLE queue (id INTEGER PRIMARY KEY);'] },
  { version: 2, name: 'queue-key', statements: ['ALTER TABLE queue ADD COLUMN key TEXT;'] },
]);
const replica = defineSqliteMigrations([
  { version: 1, name: 'replica', statements: ['CREATE TABLE replica (id TEXT PRIMARY KEY);'] },
]);

const names = (database: SqliteDatabase, sql: string) =>
  database
    .prepare(sql)
    .all()
    .map((row) => Reflect.get(row as object, 'name'));

const tables = (database: SqliteDatabase) =>
  names(database, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

test('two lists in one database keep separate ledgers, and each starts at version 1', () => {
  const database = new Database(':memory:');
  expect(
    runSqliteMigrations(database, {
      scope: 'device',
      ledger: 'queue_migrations',
      migrations: queue,
    }),
  ).toEqual([1, 2]);
  expect(
    runSqliteMigrations(database, {
      scope: 'device',
      ledger: 'replica_migrations',
      migrations: replica,
    }),
  ).toEqual([1]);
  // A second start applies nothing in either list.
  expect(
    runSqliteMigrations(database, {
      scope: 'device',
      ledger: 'queue_migrations',
      migrations: queue,
    }),
  ).toEqual([]);
  expect(
    runSqliteMigrations(database, {
      scope: 'device',
      ledger: 'replica_migrations',
      migrations: replica,
    }),
  ).toEqual([]);
  expect(tables(database)).toEqual([
    'queue',
    'queue_migrations',
    'replica',
    'replica_migrations',
  ]);
  expect(names(database, 'SELECT name FROM replica_migrations')).toEqual(['replica']);
  expect(names(database, 'SELECT name FROM queue_migrations ORDER BY version')).toEqual([
    'queue',
    'queue-key',
  ]);
});

test('control: two lists in one ledger collide on version 1 and change nothing', () => {
  const database = new Database(':memory:');
  runSqliteMigrations(database, { scope: 'device', migrations: queue });
  expect(() =>
    runSqliteMigrations(database, { scope: 'device', migrations: replica }),
  ).toThrow(SqliteMigrationLedgerMismatchError);
  expect(tables(database)).toEqual(['queue', 'schema_migrations']);
});

test('a list without a ledger name keeps the schema_migrations table', () => {
  const database = new Database(':memory:');
  runSqliteMigrations(database, { scope: 'device', migrations: replica });
  expect(tables(database)).toEqual(['replica', 'schema_migrations']);
});

test('a ledger name that is not a plain SQL identifier is refused before anything runs', () => {
  const database = new Database(':memory:');
  for (const ledger of [
    '',
    'queue migrations',
    'queue"; DROP TABLE x; --',
    '1queue',
    'sqlite_x',
  ]) {
    expect(() =>
      runSqliteMigrations(database, { scope: 'device', ledger, migrations: queue }),
    ).toThrow(TypeError);
  }
  expect(tables(database)).toEqual([]);
});

test('a begin mode SQLite does not name is refused before anything runs, on both runners', async () => {
  for (const begin of ['IMMEDIATE; DROP TABLE x; --', 'immediate', '']) {
    const database = new Database(':memory:');
    // A JavaScript caller reaches past the type; the value must not reach the SQL.
    const untyped: Parameters<typeof runSqliteMigrations>[1] = {
      ...JSON.parse(JSON.stringify({ scope: 'device', begin })),
      migrations: queue,
    };
    expect(() => runSqliteMigrations(database, untyped)).toThrow(
      `[stitchkit] sqlite migrations: begin is 'DEFERRED', 'IMMEDIATE' or 'EXCLUSIVE', received ${JSON.stringify(begin)}`,
    );
    const statements: string[] = [];
    const connection: AsyncSqliteConnection = {
      exec: async (sql) => void statements.push(sql),
      all: async () => [],
      run: async () => undefined,
    };
    await expect(runSqliteMigrationsAsync(connection, untyped)).rejects.toThrow(TypeError);
    expect(statements).toEqual([]);
    expect(tables(database)).toEqual([]);
  }
});

test('the asynchronous runner keeps each list in its own ledger too', async () => {
  const database = new DatabaseSync(':memory:');
  const connection: AsyncSqliteConnection = {
    exec: async (sql) => {
      database.exec(sql);
    },
    all: async (sql) => database.prepare(sql).all(),
    run: async (sql, ...parameters) => {
      database.prepare(sql).run(...parameters);
    },
  };
  expect(
    await runSqliteMigrationsAsync(connection, {
      scope: 'phone',
      ledger: 'queue_migrations',
      migrations: queue,
    }),
  ).toEqual([1, 2]);
  expect(
    await runSqliteMigrationsAsync(connection, {
      scope: 'phone',
      ledger: 'replica_migrations',
      migrations: replica,
    }),
  ).toEqual([1]);
  await expect(
    runSqliteMigrationsAsync(connection, { scope: 'phone', ledger: 'a b', migrations: queue }),
  ).rejects.toThrow(TypeError);
});

type ExpoBindValue = string | number | null | boolean | Uint8Array | ArrayBuffer;

/** A synchronous `expo-sqlite` database over `bun:sqlite`, with the published signatures. */
function expoShaped(database: Database, executed: string[]) {
  const bound = (params: readonly ExpoBindValue[]) =>
    params.map((value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });
  return {
    execSync: (source: string): void => {
      executed.push(source);
      database.exec(source);
    },
    getFirstSync: <T>(source: string, params: readonly ExpoBindValue[]): T | null =>
      (database.prepare(source).get(...bound(params)) as T | undefined) ?? null,
    getAllSync: <T>(source: string, params: readonly ExpoBindValue[]): T[] =>
      database.prepare(source).all(...bound(params)) as T[],
    runSync: (source: string, params: readonly ExpoBindValue[]) => {
      const result = database.prepare(source).run(...bound(params));
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: result.changes };
    },
    closeSync: (): void => database.close(),
  };
}

/** The wrapper in docs/guide/sync.md, "SQLite migrations", as written there. */
function wrapExpo(expo: ReturnType<typeof expoShaped>): SqliteDatabase {
  const bind = (values: SqliteValue[]) =>
    values.map((value) => {
      if (typeof value === 'bigint') throw new TypeError('expo-sqlite binds no bigint');
      return value;
    });
  return {
    exec: (sql) => expo.execSync(sql),
    prepare: (sql) => ({
      get: (...values) => expo.getFirstSync(sql, bind(values)),
      all: (...values) => expo.getAllSync(sql, bind(values)),
      run: (...values) => ({ changes: expo.runSync(sql, bind(values)).changes }),
    }),
    close: () => expo.closeSync(),
  };
}

test('a synchronous expo-sqlite handle runs two lists, each migration inside BEGIN IMMEDIATE', () => {
  const executed: string[] = [];
  const database = wrapExpo(expoShaped(new Database(':memory:'), executed));
  expect(
    runSqliteMigrations(database, {
      scope: 'phone',
      ledger: 'queue_migrations',
      migrations: queue,
    }),
  ).toEqual([1, 2]);
  expect(
    runSqliteMigrations(database, {
      scope: 'phone',
      ledger: 'replica_migrations',
      migrations: replica,
    }),
  ).toEqual([1]);
  expect(
    runSqliteMigrations(database, {
      scope: 'phone',
      ledger: 'queue_migrations',
      migrations: queue,
    }),
  ).toEqual([]);
  // Each statement of a migration runs between its own BEGIN IMMEDIATE and COMMIT.
  const transactional = executed.filter(
    (sql) => !sql.startsWith('CREATE TABLE IF NOT EXISTS'),
  );
  expect(transactional).toEqual([
    'BEGIN IMMEDIATE',
    'CREATE TABLE queue (id INTEGER PRIMARY KEY);',
    'COMMIT',
    'BEGIN IMMEDIATE',
    'ALTER TABLE queue ADD COLUMN key TEXT;',
    'COMMIT',
    'BEGIN IMMEDIATE',
    'CREATE TABLE replica (id TEXT PRIMARY KEY);',
    'COMMIT',
  ]);
  expect(tables(database)).toEqual([
    'queue',
    'queue_migrations',
    'replica',
    'replica_migrations',
  ]);
});

test('the expo wrapper refuses a bigint instead of narrowing it to a number', () => {
  const database = wrapExpo(expoShaped(new Database(':memory:'), []));
  expect(() => database.prepare('SELECT ?').get(2n ** 60n)).toThrow(
    'expo-sqlite binds no bigint',
  );
});
