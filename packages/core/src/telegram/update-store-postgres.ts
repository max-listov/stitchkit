/**
 * The update store in Postgres, through whatever client the application
 * already holds — one function that runs a statement with `$n` parameters and
 * returns its rows:
 *
 * - Bun: `(text, parameters) => sql.unsafe(text, [...parameters])`
 * - Prisma: `(text, parameters) => prisma.$queryRawUnsafe(text, ...parameters)`
 * - `pg`: `(text, parameters) => pool.query(text, [...parameters]).then((result) => result.rows)`
 *
 * Each rule of `TelegramUpdateStore` is one conditional statement, so a claim
 * is atomic across every process sharing the table; every statement returns
 * rows, so a client that has only a "query" call needs nothing else.
 * Parameters carry explicit casts: a driver that sends a JS number as a
 * double still lands in a `bigint` column.
 */

import { randomUUID } from 'node:crypto';
import type {
  StoredTelegramUpdateExhaustion,
  TelegramUpdateAttemptIdentity,
  TelegramUpdateClaimOptions,
  TelegramUpdateDurableStore,
  TelegramUpdateSettlement,
} from './update-store';

/** Run one statement with `$1…$n` parameters; resolve with the rows it returned. */
export type TelegramPostgresQuery = (
  text: string,
  parameters: readonly (string | number | null)[],
) => Promise<readonly unknown[]>;

export interface PostgresTelegramUpdateStoreConfig {
  readonly query: TelegramPostgresQuery;
  /** Default `telegram_updates`. */
  readonly table?: string;
  /**
   * Create the table on first use when it is missing. Default `true`; set
   * `false` when migrations own the schema — `postgresTelegramUpdateStoreSchema`
   * is the statement to put in one.
   */
  readonly createTable?: boolean;
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function checkedTable(table: string): string {
  if (!TABLE_NAME.test(table)) {
    throw new TypeError(
      '[stitchkit] telegram update store: a table name is [A-Za-z_][A-Za-z0-9_]*',
    );
  }
  return table;
}

/** The table and its index, for a migration. Safe to run twice. */
export function postgresTelegramUpdateStoreSchema(table = 'telegram_updates'): string {
  const name = checkedTable(table);
  return `CREATE TABLE IF NOT EXISTS ${name} (
  update_id BIGINT PRIMARY KEY,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  due_at BIGINT NOT NULL,
  received_at BIGINT NOT NULL,
  settled_at BIGINT,
  error TEXT,
  claim_id TEXT
);
ALTER TABLE ${name} ADD COLUMN IF NOT EXISTS claim_id TEXT;
CREATE INDEX IF NOT EXISTS ${name}_due ON ${name} (state, due_at);`;
}

/** A claimable record at `$1` (now), in SQL. */
const CLAIMABLE = `(state = 'pending' OR (state = 'failed' AND due_at <= $1::bigint)
  OR (state = 'processing' AND due_at < $1::bigint))`;

/** A driver's `bigint`: a number, a decimal string or a `bigint`, by driver. */
function integer(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value))) {
    return Number(value);
  }
  return undefined;
}

function field(row: unknown, name: string): unknown {
  return typeof row === 'object' && row !== null && name in row
    ? Reflect.get(row, name)
    : undefined;
}

/** Bind lazy schema readiness and the shared fenced mutations around one query function. */
function createPostgresTelegramUpdateContext(config: PostgresTelegramUpdateStoreConfig) {
  const table = checkedTable(config.table ?? 'telegram_updates');
  const { query } = config;
  let ready: Promise<void> | undefined;
  const run = async (
    text: string,
    parameters: readonly (string | number | null)[],
  ): Promise<readonly unknown[]> => {
    if (config.createTable !== false) {
      // One statement per call: some clients refuse several in one prepared call.
      ready ??= postgresTelegramUpdateStoreSchema(table)
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement !== '')
        .reduce<Promise<unknown>>(
          (previous, statement) => previous.then(() => query(statement, [])),
          Promise.resolve(),
        )
        .then(
          () => undefined,
          (error: unknown) => {
            ready = undefined;
            throw error;
          },
        );
      await ready;
    }
    return query(text, parameters);
  };
  const settleOwned = async (
    updateId: number,
    attempt: number,
    settlement: TelegramUpdateSettlement,
    claimId: string,
  ): Promise<boolean> => {
    const rows = await run(
      `UPDATE ${table} SET state = $1::text, due_at = COALESCE($2::bigint, due_at),
         settled_at = $3::bigint, error = $4::text
       WHERE update_id = $5::bigint AND attempts = $6::integer AND state = 'processing'
         AND due_at >= $7::bigint
         AND claim_id = $8::text
       RETURNING update_id`,
      [
        settlement.state,
        settlement.state === 'failed' ? settlement.retryAt : null,
        settlement.state === 'failed' ? null : settlement.at,
        settlement.state === 'completed' ? null : settlement.error,
        updateId,
        attempt,
        settlement.at,
        claimId,
      ],
    );
    return rows.length > 0;
  };
  const takeAttempt = async (
    updateId: number,
    options: TelegramUpdateClaimOptions,
  ): Promise<TelegramUpdateAttemptIdentity | undefined> => {
    const claimId = randomUUID();
    const [row] = await run(
      `UPDATE ${table} SET state = 'processing', attempts = attempts + 1,
         due_at = $2::bigint, error = NULL, claim_id = $5::text
       WHERE update_id = $3::bigint AND attempts < $4::integer AND ${CLAIMABLE}
       RETURNING attempts, claim_id`,
      [options.now, options.leaseUntil, updateId, options.maxAttempts, claimId],
    );
    const attempt = integer(field(row, 'attempts'));
    const persistedClaimId = field(row, 'claim_id');
    if (attempt !== undefined && typeof persistedClaimId === 'string') {
      return { updateId, attempt, claimId: persistedClaimId };
    }
    await run(
      `UPDATE ${table} SET state = 'abandoned', due_at = $1::bigint,
         settled_at = CASE WHEN $4::integer = 1 THEN NULL ELSE $1::bigint END,
         error = 'attempts spent', claim_id = COALESCE(claim_id, $5::text)
       WHERE update_id = $2::bigint AND attempts >= $3::integer AND ${CLAIMABLE}
       RETURNING update_id`,
      [options.now, updateId, options.maxAttempts, options.durableExhaustion ? 1 : 0, claimId],
    );
    return undefined;
  };
  const renewCurrent = async (
    updateId: number,
    attempt: number,
    leaseUntil: number,
    at: number | undefined,
    claimId: string,
  ): Promise<boolean> => {
    const rows = await run(
      `UPDATE ${table} SET due_at = GREATEST(due_at, $1::bigint)
       WHERE update_id = $2::bigint AND attempts = $3::integer AND state = 'processing'
         AND ($4::bigint IS NULL OR due_at >= $4::bigint)
         AND claim_id = $5::text
       RETURNING update_id`,
      [leaseUntil, updateId, attempt, at ?? null, claimId],
    );
    return rows.length > 0;
  };
  return { table, run, settleOwned, takeAttempt, renewCurrent };
}

export function postgresTelegramUpdateStore(
  config: PostgresTelegramUpdateStoreConfig,
): TelegramUpdateDurableStore {
  const { table, run, settleOwned, takeAttempt, renewCurrent } =
    createPostgresTelegramUpdateContext(config);
  return {
    async add(update) {
      const rows = await run(
        `INSERT INTO ${table} (update_id, body, state, attempts, due_at, received_at)
         VALUES ($1::bigint, $2::text, 'pending', 0, $3::bigint, $3::bigint)
         ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
        [update.updateId, update.body, update.receivedAt],
      );
      return rows.length > 0;
    },
    async claim(updateId, options) {
      if (options.durableExhaustion) return (await takeAttempt(updateId, options))?.attempt;
      const [row] = await run(
        `UPDATE ${table} SET state = 'processing', attempts = attempts + 1,
           due_at = $2::bigint, error = NULL
         WHERE update_id = $3::bigint AND attempts < $4::integer AND ${CLAIMABLE}
         RETURNING attempts`,
        [options.now, options.leaseUntil, updateId, options.maxAttempts],
      );
      const attempt = integer(field(row, 'attempts'));
      if (attempt !== undefined) return attempt;
      await run(
        `UPDATE ${table} SET state = 'abandoned', due_at = $1::bigint,
           settled_at = CASE WHEN $4::integer = 1 THEN NULL ELSE $1::bigint END,
           error = 'attempts spent'
         WHERE update_id = $2::bigint AND attempts >= $3::integer AND ${CLAIMABLE}
         RETURNING update_id`,
        [options.now, updateId, options.maxAttempts, options.durableExhaustion ? 1 : 0],
      );
      return undefined;
    },
    async claimOwned(updateId, options) {
      return takeAttempt(updateId, options);
    },
    async renew(updateId, attempt, leaseUntil, at) {
      const rows = await run(
        `UPDATE ${table} SET due_at = GREATEST(due_at, $1::bigint)
         WHERE update_id = $2::bigint AND attempts = $3::integer AND state = 'processing'
           AND ($4::bigint IS NULL OR due_at >= $4::bigint)
         RETURNING update_id`,
        [leaseUntil, updateId, attempt, at ?? null],
      );
      return rows.length > 0;
    },
    async settle(updateId, attempt, settlement: TelegramUpdateSettlement) {
      await run(
        `UPDATE ${table} SET state = $1::text, due_at = COALESCE($2::bigint, due_at),
           settled_at = $3::bigint, error = $4::text
         WHERE update_id = $5::bigint AND attempts = $6::integer AND state = 'processing'
           AND due_at >= $7::bigint
         RETURNING update_id`,
        [
          settlement.state,
          settlement.state === 'failed' ? settlement.retryAt : null,
          settlement.state === 'failed' ? null : settlement.at,
          settlement.state === 'completed' ? null : settlement.error,
          updateId,
          attempt,
          settlement.at,
        ],
      );
    },
    async due(options) {
      const rows = await run(
        `SELECT update_id, body FROM ${table}
         WHERE (state = 'pending' AND received_at <= $2::bigint)
           OR (state <> 'pending' AND ${CLAIMABLE})
         ORDER BY update_id LIMIT $3::integer`,
        [options.now, options.pendingBefore, options.limit],
      );
      return rows.flatMap((row) => {
        const updateId = integer(field(row, 'update_id'));
        const body = field(row, 'body');
        return updateId !== undefined && typeof body === 'string' ? [{ updateId, body }] : [];
      });
    },
    async owns(identity, at) {
      const rows = await run(
        `SELECT update_id FROM ${table}
         WHERE update_id = $1::bigint AND attempts = $2::integer
           AND state = 'processing' AND due_at >= $3::bigint
           AND claim_id = $4::text
         FOR UPDATE`,
        [identity.updateId, identity.attempt, at, identity.claimId],
      );
      return rows.length > 0;
    },
    async renewOwned(identity, leaseUntil, at) {
      return renewCurrent(
        identity.updateId,
        identity.attempt,
        leaseUntil,
        at,
        identity.claimId,
      );
    },
    async settleOwned(identity, settlement) {
      return settleOwned(identity.updateId, identity.attempt, settlement, identity.claimId);
    },
    async exhaust(identity, exhaustion) {
      const rows = await run(
        `UPDATE ${table} SET state = 'abandoned', due_at = $1::bigint,
           settled_at = NULL, error = $2::text
         WHERE update_id = $3::bigint AND attempts = $4::integer AND state = 'processing'
           AND due_at >= $1::bigint AND claim_id = $5::text
         RETURNING update_id`,
        [
          exhaustion.at,
          exhaustion.error,
          identity.updateId,
          identity.attempt,
          identity.claimId,
        ],
      );
      return rows.length > 0;
    },
    async dueExhaustions(options) {
      const rows = await run(
        `SELECT update_id, body, attempts, due_at, error, claim_id FROM ${table}
         WHERE state = 'abandoned' AND settled_at IS NULL
           AND ($2::bigint IS NULL OR update_id > $2::bigint)
         ORDER BY update_id LIMIT $1::integer`,
        [options.limit, options.afterUpdateId ?? null],
      );
      return rows.flatMap((row): StoredTelegramUpdateExhaustion[] => {
        const updateId = integer(field(row, 'update_id'));
        const body = field(row, 'body');
        const attempt = integer(field(row, 'attempts'));
        const exhaustedAt = integer(field(row, 'due_at'));
        const error = field(row, 'error');
        const claimId = field(row, 'claim_id');
        return updateId !== undefined &&
          typeof body === 'string' &&
          attempt !== undefined &&
          typeof claimId === 'string' &&
          exhaustedAt !== undefined &&
          typeof error === 'string'
          ? [{ updateId, body, attempt, claimId, exhaustedAt, error }]
          : [];
      });
    },
    async acknowledgeExhaustion(identity, at) {
      const rows = await run(
        `UPDATE ${table} SET settled_at = $1::bigint
         WHERE update_id = $2::bigint AND attempts = $3::integer
           AND state = 'abandoned' AND settled_at IS NULL AND claim_id = $4::text
         RETURNING update_id`,
        [at, identity.updateId, identity.attempt, identity.claimId],
      );
      return rows.length > 0;
    },
    async prune(before) {
      const rows = await run(
        `DELETE FROM ${table} WHERE state IN ('completed', 'abandoned') AND settled_at < $1::bigint
         RETURNING update_id`,
        [before],
      );
      return rows.length;
    },
  };
}
