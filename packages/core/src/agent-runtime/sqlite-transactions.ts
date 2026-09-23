import { AsyncLocalStorage } from 'node:async_hooks';
import { AppendAgentStoreEventSchema } from '../durability/events';
import type { SqliteDatabase } from '../internal/sqlite';
import type { SqliteStoreTransaction } from './sqlite';
import type { SqliteStoreDriver } from './sqlite-rows';
import { appendEventIn } from './store-reads';

/**
 * What one SQLite store instance serializes on.
 *
 * One connection takes one transaction at a time, so every store operation
 * and every companion transaction queues on `tail`. The parts of the store
 * that open a transaction all take this object, so the queue, the closing
 * flags and the scope marker stay one per store however many modules use them.
 */
export interface SqliteStoreState {
  readonly database: SqliteDatabase;
  closing: boolean;
  closed: boolean;
  tail: Promise<void>;
  readonly insideScope: AsyncLocalStorage<boolean>;
}

export function createSqliteStoreState(database: SqliteDatabase): SqliteStoreState {
  return {
    database,
    closing: false,
    closed: false,
    tail: Promise.resolve(),
    insideScope: new AsyncLocalStorage<boolean>(),
  };
}

function serial<RESULT>(
  state: SqliteStoreState,
  work: () => Promise<RESULT>,
): Promise<RESULT> {
  if (state.closing || state.closed) {
    return Promise.reject(new Error('SQLite agent-runtime store is closing'));
  }
  // A store call from inside a `transaction` scope would queue behind the
  // very transaction that is waiting for it — silently, forever. Refuse.
  if (state.insideScope.getStore()) {
    return Promise.reject(
      new Error(
        'SQLite agent-runtime store called from inside its own transaction scope; use scope.database and scope.appendEvent',
      ),
    );
  }
  const result = state.tail.then(work, work);
  state.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function runSqliteTransaction<RESULT>(
  state: SqliteStoreState,
  access: 'read' | 'write',
  work: (transaction: SqliteDatabase) => Promise<RESULT>,
): Promise<RESULT> {
  const database = state.database;
  return serial(state, async () => {
    database.exec(access === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = await work(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  });
}

/** A companion's write transaction, marked so a store call from inside it is refused. */
export function runSqliteStoreScope<RESULT>(
  state: SqliteStoreState,
  driver: SqliteStoreDriver,
  work: (scope: SqliteStoreTransaction) => Promise<RESULT>,
): Promise<RESULT> {
  return runSqliteTransaction(state, 'write', (transaction) =>
    state.insideScope.run(true, () =>
      work({
        database: transaction,
        appendEvent: (input) =>
          appendEventIn(driver, transaction, AppendAgentStoreEventSchema.parse(input)),
      }),
    ),
  );
}

export async function closeSqliteStore(state: SqliteStoreState): Promise<void> {
  if (state.closed) return;
  state.closing = true;
  await state.tail;
  state.database.close();
  state.closed = true;
}
