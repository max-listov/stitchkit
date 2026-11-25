/**
 * A migration ledger that refuses a changed history, on every SQLite driver.
 *
 * Offline-first apps keep one record of applied migrations in each local
 * database. A consuming app already ships it — `schema_migrations` with a 32-bit
 * FNV-1a over the statements — so the runner reads those databases as its own:
 * the checksum below is the one that app's code computed for the same text.
 * Every applied migration is checked before anything runs, a ledger ahead of
 * the code is not an error, and a migration that fails leaves no trace.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type AsyncSqliteConnection,
  defineSqliteMigrations,
  planSqliteMigrations,
  runSqliteMigrations,
  runSqliteMigrationsAsync,
  SqliteMigrationFailedError,
  SqliteMigrationLedgerMismatchError,
  SqliteMigrationLedgerUnreadableError,
} from '../src/application/sqlite-migrations';
import type { SqliteDatabase, SqliteStatement } from '../src/internal/sqlite';

const migrations = defineSqliteMigrations([
  {
    version: 1,
    name: 'first',
    statements: ['CREATE TABLE a (id INTEGER);', 'CREATE INDEX a_id ON a(id);'],
  },
  { version: 2, name: 'second', statements: ['CREATE TABLE b (id INTEGER);'] },
  { version: 3, name: 'third', statements: ['ALTER TABLE b ADD COLUMN x INTEGER;'] },
]);

test('the checksum is the one the consuming app computed for the same statements', () => {
  // Computed by that app's own `defineMigrations` for migration 1's statements.
  expect(migrations[0]?.checksum).toBe('0f830efd');
});

describe('the plan', () => {
  const ledger = (...versions: number[]) =>
    new Map(
      versions.map((version) => {
        const migration = migrations.find((entry) => entry.version === version);
        return [version, { name: migration?.name ?? '', checksum: migration?.checksum ?? '' }];
      }),
    );

  test('everything for an empty database, the rest for a partial one, in version order', () => {
    expect(
      planSqliteMigrations({
        scope: 'device',
        applied: new Map(),
        migrations: migrations.toReversed(),
      }).map((m) => m.version),
    ).toEqual([1, 2, 3]);
    expect(
      planSqliteMigrations({
        scope: 'device',
        applied: ledger(1, 2),
        migrations: migrations,
      }).map((m) => m.version),
    ).toEqual([3]);
  });

  test('a ledger ahead of the code is not an error', () => {
    const ahead = ledger(1, 2, 3);
    ahead.set(4, { name: 'from-a-newer-app', checksum: 'ffffffff' });
    expect(
      planSqliteMigrations({ scope: 'device', applied: ahead, migrations: migrations }),
    ).toEqual([]);
  });

  test('a changed name or text anywhere stops the whole plan, naming the scope and version', () => {
    const renamed = ledger(1, 2);
    renamed.set(2, { name: 'renamed', checksum: migrations[1]?.checksum ?? '' });
    expect(() =>
      planSqliteMigrations({ scope: 'account:a1', applied: renamed, migrations: migrations }),
    ).toThrow('account:a1 migration 2 changed after application');
    const edited = ledger(1);
    edited.set(2, { name: 'second', checksum: '00000000' });
    expect(() =>
      planSqliteMigrations({ scope: 'device', applied: edited, migrations: migrations }),
    ).toThrow(SqliteMigrationLedgerMismatchError);
  });

  test('a repeated version or name, and a migration without statements, refuse', () => {
    expect(() =>
      defineSqliteMigrations([
        { version: 1, name: 'a', statements: ['SELECT 1'] },
        { version: 1, name: 'b', statements: ['SELECT 1'] },
      ]),
    ).toThrow('Migration version 1 is repeated');
    expect(() =>
      defineSqliteMigrations([
        { version: 1, name: 'a', statements: ['SELECT 1'] },
        { version: 2, name: 'a', statements: ['SELECT 1'] },
      ]),
    ).toThrow('Migration name "a" is repeated');
    expect(() => defineSqliteMigrations([{ version: 1, name: 'a', statements: [] }])).toThrow(
      'Migration 1 has no statements',
    );
  });
});

const tables = (database: SqliteDatabase) =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => Reflect.get(row as object, 'name'));

const drivers: [string, () => SqliteDatabase][] = [
  ['bun:sqlite', () => new Database(':memory:')],
  ['node:sqlite', () => new DatabaseSync(':memory:') as unknown as SqliteDatabase],
];

describe.each(drivers)('running on %s', (_name, open) => {
  test('applies what is missing once, and a second run applies nothing', () => {
    const database = open();
    expect(runSqliteMigrations(database, { scope: 'device', migrations })).toEqual([1, 2, 3]);
    expect(runSqliteMigrations(database, { scope: 'device', migrations })).toEqual([]);
    expect(tables(database)).toEqual(['a', 'b', 'schema_migrations']);
  });

  test('reads a ledger the consuming app wrote as its own', () => {
    const database = open();
    database.exec('CREATE TABLE a (id INTEGER); CREATE INDEX a_id ON a(id);');
    runSqliteMigrations(database, { scope: 'device', migrations: [] });
    database
      .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
      .run(1, 'first', '0f830efd', '2026-11-01T00:00:00.000Z');
    expect(runSqliteMigrations(database, { scope: 'device', migrations })).toEqual([2, 3]);
  });

  test('a migration that fails leaves neither its tables nor its ledger row', () => {
    const database = open();
    const broken = defineSqliteMigrations([
      ...migrations.slice(0, 1),
      { version: 2, name: 'broken', statements: ['CREATE TABLE c (id INTEGER);', 'NOT SQL'] },
    ]);
    expect(() =>
      runSqliteMigrations(database, { scope: 'device', migrations: broken }),
    ).toThrow();
    expect(tables(database)).toEqual(['a', 'schema_migrations']);
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
    ]);
  });
});

test('a second connection that planned before the first one committed applies nothing twice', () => {
  // Two processes open one file at the same moment: a second window, a helper beside the
  // app. The later one reads an empty ledger, then waits for the write lock, and by the
  // time it holds the lock every version is already there.
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-sqlite-parallel-'));
  const file = join(directory, 'app.db');
  const first = new Database(file);
  const second = new Database(file);
  try {
    let planned = false;
    const late: SqliteDatabase = {
      exec: (sql) => {
        second.exec(sql);
      },
      close: () => second.close(),
      prepare: (sql) => {
        const statement: SqliteStatement = second.prepare(sql);
        if (planned || !sql.includes('FROM "schema_migrations"')) return statement;
        return {
          ...statement,
          run: (...parameters) => statement.run(...parameters),
          get: (...parameters) => statement.get(...parameters),
          all: (...parameters) => {
            const rows = statement.all(...parameters);
            // The plan is read; the other connection commits everything before our BEGIN.
            planned = true;
            expect(runSqliteMigrations(first, { scope: 'device', migrations })).toEqual([
              1, 2, 3,
            ]);
            return rows;
          },
        };
      },
    };

    expect(runSqliteMigrations(late, { scope: 'device', migrations })).toEqual([]);
    expect(planned).toBe(true);
    expect(
      second
        .prepare('SELECT "version" FROM "schema_migrations" ORDER BY "version"')
        .all()
        .map((row) => Reflect.get(row as object, 'version')),
    ).toEqual([1, 2, 3]);
    expect(tables(second)).toEqual(['a', 'b', 'schema_migrations']);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each migration begins the way the host asks and is dated by its clock', () => {
  const database = new Database(':memory:');
  const begun: string[] = [];
  const watched: SqliteDatabase = {
    exec: (sql) => {
      if (sql.startsWith('BEGIN')) begun.push(sql);
      database.exec(sql);
    },
    prepare: (sql) => database.prepare(sql),
    close: () => database.close(),
  };
  runSqliteMigrations(watched, {
    scope: 'device',
    migrations,
    begin: 'EXCLUSIVE',
    now: () => new Date('2026-11-22T00:00:00.000Z'),
  });
  expect(begun).toEqual(['BEGIN EXCLUSIVE', 'BEGIN EXCLUSIVE', 'BEGIN EXCLUSIVE']);
  expect(database.prepare('SELECT DISTINCT applied_at FROM schema_migrations').all()).toEqual([
    { applied_at: '2026-11-22T00:00:00.000Z' },
  ]);
});

test('the asynchronous runner applies the same plan through promises', async () => {
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
  expect(await runSqliteMigrationsAsync(connection, { scope: 'phone', migrations })).toEqual([
    1, 2, 3,
  ]);
  expect(await runSqliteMigrationsAsync(connection, { scope: 'phone', migrations })).toEqual(
    [],
  );
  const edited = defineSqliteMigrations([
    { version: 1, name: 'first', statements: ['CREATE TABLE a (id TEXT);'] },
  ]);
  await expect(
    runSqliteMigrationsAsync(connection, { scope: 'phone', migrations: edited }),
  ).rejects.toThrow('phone migration 1 changed after application');
});

test('a failed migration names its scope and version and keeps the driver’s error as cause', () => {
  const database = new Database(':memory:');
  const broken = defineSqliteMigrations([
    { version: 7, name: 'broken', statements: ['NOT SQL'] },
  ]);
  let caught: unknown;
  try {
    runSqliteMigrations(database, { scope: 'account:a1', migrations: broken });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SqliteMigrationFailedError);
  expect(caught).toMatchObject({ scope: 'account:a1', version: 7 });
  expect((caught as Error).cause).toBeInstanceOf(Error);
});

test('the asynchronous runner begins as asked, rolls a failure back and names it', async () => {
  const database = new DatabaseSync(':memory:');
  const statements: string[] = [];
  const connection: AsyncSqliteConnection = {
    exec: async (sql) => {
      statements.push(sql);
      database.exec(sql);
    },
    all: async (sql) => database.prepare(sql).all(),
    run: async (sql, ...parameters) => {
      database.prepare(sql).run(...parameters);
    },
  };
  const broken = defineSqliteMigrations([
    { version: 1, name: 'first', statements: ['CREATE TABLE a (id INTEGER);'] },
    { version: 2, name: 'broken', statements: ['CREATE TABLE c (id INTEGER);', 'NOT SQL'] },
  ]);
  await expect(
    runSqliteMigrationsAsync(connection, {
      scope: 'phone',
      migrations: broken,
      begin: 'EXCLUSIVE',
    }),
  ).rejects.toMatchObject({ name: 'SqliteMigrationFailedError', scope: 'phone', version: 2 });
  expect(statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))).toEqual([
    'BEGIN EXCLUSIVE',
    'COMMIT',
    'BEGIN EXCLUSIVE',
    'ROLLBACK',
  ]);
  expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
    { version: 1 },
  ]);
});

test('a ledger row that is not a migration refuses the database instead of being skipped', () => {
  const database = new Database(':memory:');
  // A ledger another tool wrote, without this one's column types.
  database.exec('CREATE TABLE schema_migrations (version, name, checksum, applied_at)');
  database
    .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
    .run('one', 'x', 'y', 'z');
  expect(() => runSqliteMigrations(database, { scope: 'device', migrations })).toThrow(
    SqliteMigrationLedgerUnreadableError,
  );
});

describe('ledger version validation', () => {
  const invalidSqlVersions: ReadonlyArray<[string, string]> = [
    ['NULL', 'NULL'],
    ['empty string', "''"],
    ['zero', '0'],
    ['negative integer', '-1'],
    ['numeric string', "'1'"],
    ['non-integer float', '1.5'],
    ['empty blob', "X''"],
    ['one-byte blob', "X'01'"],
  ];

  test.each(invalidSqlVersions)(
    'runSqliteMigrations rejects %s version rows as unreadable',
    (_label, sqlLiteral) => {
      for (const [, open] of drivers) {
        const database = open();
        try {
          database.exec(
            'CREATE TABLE schema_migrations (version, name, checksum, applied_at)',
          );
          database.exec(
            `INSERT INTO schema_migrations VALUES (${sqlLiteral}, 'first', '0f830efd', '2026-11-01T00:00:00.000Z')`,
          );
          expect(() => runSqliteMigrations(database, { scope: 'device', migrations })).toThrow(
            SqliteMigrationLedgerUnreadableError,
          );
        } finally {
          database.close();
        }
      }
    },
  );

  test('runSqliteMigrations rejects duplicate version rows in a table without PRIMARY KEY', () => {
    for (const [, open] of drivers) {
      const database = open();
      try {
        database.exec('CREATE TABLE schema_migrations (version, name, checksum, applied_at)');
        database
          .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
          .run(1, 'tampered', 'deadbeef', '2026-11-01T00:00:00.000Z');
        database
          .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
          .run(1, 'first', '0f830efd', '2026-11-01T00:00:00.000Z');
        expect(() => runSqliteMigrations(database, { scope: 'device', migrations })).toThrow(
          SqliteMigrationLedgerUnreadableError,
        );
      } finally {
        database.close();
      }
    }
  });

  test('runSqliteMigrationsAsync rejects invalid, bigint out-of-range, blob and duplicate versions while accepting valid 1 and 1n', async () => {
    const first = migrations[0];
    if (!first) throw new Error('expected first migration');

    const asyncConnFor = (rows: readonly unknown[]): AsyncSqliteConnection => ({
      exec: async () => undefined,
      all: async () => rows,
      run: async () => undefined,
    });

    const badRows: ReadonlyArray<[string, readonly unknown[]]> = [
      ['NULL', [{ version: null, name: first.name, checksum: first.checksum }]],
      ['empty string', [{ version: '', name: first.name, checksum: first.checksum }]],
      ['zero', [{ version: 0, name: first.name, checksum: first.checksum }]],
      ['negative', [{ version: -1, name: first.name, checksum: first.checksum }]],
      ['string "1"', [{ version: '1', name: first.name, checksum: first.checksum }]],
      [
        'empty blob',
        [{ version: new Uint8Array(0), name: first.name, checksum: first.checksum }],
      ],
      [
        'blob [1]',
        [{ version: new Uint8Array([1]), name: first.name, checksum: first.checksum }],
      ],
      ['bigint 0n', [{ version: 0n, name: first.name, checksum: first.checksum }]],
      ['bigint -1n', [{ version: -1n, name: first.name, checksum: first.checksum }]],
      [
        'bigint > MAX_SAFE_INTEGER',
        [
          {
            version: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            name: first.name,
            checksum: first.checksum,
          },
        ],
      ],
      [
        'duplicate version',
        [
          { version: 1, name: 'tampered', checksum: 'deadbeef' },
          { version: 1, name: first.name, checksum: first.checksum },
        ],
      ],
    ];

    for (const [, rows] of badRows) {
      await expect(
        runSqliteMigrationsAsync(asyncConnFor(rows), { scope: 'phone', migrations }),
      ).rejects.toBeInstanceOf(SqliteMigrationLedgerUnreadableError);
    }

    // Positive controls: valid number `1` and valid bigint `1n` are both accepted.
    for (const validVersion of [1, 1n] as const) {
      const database = new Database(':memory:');
      try {
        database.exec('CREATE TABLE a (id INTEGER); CREATE INDEX a_id ON a(id);');
        const rows: Array<{ version: number | bigint; name: string; checksum: string }> = [
          { version: validVersion, name: first.name, checksum: first.checksum },
        ];
        const connection: AsyncSqliteConnection = {
          exec: async (sql) => {
            database.exec(sql);
          },
          all: async () => [...rows],
          run: async (sql, ...parameters) => {
            database.prepare(sql).run(...parameters);
            rows.push({
              version: Number(parameters[0]),
              name: String(parameters[1]),
              checksum: String(parameters[2]),
            });
          },
        };
        expect(
          await runSqliteMigrationsAsync(connection, { scope: 'phone', migrations }),
        ).toEqual([2, 3]);
      } finally {
        database.close();
      }
    }
  });

  test('runSqliteMigrations accepts valid bigint 1n and rejects 0n, -1n and > MAX_SAFE_INTEGER', () => {
    const first = migrations[0];
    if (!first) throw new Error('expected first migration');

    const syncDbWithRows = (rows: readonly unknown[]): SqliteDatabase => ({
      exec: () => undefined,
      close: () => undefined,
      prepare: () => ({
        run: () => ({ changes: 0 }),
        get: () => rows[0] ?? null,
        all: () => [...rows],
      }),
    });

    for (const invalidBigInt of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      const db = syncDbWithRows([
        { version: invalidBigInt, name: first.name, checksum: first.checksum },
      ]);
      expect(() => runSqliteMigrations(db, { scope: 'device', migrations })).toThrow(
        SqliteMigrationLedgerUnreadableError,
      );
    }

    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE a (id INTEGER); CREATE INDEX a_id ON a(id);');
      runSqliteMigrations(database, { scope: 'device', migrations: [] });
      database
        .prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?)')
        .run(1, first.name, first.checksum, '2026-11-01T00:00:00.000Z');
      const bigintReadDb: SqliteDatabase = {
        exec: (sql) => database.exec(sql),
        close: () => database.close(),
        prepare: (sql) => {
          const statement = database.prepare(sql);
          if (!sql.includes('FROM "schema_migrations"')) return statement;
          return {
            run: (...parameters) => statement.run(...parameters),
            get: (...parameters) => statement.get(...parameters),
            all: (...parameters) =>
              statement.all(...parameters).map((row) => {
                if (typeof row !== 'object' || row === null) return row;
                return {
                  ...row,
                  version: BigInt(Number(Reflect.get(row, 'version'))),
                };
              }),
          };
        },
      };
      expect(runSqliteMigrations(bigintReadDb, { scope: 'device', migrations })).toEqual([
        2, 3,
      ]);
    } finally {
      database.close();
    }
  });
});

describe('a rollback that fails is part of the failure', () => {
  const broken = defineSqliteMigrations([
    { version: 4, name: 'broken', statements: ['CREATE TABLE c (id INTEGER);', 'NOT SQL'] },
  ]);
  const rollbackRefused = new Error('disk I/O error');

  function causes(error: unknown): unknown[] {
    expect(error).toBeInstanceOf(SqliteMigrationFailedError);
    if (!(error instanceof SqliteMigrationFailedError)) return [];
    expect(error).toMatchObject({ scope: 'phone', version: 4 });
    expect(error.cause).toBeInstanceOf(AggregateError);
    if (!(error.cause instanceof AggregateError)) return [];
    expect(error.cause.cause).toBe(error.cause.errors[0]);
    return error.cause.errors;
  }

  test('on the synchronous runner, both the migration error and the rollback error are thrown', () => {
    const database = new Database(':memory:');
    const refusing: SqliteDatabase = {
      exec: (sql) => {
        if (sql === 'ROLLBACK') throw rollbackRefused;
        database.exec(sql);
      },
      prepare: (sql) => database.prepare(sql),
      close: () => database.close(),
    };
    const failure = (() => {
      try {
        runSqliteMigrations(refusing, { scope: 'phone', migrations: broken });
      } catch (error) {
        return error;
      }
    })();
    const [migrationError, rollbackError] = causes(failure);
    expect(migrationError).toBeInstanceOf(Error);
    expect(rollbackError).toBe(rollbackRefused);
  });

  test('on the asynchronous runner, both are thrown too, and "no transaction" alone is not a failure', async () => {
    const database = new DatabaseSync(':memory:');
    let rollback: 'refuse' | 'none-active' = 'refuse';
    const connection: AsyncSqliteConnection = {
      exec: async (sql) => {
        if (sql === 'ROLLBACK' && rollback === 'refuse') throw rollbackRefused;
        if (sql === 'ROLLBACK') throw new Error('cannot rollback - no transaction is active');
        database.exec(sql);
      },
      all: async (sql) => database.prepare(sql).all(),
      run: async (sql, ...parameters) => {
        database.prepare(sql).run(...parameters);
      },
    };
    const failure = await runSqliteMigrationsAsync(connection, {
      scope: 'phone',
      migrations: broken,
    }).catch((error: unknown) => error);
    expect(causes(failure)[1]).toBe(rollbackRefused);
    database.exec('ROLLBACK');

    rollback = 'none-active';
    const alone = await runSqliteMigrationsAsync(connection, {
      scope: 'phone',
      migrations: broken,
    }).catch((error: unknown) => error);
    expect(alone).toBeInstanceOf(SqliteMigrationFailedError);
    expect(alone instanceof Error && alone.cause).not.toBeInstanceOf(AggregateError);
  });
});
