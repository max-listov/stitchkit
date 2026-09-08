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
