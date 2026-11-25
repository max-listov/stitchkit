/**
 * Unit regression tests for Postgres agent store schema initialization,
 * transaction error classification, and SQLite rollback error preservation.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  initializePostgresAgentStore,
  POSTGRES_AGENT_STORE_SCHEMA_VERSION,
  postgresAgentRuntimeStoreDdl,
} from '../src/agent-runtime/postgres-schema';
import {
  isRetryablePostgresConflict,
  POSTGRES_ISOLATION,
  type PostgresTransactionRunner,
  postgresErrorState,
  runPostgresTransaction,
  setPostgresTransactionIsolation,
} from '../src/agent-runtime/postgres-transactions';
import type { AgentSqlSession } from '../src/agent-runtime/sql-session';
import { initializeAgentRuntimeSqlite } from '../src/agent-runtime/sqlite-schema';
import {
  createSqliteStoreState,
  runSqliteTransaction,
} from '../src/agent-runtime/sqlite-transactions';
import type { SqliteDatabase } from '../src/internal/sqlite';

describe('Postgres agent store error classification', () => {
  test('recognizes P2034, TransactionWriteConflict, and P2010 nested in meta and driverAdapterError', () => {
    // P2034 directly, in meta, and inside meta.driverAdapterError
    expect(isRetryablePostgresConflict({ code: 'P2034' })).toBe(true);
    expect(postgresErrorState({ code: 'P2034' })).toBeUndefined();
    expect(isRetryablePostgresConflict({ meta: { code: 'P2034' } })).toBe(true);
    expect(
      isRetryablePostgresConflict({
        code: 'P2010',
        meta: { driverAdapterError: { code: 'P2034' } },
      }),
    ).toBe(true);
    expect(
      isRetryablePostgresConflict({
        meta: { driverAdapterError: { cause: { code: 'P2034' } } },
      }),
    ).toBe(true);

    // TransactionWriteConflict directly, in meta, and inside meta.driverAdapterError
    expect(isRetryablePostgresConflict({ kind: 'TransactionWriteConflict' })).toBe(true);
    expect(isRetryablePostgresConflict({ meta: { kind: 'TransactionWriteConflict' } })).toBe(
      true,
    );
    expect(
      isRetryablePostgresConflict({
        meta: { driverAdapterError: { kind: 'TransactionWriteConflict' } },
      }),
    ).toBe(true);
    expect(
      isRetryablePostgresConflict({
        meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } },
      }),
    ).toBe(true);

    // P2010 with backticked SQLSTATE (40001 / 40P01) directly and inside meta.driverAdapterError
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed. Code: `40001`. Message: could not serialize access',
      }),
    ).toBe('40001');
    expect(
      isRetryablePostgresConflict({
        meta: {
          driverAdapterError: {
            code: 'P2010',
            message: 'Raw query failed. Code: `40P01`. Message: deadlock detected',
          },
        },
      }),
    ).toBe(true);
    expect(
      postgresErrorState({
        meta: {
          driverAdapterError: {
            code: 'P2010',
            message: 'Raw query failed. Code: `40P01`. Message: deadlock detected',
          },
        },
      }),
    ).toBe('40P01');

    // P2010 without backticks carrying 40001 / 40P01 directly, in meta, and in driverAdapterError
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed: 40001 could not serialize access',
      }),
    ).toBe('40001');
    expect(
      isRetryablePostgresConflict({
        code: 'P2010',
        message: 'Raw query failed: 40001 could not serialize access',
      }),
    ).toBe(true);
    expect(
      isRetryablePostgresConflict({
        meta: {
          code: 'P2010',
          message: 'Raw query failed: 40P01 deadlock detected',
        },
      }),
    ).toBe(true);
    expect(
      isRetryablePostgresConflict({
        meta: {
          driverAdapterError: {
            code: 'P2010',
            message: 'Raw query failed: 40001 serialization failure',
          },
        },
      }),
    ).toBe(true);
    expect(
      postgresErrorState({
        meta: {
          driverAdapterError: {
            code: 'P2010',
            message: 'Raw query failed: 40001 serialization failure',
          },
        },
      }),
    ).toBe('40001');

    // Structured SQLSTATE inside driverAdapterError wins over P2010 text
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed. Code: `54000`.',
        meta: { driverAdapterError: { cause: { originalCode: '25001' } } },
      }),
    ).toBe('25001');
  });

  test('terminates cleanly on cyclic cause and meta graphs without stack overflow', () => {
    const selfCycle: Record<string, unknown> = { code: 'P2002' };
    selfCycle.cause = selfCycle;
    expect(postgresErrorState(selfCycle)).toBeUndefined();
    expect(isRetryablePostgresConflict(selfCycle)).toBe(false);

    const a: Record<string, unknown> = { message: 'outer' };
    const b: Record<string, unknown> = { message: 'inner', cause: a };
    a.cause = b;
    a.meta = { driverAdapterError: a };
    expect(postgresErrorState(a)).toBeUndefined();
    expect(isRetryablePostgresConflict(a)).toBe(false);

    const cyclicWithConflict: Record<string, unknown> = { message: 'outer' };
    cyclicWithConflict.cause = cyclicWithConflict;
    cyclicWithConflict.meta = {
      driverAdapterError: { kind: 'TransactionWriteConflict', cause: cyclicWithConflict },
    };
    expect(isRetryablePostgresConflict(cyclicWithConflict)).toBe(true);
  });

  test('rejects non-retryable Postgres and Prisma errors (negative controls)', () => {
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed. Code: `23505`. Message: duplicate key',
      }),
    ).toBe('23505');
    expect(
      isRetryablePostgresConflict({
        code: 'P2010',
        message: 'Raw query failed. Code: `23505`. Message: duplicate key',
      }),
    ).toBe(false);
    expect(
      isRetryablePostgresConflict({
        code: 'P2010',
        message: 'Raw query failed: 23505 duplicate key',
      }),
    ).toBe(false);
    expect(
      postgresErrorState({
        code: 'P2010',
        message: 'Raw query failed: 23505 duplicate key',
      }),
    ).toBeUndefined();
    expect(
      postgresErrorState({
        meta: { driverAdapterError: { code: 'P2002', meta: { target: ['id'] } } },
      }),
    ).toBeUndefined();
    expect(
      isRetryablePostgresConflict({
        meta: { driverAdapterError: { code: 'P2002', meta: { target: ['id'] } } },
      }),
    ).toBe(false);
    expect(postgresErrorState(null)).toBeUndefined();
    expect(postgresErrorState(undefined)).toBeUndefined();
    expect(postgresErrorState('40001')).toBeUndefined();
    expect(isRetryablePostgresConflict(null)).toBe(false);
    expect(isRetryablePostgresConflict('40001')).toBe(false);
  });
});

describe('Postgres agent store DDL and initialization order', () => {
  test('postgresAgentRuntimeStoreDdl includes an idempotent schema_version INSERT as its own statement', () => {
    const ddl = postgresAgentRuntimeStoreDdl('custom_prefix');
    const statements = ddl
      .split(';\n')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.at(-1)).toBe(
      `INSERT INTO custom_prefix_meta (key, value) VALUES ('schema_version', '${POSTGRES_AGENT_STORE_SCHEMA_VERSION}') ON CONFLICT (key) DO NOTHING`,
    );
  });

  test('initializePostgresAgentStore validates prefix before running any SQL for both createTables values', async () => {
    const executed: string[] = [];
    const session: AgentSqlSession = {
      all: async (sql) => {
        executed.push(sql);
        return [];
      },
      get: async (sql) => {
        executed.push(sql);
        return undefined;
      },
      run: async (sql) => {
        executed.push(sql);
      },
    };
    await expect(initializePostgresAgentStore(session, 'UpperCase', false)).rejects.toThrow(
      '[a-z_][a-z0-9_]*',
    );
    await expect(initializePostgresAgentStore(session, 'p'.repeat(45), true)).rejects.toThrow(
      'Postgres keeps 63',
    );
    expect(executed).toEqual([]);
  });

  test('initializePostgresAgentStore sets READ COMMITTED before acquiring the advisory lock and refuses 25001', async () => {
    const statements: string[] = [];
    const session: AgentSqlSession = {
      all: async (sql) => {
        statements.push(sql);
        return [];
      },
      get: async (sql) => {
        statements.push(sql);
        return undefined;
      },
      run: async (sql) => {
        statements.push(sql);
      },
    };
    await initializePostgresAgentStore(session, 'test_init', true);
    expect(statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(statements[1]).toContain('pg_advisory_xact_lock');
    // DDL already inserts schema_version; no second manual INSERT is issued.
    const metaInserts = statements.filter((sql) => sql.includes('INSERT INTO test_init_meta'));
    expect(metaInserts).toHaveLength(1);
    expect(metaInserts[0]).toContain('ON CONFLICT (key) DO NOTHING');

    const dirtyCause = {
      meta: { driverAdapterError: { cause: { originalCode: '25001' } } },
    };
    const dirtySession: AgentSqlSession = {
      all: async () => [],
      get: async () => undefined,
      run: async (sql) => {
        if (sql.startsWith('SET TRANSACTION')) throw dirtyCause;
      },
    };
    let caught: unknown;
    try {
      await initializePostgresAgentStore(dirtySession, 'test_dirty', true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof Error ? caught.message : '').toContain(
      'opens its own transactions',
    );
    expect(caught instanceof Error ? caught.cause : undefined).toBe(dirtyCause);

    await expect(
      setPostgresTransactionIsolation(dirtySession, POSTGRES_ISOLATION.read),
    ).rejects.toThrow('opens its own transactions');

    const fatalError = Object.assign(new Error('connection terminated'), { code: '57P01' });
    const brokenSession: AgentSqlSession = {
      all: async () => [],
      get: async () => undefined,
      run: async (sql) => {
        if (sql.startsWith('SET TRANSACTION')) throw fatalError;
      },
    };
    await expect(
      initializePostgresAgentStore(brokenSession, 'test_broken', true),
    ).rejects.toBe(fatalError);
  });

  test('runPostgresTransaction translates 25001 without retrying and retries nested driverAdapterError conflicts', async () => {
    let attempts = 0;
    const dirtyRunner: PostgresTransactionRunner<object> = {
      transaction: (work) => {
        attempts += 1;
        return work({});
      },
      query: async () => {
        throw { code: '25001' };
      },
      maxAttempts: 3,
      isRetryable: isRetryablePostgresConflict,
      isolation: POSTGRES_ISOLATION,
    };
    await expect(
      runPostgresTransaction(dirtyRunner, 'write', async () => 'unreachable'),
    ).rejects.toThrow('opens its own transactions');
    expect(attempts).toBe(1);

    let conflictAttempts = 0;
    const retryRunner: PostgresTransactionRunner<object> = {
      transaction: (work) => {
        conflictAttempts += 1;
        return work({});
      },
      query: async (_tx, sql) => {
        if (sql.startsWith('SET TRANSACTION')) return [];
        if (conflictAttempts === 1) {
          throw {
            meta: { driverAdapterError: { kind: 'TransactionWriteConflict' } },
          };
        }
        return [];
      },
      maxAttempts: 3,
      isRetryable: isRetryablePostgresConflict,
      isolation: POSTGRES_ISOLATION,
    };
    const value = await runPostgresTransaction(retryRunner, 'write', async (session) => {
      await session.run('SELECT 1');
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(conflictAttempts).toBe(2);
  });
});

describe('SQLite rollback error preservation', () => {
  test('runSqliteTransaction preserves the original failure when SQLite already rolled back the transaction', async () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      database.exec('INSERT INTO items (id) VALUES (1)');
      const state = createSqliteStoreState(database);

      // INSERT OR ROLLBACK makes SQLite abort and roll back the active transaction
      // itself, so a subsequent ROLLBACK fails with "cannot rollback - no transaction is active".
      await expect(
        runSqliteTransaction(state, 'write', async (session) => {
          await session.run('INSERT INTO items (id) VALUES (2)');
          await session.run('INSERT OR ROLLBACK INTO items (id) VALUES (1)');
        }),
      ).rejects.toThrow(/UNIQUE constraint failed/);

      // Row 2 was rolled back by SQLite's ON CONFLICT ROLLBACK.
      expect(database.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 1 }]);

      // Negative control: an ordinary error inside the transaction genuinely rolls back writes.
      await expect(
        runSqliteTransaction(state, 'write', async (session) => {
          await session.run('INSERT INTO items (id) VALUES (3)');
          throw new Error('ordinary application failure');
        }),
      ).rejects.toThrow('ordinary application failure');
      expect(database.prepare('SELECT id FROM items ORDER BY id').all()).toEqual([{ id: 1 }]);
    } finally {
      database.close();
    }
  });

  /**
   * A rollback that fails for any reason other than "no transaction is active"
   * may leave the connection inside the transaction, and the next `BEGIN` is
   * refused for a reason nobody saw. Both failures are reported, the original
   * one first and as the cause.
   */
  test('a rollback that fails for another reason is reported beside the original failure', async () => {
    const raw = new Database(':memory:');
    const rollbackFailure = new Error('disk I/O error');
    const database: SqliteDatabase = {
      exec: (sql) => {
        if (sql === 'ROLLBACK') throw rollbackFailure;
        raw.exec(sql);
      },
      prepare: (sql) => raw.prepare(sql),
      close: () => raw.close(),
    };
    try {
      const original = new Error('ordinary application failure');
      const failure = await runSqliteTransaction(
        createSqliteStoreState(database),
        'write',
        async () => {
          throw original;
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure instanceof AggregateError && failure.errors).toEqual([
        original,
        rollbackFailure,
      ]);
      expect(failure instanceof Error && failure.cause).toBe(original);
      raw.exec('ROLLBACK');

      const partial: SqliteDatabase = {
        ...database,
        prepare: (sql) => raw.prepare(sql),
      };
      raw.exec('CREATE TABLE stitchkit_agent_runtime_heads (conversation_id TEXT)');
      let schemaFailure: unknown;
      try {
        initializeAgentRuntimeSqlite(partial);
      } catch (error) {
        schemaFailure = error;
      }
      expect(schemaFailure).toBeInstanceOf(AggregateError);
      expect(
        String(schemaFailure instanceof AggregateError && schemaFailure.errors[0]),
      ).toContain('Refusing an unversioned partial');
      expect(schemaFailure instanceof AggregateError && schemaFailure.errors[1]).toBe(
        rollbackFailure,
      );
    } finally {
      raw.close();
    }
  });

  test('initializeAgentRuntimeSqlite preserves the original failure when SQLite already rolled back the transaction', () => {
    const database = new Database(':memory:');
    try {
      // A BEFORE INSERT trigger with RAISE(ROLLBACK, ...) causes SQLite to abort the
      // open BEGIN IMMEDIATE transaction before initializeAgentRuntimeSqlite's catch
      // block runs ROLLBACK.
      database.exec(
        'CREATE TABLE stitchkit_agent_runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      database.exec(`
        CREATE TRIGGER abort_meta_insert
        BEFORE INSERT ON stitchkit_agent_runtime_meta
        BEGIN
          SELECT RAISE(ROLLBACK, 'schema meta insert aborted');
        END
      `);

      expect(() => initializeAgentRuntimeSqlite(database)).toThrow(
        'schema meta insert aborted',
      );

      // All newly created runtime tables were rolled back cleanly.
      const remaining = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'stitchkit_agent_runtime_%'",
        )
        .all();
      expect(remaining).toEqual([{ name: 'stitchkit_agent_runtime_meta' }]);
    } finally {
      database.close();
    }

    // Negative control: an ordinary refusal rolls back the BEGIN IMMEDIATE transaction cleanly.
    const partial = new Database(':memory:');
    try {
      partial.exec('CREATE TABLE stitchkit_agent_runtime_heads (conversation_id TEXT)');
      expect(() => initializeAgentRuntimeSqlite(partial)).toThrow(
        'Refusing an unversioned partial Stitchkit agent-runtime SQLite schema',
      );
      // If ROLLBACK had not run, opening a new transaction would fail with "cannot start a transaction within a transaction".
      partial.exec('BEGIN IMMEDIATE');
      partial.exec('ROLLBACK');
    } finally {
      partial.close();
    }
  });
});
