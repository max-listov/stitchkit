import {
  type AgentStoreEventEnvelope,
  type AppendAgentStoreEvent,
  AppendAgentStoreEventSchema,
} from '../durability/events';
import { AgentConversationPurgedError } from './purge';
import type { SqlStoreDriver } from './sql-rows';
import type { AgentSqlDialect, AgentSqlSession, AgentSqlTables } from './sql-session';
import { appendEventIn } from './store-reads';

/** What a companion may do inside one store transaction: statements, and events beside them. */
export interface AgentCompanionScope extends AgentSqlSession {
  appendEvent(input: AppendAgentStoreEvent): Promise<AgentStoreEventEnvelope>;
}

/**
 * Where the runtime's companions keep their rows: the store's own database,
 * in the store's own transactions.
 *
 * Schedules, children, spills and projections each write a row and an event
 * that must commit together, and must never land in a conversation a purge
 * has removed. The host gives them exactly that — one write transaction of
 * the store, opened after the purge tombstone is checked, with the store's
 * event append inside it — and a read transaction for everything else. Both
 * SQL stores hand one out, so a companion is written once, with `?`
 * placeholders, and runs on SQLite and on Postgres alike.
 *
 * `transaction` may run `work` more than once: the Postgres store retries a
 * serialization conflict by running the whole transaction again. Work keeps
 * its effects inside the scope until it returns.
 */
export interface AgentCompanionHost {
  /** Which SQL the statements run on; a companion that needs one database's feature checks it. */
  readonly dialect: AgentSqlDialect['name'];
  /** The companion tables of this store, by role. */
  readonly tables: AgentSqlTables;
  transaction<RESULT>(
    conversationId: string,
    work: (scope: AgentCompanionScope) => Promise<RESULT>,
  ): Promise<RESULT>;
  read<RESULT>(work: (session: AgentSqlSession) => Promise<RESULT>): Promise<RESULT>;
}

export function createCompanionHost(input: {
  dialect: AgentSqlDialect;
  driver: SqlStoreDriver;
  /** Marks the scope, so a store call made from inside it can be refused rather than deadlock. */
  enterScope?: <RESULT>(work: () => Promise<RESULT>) => Promise<RESULT>;
}): AgentCompanionHost {
  const { dialect, driver } = input;
  const enterScope = input.enterScope ?? ((work) => work());
  return {
    dialect: dialect.name,
    tables: dialect.tables,
    transaction: (conversationId, work) =>
      driver.transaction(
        (session) =>
          enterScope(async () => {
            const purged = await session.get(
              `SELECT conversation_id FROM ${dialect.tables.purged} WHERE conversation_id = ?`,
              [conversationId],
            );
            if (purged !== undefined) throw new AgentConversationPurgedError();
            return work({
              all: session.all,
              get: session.get,
              run: session.run,
              appendEvent: (event) =>
                appendEventIn(driver, session, AppendAgentStoreEventSchema.parse(event)),
            });
          }),
        { access: 'write' },
      ),
    read: (work) =>
      driver.transaction((session) => enterScope(() => work(session)), {
        access: 'read',
      }),
  };
}
