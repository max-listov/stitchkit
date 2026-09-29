/**
 * The update store in SQLite, through the database handle the application
 * already opened — `bun:sqlite`'s `Database` or `node:sqlite`'s `DatabaseSync`
 * as it is. The module imports neither, so it runs wherever its caller does.
 *
 * Each rule of `TelegramUpdateStore` is one conditional statement, so a claim
 * is atomic across processes sharing the file.
 */

import type {
  StoredTelegramUpdate,
  TelegramUpdateSettlement,
  TelegramUpdateStore,
} from './update-store';

/** What this store needs of a SQLite handle; both runtimes' handles have it. */
export interface TelegramSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...parameters: (string | number | null)[]): { readonly changes: number | bigint };
    all(...parameters: (string | number | null)[]): unknown[];
  };
}

export interface SqliteTelegramUpdateStoreConfig {
  readonly database: TelegramSqliteDatabase;
  /** Default `telegram_updates`. Created when missing. */
  readonly table?: string;
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** A claimable record at `?1` (now), in SQL. */
const CLAIMABLE = `(state = 'pending' OR (state = 'failed' AND due_at <= ?1)
  OR (state = 'processing' AND due_at < ?1))`;

function rowOf(row: unknown): StoredTelegramUpdate | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const updateId = 'update_id' in row ? row.update_id : undefined;
  const body = 'body' in row ? row.body : undefined;
  return typeof updateId === 'number' && typeof body === 'string'
    ? { updateId, body }
    : undefined;
}

export function sqliteTelegramUpdateStore(
  config: SqliteTelegramUpdateStoreConfig,
): TelegramUpdateStore {
  const table = config.table ?? 'telegram_updates';
  if (!TABLE_NAME.test(table)) {
    throw new TypeError(
      '[stitchkit] telegram update store: a table name is [A-Za-z_][A-Za-z0-9_]*',
    );
  }
  const database = config.database;
  database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    update_id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS ${table}_due ON ${table} (state, due_at);`);
  const insert = database.prepare(
    `INSERT OR IGNORE INTO ${table} (update_id, body, state, attempts, due_at, received_at)
     VALUES (?1, ?2, 'pending', 0, ?3, ?3)`,
  );
  const take = database.prepare(
    `UPDATE ${table} SET state = 'processing', attempts = attempts + 1, due_at = ?2, error = NULL
     WHERE update_id = ?3 AND attempts < ?4 AND ${CLAIMABLE} RETURNING attempts`,
  );
  const spend = database.prepare(
    `UPDATE ${table} SET state = 'abandoned', settled_at = ?1, error = 'attempts spent'
     WHERE update_id = ?2 AND attempts >= ?3 AND ${CLAIMABLE}`,
  );
  const renew = database.prepare(
    `UPDATE ${table} SET due_at = ?1 WHERE update_id = ?2 AND attempts = ?3 AND state = 'processing'`,
  );
  const settle = database.prepare(
    `UPDATE ${table} SET state = ?1, due_at = COALESCE(?2, due_at), settled_at = ?3, error = ?4
     WHERE update_id = ?5 AND attempts = ?6 AND state = 'processing'`,
  );
  const due = database.prepare(
    `SELECT update_id, body FROM ${table}
     WHERE (state = 'pending' AND received_at <= ?2) OR (state <> 'pending' AND ${CLAIMABLE})
     ORDER BY update_id LIMIT ?3`,
  );
  const prune = database.prepare(
    `DELETE FROM ${table} WHERE state IN ('completed', 'abandoned') AND settled_at < ?1`,
  );
  return {
    async add(update) {
      return Number(insert.run(update.updateId, update.body, update.receivedAt).changes) > 0;
    },
    async claim(updateId, options) {
      const [row] = take.all(options.now, options.leaseUntil, updateId, options.maxAttempts);
      const attempts =
        typeof row === 'object' && row !== null && 'attempts' in row
          ? row.attempts
          : undefined;
      if (typeof attempts === 'number') return attempts;
      spend.run(options.now, updateId, options.maxAttempts);
      return undefined;
    },
    async renew(updateId, attempt, leaseUntil) {
      return Number(renew.run(leaseUntil, updateId, attempt).changes) > 0;
    },
    async settle(updateId, attempt, settlement: TelegramUpdateSettlement) {
      settle.run(
        settlement.state,
        settlement.state === 'failed' ? settlement.retryAt : null,
        settlement.state === 'failed' ? null : settlement.at,
        settlement.state === 'completed' ? null : settlement.error,
        updateId,
        attempt,
      );
    },
    async due(query) {
      return due
        .all(query.now, query.pendingBefore, query.limit)
        .flatMap((row) => rowOf(row) ?? []);
    },
    async prune(before) {
      return Number(prune.run(before).changes);
    },
  };
}
