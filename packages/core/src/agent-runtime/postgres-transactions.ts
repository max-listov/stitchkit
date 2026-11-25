import type { PostgresQuery } from '../internal/postgres-query';
import { type AgentSqlSession, toNumberedPlaceholders } from './sql-session';

/** SQLSTATEs a retry can cure: a serialization failure and a deadlock. */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_ERROR_DEPTH = 6;

function* postgresErrorNodes(
  error: unknown,
  depth = 0,
  visited = new Set<object>(),
): Generator<object> {
  if (depth >= MAX_ERROR_DEPTH || typeof error !== 'object' || error === null) return;
  if (visited.has(error)) return;
  visited.add(error);
  yield error;
  const meta: unknown = Reflect.get(error, 'meta');
  if (typeof meta === 'object' && meta !== null) {
    yield* postgresErrorNodes(Reflect.get(meta, 'driverAdapterError'), depth + 1, visited);
    yield* postgresErrorNodes(meta, depth + 1, visited);
  }
  yield* postgresErrorNodes(Reflect.get(error, 'cause'), depth + 1, visited);
}

function nodeSqlState(node: object): string | undefined {
  // Bun's SQL client puts the SQLSTATE in `errno`, `pg` in `code`, Prisma's
  // driver adapters in `originalCode` on the cause. Ignore Prisma's own `P2xxx` codes.
  for (const key of ['errno', 'code', 'originalCode', 'sqlState']) {
    const field: unknown = Reflect.get(node, key);
    if (typeof field === 'string' && /^[0-9A-Z]{5}$/.test(field) && !/^P\d{4}$/.test(field)) {
      return field;
    }
  }
  return undefined;
}

function p2010SqlState(node: object): string | undefined {
  if (Reflect.get(node, 'code') !== 'P2010') return undefined;
  const message: unknown = Reflect.get(node, 'message');
  if (typeof message !== 'string') return undefined;
  const backticked = /Code:\s*`([0-9A-Z]{5})`/.exec(message);
  if (backticked?.[1] !== undefined && !/^P\d{4}$/.test(backticked[1])) {
    return backticked[1];
  }
  const retryable = /\b(40001|40P01)\b/.exec(message);
  return retryable?.[1];
}

/** The SQLSTATE of a Postgres failure, on the error, its `cause` chain, or Prisma `meta`. */
export function postgresErrorState(error: unknown): string | undefined {
  let fromMessage: string | undefined;
  for (const node of postgresErrorNodes(error)) {
    const direct = nodeSqlState(node);
    if (direct !== undefined) return direct;
    fromMessage ??= p2010SqlState(node);
  }
  return fromMessage;
}

/**
 * Whether a failed transaction lost a serialization race and may run again.
 *
 * Recognized by shape, without importing a client: the SQLSTATE wherever the
 * client keeps it, on the error, in Prisma `meta` / `driverAdapterError`, or
 * down its `cause` chain; Prisma's `P2034`; Prisma's raw-query `P2010`
 * carrying the state in its message; and the `TransactionWriteConflict` kind
 * Prisma reports for a conflict at `COMMIT`. A broken connection is not among
 * them: a `COMMIT` whose answer was lost may have committed, and running the
 * work again would apply it twice.
 */
export function isRetryablePostgresConflict(error: unknown): boolean {
  const state = postgresErrorState(error);
  if (state !== undefined && RETRYABLE.has(state)) return true;
  for (const node of postgresErrorNodes(error)) {
    if (Reflect.get(node, 'code') === 'P2034') return true;
    if (Reflect.get(node, 'kind') === 'TransactionWriteConflict') return true;
  }
  return false;
}

export interface PostgresTransactionRunner<TX> {
  transaction<RESULT>(work: (tx: TX) => Promise<RESULT>): Promise<RESULT>;
  query: PostgresQuery<TX>;
  /** Attempts before a conflict surfaces. Default 32. */
  maxAttempts: number;
  /** Decides what may be retried; the default recognizes 40001 and 40P01. */
  isRetryable: (error: unknown) => boolean;
  /** The isolation statement each transaction opens with; the store's own, replaceable only by a test. */
  isolation: { write: string; read: string };
}

export const POSTGRES_ISOLATION = {
  write: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
  read: 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
};

/** A session over one open transaction: `?` placeholders numbered once per statement text. */
export function postgresSession<TX>(query: PostgresQuery<TX>, tx: TX): AgentSqlSession {
  const texts = new Map<string, string>();
  const text = (sql: string) => {
    let numbered = texts.get(sql);
    if (numbered === undefined) {
      numbered = toNumberedPlaceholders(sql);
      texts.set(sql, numbered);
    }
    return numbered;
  };
  return {
    all: (sql, parameters = []) => query(tx, text(sql), parameters),
    get: async (sql, parameters = []) => (await query(tx, text(sql), parameters))[0],
    run: async (sql, parameters = []) => {
      await query(tx, text(sql), parameters);
    },
  };
}

function backoff(attempt: number): Promise<void> {
  const ceiling = Math.min(200, 2 ** attempt);
  return new Promise((resolve) => setTimeout(resolve, Math.random() * ceiling));
}

/**
 * Set the isolation statement of a freshly opened transaction.
 *
 * Postgres raises SQLSTATE `25001` when the caller already ran a statement
 * inside the transaction before handing it to the store; translate that into
 * the store's refusal while preserving the underlying error as `cause`.
 */
export async function setPostgresTransactionIsolation(
  session: AgentSqlSession,
  statement: string,
): Promise<void> {
  try {
    await session.run(statement);
  } catch (error) {
    if (postgresErrorState(error) === '25001') {
      throw new Error(
        "The Postgres agent store opens its own transactions: `transaction` must start a new one, with no statement run in it before the store's",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * One store transaction: opened by the application's `transaction`, set to
 * SERIALIZABLE (or a read-only snapshot) by its first statement, and run
 * again from the start when Postgres reports that it lost a serialization race.
 *
 * The store owns the transaction because it owns the retry. A serializable
 * conflict can surface on any statement or on `COMMIT`, and the only cure is
 * running the whole unit again — which only the code that opened it can do.
 */
export async function runPostgresTransaction<TX, RESULT>(
  runner: PostgresTransactionRunner<TX>,
  access: 'read' | 'write',
  work: (session: AgentSqlSession) => Promise<RESULT>,
): Promise<RESULT> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runner.transaction(async (tx) => {
        const session = postgresSession(runner.query, tx);
        await setPostgresTransactionIsolation(session, runner.isolation[access]);
        return work(session);
      });
    } catch (error) {
      if (attempt >= runner.maxAttempts || !runner.isRetryable(error)) throw error;
      await backoff(attempt);
    }
  }
}
