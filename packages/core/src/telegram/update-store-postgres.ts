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

import type { TelegramUpdateSettlement, TelegramUpdateStore } from './update-store';

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
  error TEXT
);
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

export function postgresTelegramUpdateStore(
  config: PostgresTelegramUpdateStoreConfig,
): TelegramUpdateStore {
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
      const [row] = await run(
        `UPDATE ${table} SET state = 'processing', attempts = attempts + 1,
           due_at = $2::bigint, error = NULL
         WHERE update_id = $3::bigint AND attempts < $4::integer AND ${CLAIMABLE}
         RETURNING attempts`,
        [options.now, options.leaseUntil, updateId, options.maxAttempts],
      );
      const attempts = integer(field(row, 'attempts'));
      if (attempts !== undefined) return attempts;
      await run(
        `UPDATE ${table} SET state = 'abandoned', settled_at = $1::bigint, error = 'attempts spent'
         WHERE update_id = $2::bigint AND attempts >= $3::integer AND ${CLAIMABLE}
         RETURNING update_id`,
        [options.now, updateId, options.maxAttempts],
      );
      return undefined;
    },
    async renew(updateId, attempt, leaseUntil) {
      const rows = await run(
        `UPDATE ${table} SET due_at = $1::bigint
         WHERE update_id = $2::bigint AND attempts = $3::integer AND state = 'processing'
         RETURNING update_id`,
        [leaseUntil, updateId, attempt],
      );
      return rows.length > 0;
    },
    async settle(updateId, attempt, settlement: TelegramUpdateSettlement) {
      await run(
        `UPDATE ${table} SET state = $1::text, due_at = COALESCE($2::bigint, due_at),
           settled_at = $3::bigint, error = $4::text
         WHERE update_id = $5::bigint AND attempts = $6::integer AND state = 'processing'
         RETURNING update_id`,
        [
          settlement.state,
          settlement.state === 'failed' ? settlement.retryAt : null,
          settlement.state === 'failed' ? null : settlement.at,
          settlement.state === 'completed' ? null : settlement.error,
          updateId,
          attempt,
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
