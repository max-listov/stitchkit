/**
 * The minimal synchronous SQLite boundary the framework types against.
 *
 * Deliberately three methods and nothing else: it is satisfied structurally by
 * `bun:sqlite`'s `Database` and by a thin wrapper over `node:sqlite`, so a
 * caller passes the handle it already holds instead of adopting a driver of
 * ours. → ADR 0142.
 *
 * One name for one thing. This was `AgentRuntimeSqliteDatabase` while the agent
 * runtime was its only user; a second user made the name wrong rather than
 * merely long — a keyspace typed against an `AgentRuntime*` boundary reads as
 * a dependency on the agent runtime, which it is not.
 */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
  get(...parameters: SqliteValue[]): unknown;
  all(...parameters: SqliteValue[]): readonly unknown[];
  /**
   * `changes` is the driver's own count and is advisory: never decide
   * correctness by it.
   *
   * Because this boundary is satisfied structurally by a raw handle, the
   * number is whatever that driver reports. `bun:sqlite` includes rows written
   * by an AFTER INSERT trigger and by FTS5's deferred index flush during the
   * same statement, so a statement that moved one row can report five, and one
   * that moved none can report more than zero. A guarded `UPDATE`/upsert whose
   * outcome is read back from `changes` is therefore not a compare-and-swap.
   * Read the row, compare, then write unconditionally — inside the store's
   * `BEGIN IMMEDIATE` transaction that is atomic.
   */
  run(...parameters: SqliteValue[]): { changes: number };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** SQLite's own text when `ROLLBACK` finds no transaction: `bun:sqlite` and `node:sqlite` alike. */
const NO_ACTIVE_TRANSACTION = /no transaction is active/;

/**
 * What a failed transaction ends with once `ROLLBACK` has run. A failing statement may already
 * have ended the transaction (a constraint under `OR ROLLBACK`, a trigger's `RAISE(ROLLBACK)`),
 * and then `ROLLBACK` reports that none is active: the failure alone stands. A rollback that
 * fails for any other reason may leave the connection inside the transaction, and the next
 * `BEGIN` is refused for a reason nobody saw — so both are returned, the failure first and as
 * the cause.
 */
function failureAfterRollback(error: unknown, rollbackError: unknown): unknown {
  if (rollbackError instanceof Error && NO_ACTIVE_TRANSACTION.test(rollbackError.message)) {
    return error;
  }
  return new AggregateError(
    [error, rollbackError],
    'The SQLite transaction failed, and so did its rollback',
    {
      cause: error,
    },
  );
}

/** Roll back after `error` and return what the transaction failed with (see `failureAfterRollback`). */
export function rollbackSqliteFailure(
  database: { exec(sql: string): void },
  error: unknown,
): unknown {
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    return failureAfterRollback(error, rollbackError);
  }
  return error;
}

/** The same settlement on a connection that only speaks promises. */
export async function rollbackSqliteFailureAsync(
  connection: { exec(sql: string): Promise<void> },
  error: unknown,
): Promise<unknown> {
  try {
    await connection.exec('ROLLBACK');
  } catch (rollbackError) {
    return failureAfterRollback(error, rollbackError);
  }
  return error;
}
