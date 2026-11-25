/**
 * The sync server store in Postgres, inside the application's own transactions.
 *
 * The store never opens a connection: the app hands it its transaction and a
 * way to run one statement in it, so a change and the app's own writes commit
 * together.
 *
 * - Bun: `transaction: (work) => sql.begin(work)`, `query: (tx, text, p) => tx.unsafe(text, [...p])`
 * - Prisma: `transaction: (work) => prisma.$transaction(work)`,
 *   `query: (tx, text, p) => tx.$queryRawUnsafe(text, ...p)`
 * - `pg`: a client checked out of the pool, `BEGIN` … `COMMIT` around `work(client)`.
 *
 * ## Order of numbers and locks
 *
 * A scope's counter is one row. `allocateVersions` updates it with a single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which holds the row's lock
 * until the transaction ends; the next writer of the scope waits, so versions
 * commit in their order and a reader never finds a lower version appearing
 * behind one it already saw. Take the numbers as late in the transaction as
 * the work allows — the lock is held from there to the commit — and, when one
 * transaction writes several scopes, in one order (sorted by scope name) so two
 * writers cannot wait on each other. A wait longer than `lockTimeoutMs` fails
 * the transaction instead of hanging it.
 *
 * The wait needs `READ COMMITTED`, Postgres's default: under `REPEATABLE READ`
 * or `SERIALIZABLE` a writer that waited fails with a serialization error
 * instead of continuing. The timeout is set for the counter statement and
 * cold-start table initialization only; the application's own `lock_timeout`
 * is back in force for the rest of the transaction.
 *
 * A reader takes the scope's newest version **before** its page, so a page's
 * `latestVersion` never names a version the page could have missed.
 */
import { createHash } from 'node:crypto';
import {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
} from '../internal/positive-integer';
import type { PostgresQuery } from '../internal/postgres-query';
import {
  createSyncServerStore,
  type SyncFeedChange,
  type SyncLedgerRecord,
  type SyncServerStore,
} from './server-store';

/** Configuration for constructing a Postgres-backed `SyncServerStore`. */
export interface PostgresSyncStoreConfig<TX> {
  /** The application's transaction: commit when `work` resolves, roll back when it throws. */
  transaction<T>(work: (tx: TX) => Promise<T>): Promise<T>;
  query: PostgresQuery<TX>;
  /** Table name prefix: `<prefix>_counters`, `<prefix>_feed`, `<prefix>_ledger`. Default `sync`. */
  readonly prefix?: string;
  /**
   * Create the tables on first use when missing. Default `true`; set `false`
   * when migrations own the schema — `postgresSyncStoreDdl` is the text.
   */
  readonly createTables?: boolean;
  /** The version before the first a new scope hands out. Default 0. */
  readonly startAfter?: number;
  /** How long a writer waits for a scope's counter or cold-start table creation. Default 5000 ms. */
  readonly lockTimeoutMs?: number;
  readonly now?: () => number;
}

const PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

function checkedPrefix(prefix: string): string {
  if (!PREFIX.test(prefix))
    throw new TypeError(
      '[stitchkit] sync store: a table prefix is [A-Za-z_][A-Za-z0-9_]{0,40}',
    );
  return prefix;
}

/** The tables and indexes, for a migration. Safe to run twice. */
export function postgresSyncStoreDdl(prefix = 'sync'): string {
  const p = checkedPrefix(prefix);
  return `CREATE TABLE IF NOT EXISTS ${p}_counters (
  scope TEXT PRIMARY KEY,
  version BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${p}_feed (
  scope TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  deleted BOOLEAN NOT NULL,
  PRIMARY KEY (scope, entity, entity_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ${p}_feed_version ON ${p}_feed (scope, version);
CREATE TABLE IF NOT EXISTS ${p}_ledger (
  scope TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  code TEXT,
  version BIGINT,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (scope, replica_id, change_id)
);
CREATE INDEX IF NOT EXISTS ${p}_ledger_recorded ON ${p}_ledger (recorded_at);`;
}

/** A driver's `bigint`: a number, a decimal string or a `bigint`, by driver — exact or refused. */
function integer(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'bigint' || (typeof value === 'string' && /^-?\d+$/.test(value))
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number))
    throw new TypeError('[stitchkit] sync store: the database returned no exact integer');
  return number;
}

function field(row: unknown, name: string): unknown {
  return typeof row === 'object' && row !== null ? Reflect.get(row, name) : undefined;
}

function text(row: unknown, name: string): string {
  const value = field(row, name);
  if (typeof value !== 'string')
    throw new TypeError(`[stitchkit] sync store: the database returned no text ${name}`);
  return value;
}

function checkedConfig<TX>(config: PostgresSyncStoreConfig<TX>) {
  const startAfter = config.startAfter ?? 0;
  assertNonNegativeSafeInteger('[stitchkit] sync store: startAfter', startAfter, RangeError);
  const lockTimeoutMs = config.lockTimeoutMs ?? 5000;
  assertPositiveSafeInteger(
    '[stitchkit] sync store: lockTimeoutMs',
    lockTimeoutMs,
    RangeError,
  );
  return {
    p: checkedPrefix(config.prefix ?? 'sync'),
    startAfter,
    lockTimeout: `${lockTimeoutMs}ms`,
  };
}

/** Two signed 32-bit advisory lock keys derived deterministically from the table prefix. */
function schemaLockKeys(prefix: string): readonly [number, number] {
  // Unquoted Postgres identifiers fold to lowercase, so mixed-case spellings share one lock.
  const digest = createHash('sha256')
    .update(`stitchkit:sync:schema:${prefix.toLowerCase()}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Run `work` under `lockTimeout`, then restore the transaction's previous `lock_timeout`.
 * Not wrapped in `finally`: if `work` fails with a Postgres error, the transaction is aborted
 * and its local `set_config` discards on rollback — running another query would mask the cause.
 */
async function withLockTimeout<TX, T>(
  query: PostgresQuery<TX>,
  tx: TX,
  lockTimeout: string,
  work: () => Promise<T>,
): Promise<T> {
  const [previous] = await query(tx, `SELECT current_setting('lock_timeout') AS previous`, []);
  await query(tx, `SELECT set_config('lock_timeout', $1, true)`, [lockTimeout]);
  const result = await work();
  await query(tx, `SELECT set_config('lock_timeout', $1, true)`, [text(previous, 'previous')]);
  return result;
}

/**
 * The tables, created once: by the store's first own transaction, or inside the
 * application's transaction when a write comes first — DDL is transactional, so
 * the first write on a fresh database does not fail.
 *
 * `CREATE TABLE IF NOT EXISTS` still races on Postgres's `pg_type` catalog when
 * two transactions initialize a fresh prefix concurrently, so `createIn` checks
 * `to_regclass` lock-free first, then takes a transaction-scoped advisory lock
 * keyed by the prefix hash (under `lockTimeout`) and double-checks before DDL.
 */
function tableKeeper<TX>(config: PostgresSyncStoreConfig<TX>, p: string, lockTimeout: string) {
  const normalized = p.toLowerCase();
  const lockKeys = schemaLockKeys(normalized);
  const schemaObjects = [
    `${normalized}_counters`,
    `${normalized}_feed`,
    `${normalized}_feed_version`,
    `${normalized}_ledger`,
    `${normalized}_ledger_recorded`,
  ];
  const schemaExists = async (tx: TX): Promise<boolean> => {
    const [row] = await config.query(
      tx,
      `SELECT (
         to_regclass($1::text) IS NOT NULL
         AND to_regclass($2::text) IS NOT NULL
         AND to_regclass($3::text) IS NOT NULL
         AND to_regclass($4::text) IS NOT NULL
         AND to_regclass($5::text) IS NOT NULL
       ) AS ready`,
      schemaObjects,
    );
    return field(row, 'ready') === true;
  };
  // One statement per call: some clients refuse several in one prepared call.
  /** Makes the tables exist in `tx`; `true` when they were already there before it looked. */
  const createIn = async (tx: TX): Promise<boolean> => {
    if (await schemaExists(tx)) return true;
    await withLockTimeout(config.query, tx, lockTimeout, async () => {
      await config.query(
        tx,
        'SELECT 1 FROM pg_advisory_xact_lock($1::integer, $2::integer)',
        lockKeys,
      );
      if (await schemaExists(tx)) return;
      for (const statement of postgresSyncStoreDdl(p).split(';')) {
        if (statement.trim() !== '') await config.query(tx, statement, []);
      }
    });
    return false;
  };
  let created = config.createTables === false;
  let ready: Promise<void> | undefined;
  const creating = new WeakSet<object>();
  return {
    async transaction<T>(work: (tx: TX) => Promise<T>): Promise<T> {
      if (!created) {
        ready ??= config.transaction(createIn).then(
          () => {
            created = true;
          },
          (error: unknown) => {
            ready = undefined;
            throw error;
          },
        );
        await ready;
      }
      return config.transaction(work);
    },
    async within(tx: TX): Promise<void> {
      if (created) return;
      // Tables this transaction made itself may still roll back with it; tables that were
      // there when it first looked were committed by someone, and are there for good.
      const pending = typeof tx === 'object' && tx !== null ? tx : undefined;
      const madeHere = pending !== undefined && creating.has(pending);
      const existed = await createIn(tx);
      // A transaction that is not an object cannot be told from the one that made the
      // tables, so it never settles the question and every call keeps asking.
      if (existed && pending !== undefined && !madeHere) created = true;
      else if (!existed && pending !== undefined) creating.add(pending);
    },
  };
}

function ledgerRecord(row: unknown): SyncLedgerRecord {
  const outcome = text(row, 'outcome');
  if (outcome !== 'applied' && outcome !== 'terminal_rejected')
    throw new TypeError('[stitchkit] sync store: the ledger holds an unknown outcome');
  const code = field(row, 'code');
  const version = field(row, 'version');
  return {
    fingerprint: text(row, 'fingerprint'),
    outcome,
    code: typeof code === 'string' ? code : null,
    version: version === null ? null : integer(version),
    recordedAt: integer(field(row, 'recorded_at')),
  };
}

/** Create a Postgres-backed `SyncServerStore` running inside caller-managed transactions. */
export function postgresSyncStore<TX>(
  config: PostgresSyncStoreConfig<TX>,
): SyncServerStore<TX> {
  const { p, startAfter, lockTimeout } = checkedConfig(config);
  const tables = tableKeeper(config, p, lockTimeout);
  const transaction = <T>(work: (tx: TX) => Promise<T>) => tables.transaction(work);
  return createSyncServerStore<TX>(
    {
      transaction,
      async allocateVersions(tx, scope, count) {
        await tables.within(tx);
        const rows = await withLockTimeout(config.query, tx, lockTimeout, () =>
          config.query(
            tx,
            `INSERT INTO ${p}_counters (scope, version) VALUES ($1::text, $2::bigint + $3::bigint)
             ON CONFLICT (scope) DO UPDATE SET version = ${p}_counters.version + $3::bigint
             RETURNING version`,
            [scope, startAfter, count],
          ),
        );
        const last = integer(field(rows[0], 'version'));
        return Array.from({ length: count }, (_, index) => last - count + 1 + index);
      },
      async upsertFeed(tx, scope, changes) {
        await tables.within(tx);
        for (const change of changes) {
          await config.query(
            tx,
            `INSERT INTO ${p}_feed (scope, entity, entity_id, version, deleted)
             VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::boolean)
             ON CONFLICT (scope, entity, entity_id)
             DO UPDATE SET version = EXCLUDED.version, deleted = EXCLUDED.deleted`,
            [scope, change.entity, change.entityId, change.version, change.deleted],
          );
        }
      },
      async readLedger(tx, key) {
        const rows = await config.query(
          tx,
          `SELECT fingerprint, outcome, code, version, recorded_at FROM ${p}_ledger
           WHERE scope = $1::text AND replica_id = $2::text AND change_id = $3::text`,
          [key.scope, key.replicaId, key.changeId],
        );
        return rows[0] === undefined ? undefined : ledgerRecord(rows[0]);
      },
      async writeLedger(tx, key, record) {
        await config.query(
          tx,
          `INSERT INTO ${p}_ledger (scope, replica_id, change_id, fingerprint, outcome, code, version, recorded_at)
           VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::bigint)`,
          [
            key.scope,
            key.replicaId,
            key.changeId,
            record.fingerprint,
            record.outcome,
            record.code,
            record.version,
            record.recordedAt,
          ],
        );
      },
      changesAfter: (scope, after, read) =>
        transaction(async (tx) => {
          const latest = await config.query(
            tx,
            `SELECT version FROM ${p}_counters WHERE scope = $1::text`,
            [scope],
          );
          const rows = await config.query(
            tx,
            `SELECT entity, entity_id, version, deleted FROM ${p}_feed
             WHERE scope = $1::text AND version > $2::bigint ${read.full ? 'AND NOT deleted' : ''}
             ORDER BY version LIMIT $3::integer`,
            [scope, after ?? 0, read.limit + 1],
          );
          const changes: SyncFeedChange[] = rows.slice(0, read.limit).map((row) => ({
            entity: text(row, 'entity'),
            entityId: text(row, 'entity_id'),
            version: integer(field(row, 'version')),
            deleted: field(row, 'deleted') === true,
          }));
          const hasMore = rows.length > read.limit;
          return {
            changes,
            hasMore,
            nextCursor: hasMore ? (changes.at(-1)?.version ?? null) : null,
            latestVersion:
              latest[0] === undefined ? startAfter : integer(field(latest[0], 'version')),
          };
        }),
      prune: ({ before, scope }) =>
        transaction(async (tx) => {
          const rows = await config.query(
            tx,
            `WITH removed AS (
               DELETE FROM ${p}_ledger
               WHERE recorded_at < $1::bigint AND ($2::text IS NULL OR scope = $2::text)
               RETURNING 1)
             SELECT count(*)::integer AS removed FROM removed`,
            [Math.trunc(before), scope ?? null],
          );
          return integer(field(rows[0], 'removed'));
        }),
    },
    config.now ? { now: config.now } : {},
  );
}
