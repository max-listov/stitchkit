/**
 * The update store in SQLite, through the database handle the application
 * already opened — `bun:sqlite`'s `Database` or `node:sqlite`'s `DatabaseSync`
 * as it is. The module imports neither, so it runs wherever its caller does.
 *
 * Each rule of `TelegramUpdateStore` is one conditional statement, so a claim
 * is atomic across processes sharing the file.
 */

import { randomUUID } from 'node:crypto';
import type {
  StoredTelegramUpdate,
  StoredTelegramUpdateExhaustion,
  TelegramUpdateAttemptIdentity,
  TelegramUpdateClaimOptions,
  TelegramUpdateDurableStore,
  TelegramUpdateSettlement,
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

type TelegramSqliteStatement = ReturnType<TelegramSqliteDatabase['prepare']>;

interface TelegramSqliteUpdateStatements {
  readonly insert: TelegramSqliteStatement;
  readonly take: TelegramSqliteStatement;
  readonly spend: TelegramSqliteStatement;
  readonly renew: TelegramSqliteStatement;
  readonly settle: TelegramSqliteStatement;
  readonly due: TelegramSqliteStatement;
  readonly prune: TelegramSqliteStatement;
  readonly owns: TelegramSqliteStatement;
  readonly exhaust: TelegramSqliteStatement;
  readonly dueExhaustions: TelegramSqliteStatement;
  readonly acknowledgeExhaustion: TelegramSqliteStatement;
}

/** Create or migrate the owned schema, then compile every atomic store statement once. */
function prepareTelegramSqliteUpdateStatements(
  database: TelegramSqliteDatabase,
  table: string,
): TelegramSqliteUpdateStatements {
  database.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    update_id INTEGER PRIMARY KEY,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT,
    claim_id TEXT
  );
  CREATE INDEX IF NOT EXISTS ${table}_due ON ${table} (state, due_at);`);
  const hasClaimId = (): boolean =>
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some(
        (row) =>
          typeof row === 'object' && row !== null && 'name' in row && row.name === 'claim_id',
      );
  if (!hasClaimId()) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN claim_id TEXT`);
    } catch (error) {
      // Another process may have won the schema upgrade between PRAGMA and ALTER.
      if (!hasClaimId()) throw error;
    }
  }
  return {
    insert: database.prepare(
      `INSERT OR IGNORE INTO ${table} (update_id, body, state, attempts, due_at, received_at)
       VALUES (?1, ?2, 'pending', 0, ?3, ?3)`,
    ),
    take: database.prepare(
      `UPDATE ${table} SET state = 'processing', attempts = attempts + 1, due_at = ?2,
         error = NULL, claim_id = ?5
       WHERE update_id = ?3 AND attempts < ?4 AND ${CLAIMABLE}
       RETURNING attempts, claim_id`,
    ),
    spend: database.prepare(
      `UPDATE ${table} SET state = 'abandoned', due_at = ?1,
         settled_at = CASE WHEN ?4 = 1 THEN NULL ELSE ?1 END, error = 'attempts spent',
         claim_id = COALESCE(claim_id, ?5)
       WHERE update_id = ?2 AND attempts >= ?3 AND ${CLAIMABLE}`,
    ),
    renew: database.prepare(
      `UPDATE ${table} SET due_at = MAX(due_at, ?1)
       WHERE update_id = ?2 AND attempts = ?3 AND state = 'processing'
         AND (?4 IS NULL OR due_at >= ?4) AND (?5 IS NULL OR claim_id = ?5)`,
    ),
    settle: database.prepare(
      `UPDATE ${table} SET state = ?1, due_at = COALESCE(?2, due_at), settled_at = ?3, error = ?4
       WHERE update_id = ?5 AND attempts = ?6 AND state = 'processing' AND due_at >= ?7
         AND (?8 IS NULL OR claim_id = ?8)`,
    ),
    due: database.prepare(
      `SELECT update_id, body FROM ${table}
       WHERE (state = 'pending' AND received_at <= ?2) OR (state <> 'pending' AND ${CLAIMABLE})
       ORDER BY update_id LIMIT ?3`,
    ),
    prune: database.prepare(
      `DELETE FROM ${table} WHERE state IN ('completed', 'abandoned') AND settled_at < ?1`,
    ),
    owns: database.prepare(
      `SELECT update_id FROM ${table}
       WHERE update_id = ?1 AND attempts = ?2 AND state = 'processing' AND due_at >= ?3
         AND claim_id = ?4`,
    ),
    exhaust: database.prepare(
      `UPDATE ${table} SET state = 'abandoned', due_at = ?1, settled_at = NULL, error = ?2
       WHERE update_id = ?3 AND attempts = ?4 AND state = 'processing' AND due_at >= ?1
         AND claim_id = ?5`,
    ),
    dueExhaustions: database.prepare(
      `SELECT update_id, body, attempts, due_at, error, claim_id FROM ${table}
       WHERE state = 'abandoned' AND settled_at IS NULL
         AND (?2 IS NULL OR update_id > ?2)
       ORDER BY update_id LIMIT ?1`,
    ),
    acknowledgeExhaustion: database.prepare(
      `UPDATE ${table} SET settled_at = ?1
       WHERE update_id = ?2 AND attempts = ?3 AND state = 'abandoned' AND settled_at IS NULL
         AND claim_id = ?4`,
    ),
  };
}

function rowOf(row: unknown): StoredTelegramUpdate | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const updateId = 'update_id' in row ? row.update_id : undefined;
  const body = 'body' in row ? row.body : undefined;
  return typeof updateId === 'number' && typeof body === 'string'
    ? { updateId, body }
    : undefined;
}

function exhaustionOf(row: unknown): StoredTelegramUpdateExhaustion | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const updateId = 'update_id' in row ? row.update_id : undefined;
  const body = 'body' in row ? row.body : undefined;
  const attempt = 'attempts' in row ? row.attempts : undefined;
  const exhaustedAt = 'due_at' in row ? row.due_at : undefined;
  const error = 'error' in row ? row.error : undefined;
  const claimId = 'claim_id' in row ? row.claim_id : undefined;
  return typeof updateId === 'number' &&
    typeof body === 'string' &&
    typeof attempt === 'number' &&
    typeof claimId === 'string' &&
    typeof exhaustedAt === 'number' &&
    typeof error === 'string'
    ? { updateId, body, attempt, claimId, exhaustedAt, error }
    : undefined;
}

export function sqliteTelegramUpdateStore(
  config: SqliteTelegramUpdateStoreConfig,
): TelegramUpdateDurableStore {
  const table = config.table ?? 'telegram_updates';
  if (!TABLE_NAME.test(table)) {
    throw new TypeError(
      '[stitchkit] telegram update store: a table name is [A-Za-z_][A-Za-z0-9_]*',
    );
  }
  const database = config.database;
  const {
    insert,
    take,
    spend,
    renew,
    settle,
    due,
    prune,
    owns,
    exhaust,
    dueExhaustions,
    acknowledgeExhaustion,
  } = prepareTelegramSqliteUpdateStatements(database, table);
  const settleCurrent = (
    updateId: number,
    attempt: number,
    settlement: TelegramUpdateSettlement,
    claimId?: string,
  ): boolean =>
    Number(
      settle.run(
        settlement.state,
        settlement.state === 'failed' ? settlement.retryAt : null,
        settlement.state === 'failed' ? null : settlement.at,
        settlement.state === 'completed' ? null : settlement.error,
        updateId,
        attempt,
        settlement.at,
        claimId ?? null,
      ).changes,
    ) > 0;
  const takeAttempt = (
    updateId: number,
    options: TelegramUpdateClaimOptions,
  ): TelegramUpdateAttemptIdentity | undefined => {
    const claimId = randomUUID();
    const [row] = take.all(
      options.now,
      options.leaseUntil,
      updateId,
      options.maxAttempts,
      claimId,
    );
    const attempt =
      typeof row === 'object' && row !== null && 'attempts' in row ? row.attempts : undefined;
    const persistedClaimId =
      typeof row === 'object' && row !== null && 'claim_id' in row ? row.claim_id : undefined;
    if (typeof attempt === 'number' && typeof persistedClaimId === 'string') {
      return { updateId, attempt, claimId: persistedClaimId };
    }
    spend.run(
      options.now,
      updateId,
      options.maxAttempts,
      options.durableExhaustion ? 1 : 0,
      claimId,
    );
    return undefined;
  };
  return {
    async add(update) {
      return Number(insert.run(update.updateId, update.body, update.receivedAt).changes) > 0;
    },
    async claim(updateId, options) {
      return takeAttempt(updateId, options)?.attempt;
    },
    async claimOwned(updateId, options) {
      return takeAttempt(updateId, options);
    },
    async renew(updateId, attempt, leaseUntil, at) {
      return Number(renew.run(leaseUntil, updateId, attempt, at ?? null, null).changes) > 0;
    },
    async settle(updateId, attempt, settlement: TelegramUpdateSettlement) {
      settleCurrent(updateId, attempt, settlement);
    },
    async due(query) {
      return due
        .all(query.now, query.pendingBefore, query.limit)
        .flatMap((row) => rowOf(row) ?? []);
    },
    async owns(identity: TelegramUpdateAttemptIdentity, at) {
      return owns.all(identity.updateId, identity.attempt, at, identity.claimId).length > 0;
    },
    async renewOwned(identity, leaseUntil, at) {
      return (
        Number(
          renew.run(
            leaseUntil,
            identity.updateId,
            identity.attempt,
            at ?? null,
            identity.claimId,
          ).changes,
        ) > 0
      );
    },
    async settleOwned(identity, settlement) {
      return settleCurrent(identity.updateId, identity.attempt, settlement, identity.claimId);
    },
    async exhaust(identity, exhaustion) {
      return (
        Number(
          exhaust.run(
            exhaustion.at,
            exhaustion.error,
            identity.updateId,
            identity.attempt,
            identity.claimId,
          ).changes,
        ) > 0
      );
    },
    async dueExhaustions(query) {
      return dueExhaustions
        .all(query.limit, query.afterUpdateId ?? null)
        .flatMap((row) => exhaustionOf(row) ?? []);
    },
    async acknowledgeExhaustion(identity, at) {
      return (
        Number(
          acknowledgeExhaustion.run(at, identity.updateId, identity.attempt, identity.claimId)
            .changes,
        ) > 0
      );
    },
    async prune(before) {
      return Number(prune.run(before).changes);
    },
  };
}
