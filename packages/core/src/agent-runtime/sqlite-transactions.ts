import { AsyncLocalStorage } from 'node:async_hooks';
import { rollbackSqliteFailure, type SqliteDatabase } from '../internal/sqlite';
import { conversationTables } from './sql-purge';
import { nextEventSeqByMaximum } from './sql-rows';
import { type AgentSqlDialect, type AgentSqlSession, agentSqlTables } from './sql-session';

const TABLES = agentSqlTables('stitchkit_agent_runtime');

/** SQLite's side of the shared SQL store: fixed table names, `rowid`, `instr`, `MAX(seq)`. */
export const sqliteDialect: AgentSqlDialect = {
  name: 'sqlite',
  tables: TABLES,
  conversationTables: conversationTables(TABLES),
  messageRowId: 'rowid',
  contains: (column) => `instr(${column}, ?) > 0`,
  nextEventSeq: (session, conversationId) =>
    nextEventSeqByMaximum(sqliteDialect, session, conversationId),
};

/** The synchronous connection as an `AgentSqlSession`; `null` rows read as `undefined`. */
export function sqliteSession(database: SqliteDatabase): AgentSqlSession {
  return {
    all: async (sql, parameters = []) => database.prepare(sql).all(...parameters),
    get: async (sql, parameters = []) => database.prepare(sql).get(...parameters) ?? undefined,
    run: async (sql, parameters = []) => {
      database.prepare(sql).run(...parameters);
    },
  };
}

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
  readonly session: AgentSqlSession;
  closing: boolean;
  closed: boolean;
  tail: Promise<void>;
  readonly insideScope: AsyncLocalStorage<boolean>;
}

export function createSqliteStoreState(database: SqliteDatabase): SqliteStoreState {
  return {
    database,
    session: sqliteSession(database),
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
  // A store call from inside a companion scope would queue behind the very
  // transaction that is waiting for it — silently, forever. Refuse.
  if (state.insideScope.getStore()) {
    return Promise.reject(
      new Error(
        'SQLite agent-runtime store called from inside its own transaction scope; use the scope it handed you',
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
  work: (transaction: AgentSqlSession) => Promise<RESULT>,
): Promise<RESULT> {
  const database = state.database;
  return serial(state, async () => {
    database.exec(access === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = await work(state.session);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      throw rollbackSqliteFailure(database, error);
    }
  });
}

/** Run `work` marked as inside a store scope, so a store call from it is refused. */
export function enterSqliteScope<RESULT>(
  state: SqliteStoreState,
  work: () => Promise<RESULT>,
): Promise<RESULT> {
  return state.insideScope.run(true, work);
}

export async function closeSqliteStore(state: SqliteStoreState): Promise<void> {
  if (state.closed) return;
  state.closing = true;
  await state.tail;
  state.database.close();
  state.closed = true;
}
