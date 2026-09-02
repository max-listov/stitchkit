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
  run(...parameters: SqliteValue[]): { changes: number };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
