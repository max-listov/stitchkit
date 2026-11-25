import type { AgentSqlDialect, AgentSqlSession, AgentSqlTables } from './sql-session';
import type { AgentConversationPurgeDriver } from './store-purge';

/** The tables keyed by `conversation_id` that every dialect has, in delete order. */
export function conversationTables(tables: AgentSqlTables): string[] {
  return [
    tables.spills,
    tables.schedules,
    tables.projections,
    tables.events,
    tables.messages,
    tables.seeds,
    tables.admissions,
    tables.runs,
    tables.heads,
  ];
}

/**
 * The purge tombstone and the removal of everything a conversation owns.
 *
 * The removal covers the companions too — spills, schedules, projections and
 * the child links in both directions — because a purge that left them would
 * leave data the operator was told is gone.
 */
export function sqlConversationPurge(
  dialect: AgentSqlDialect,
): AgentConversationPurgeDriver<AgentSqlSession> {
  const t = dialect.tables;
  return {
    async isEmpty(transaction, conversationId) {
      for (const table of dialect.conversationTables) {
        const row = await transaction.get(
          `SELECT 1 AS found FROM ${table} WHERE conversation_id = ? LIMIT 1`,
          [conversationId],
        );
        if (row !== undefined) return false;
      }
      return (
        (await transaction.get(
          `SELECT 1 AS found FROM ${t.children}
           WHERE parent_conversation_id = ? OR child_conversation_id = ? LIMIT 1`,
          [conversationId, conversationId],
        )) === undefined
      );
    },
    async isPurged(transaction, conversationId) {
      return (
        (await transaction.get(
          `SELECT conversation_id FROM ${t.purged} WHERE conversation_id = ?`,
          [conversationId],
        )) !== undefined
      );
    },
    async remove(transaction, conversationId) {
      await transaction.run(`INSERT INTO ${t.purged} (conversation_id) VALUES (?)`, [
        conversationId,
      ]);
      for (const table of dialect.conversationTables) {
        await transaction.run(`DELETE FROM ${table} WHERE conversation_id = ?`, [
          conversationId,
        ]);
      }
      await transaction.run(
        `DELETE FROM ${t.children} WHERE parent_conversation_id = ? OR child_conversation_id = ?`,
        [conversationId, conversationId],
      );
    },
  };
}
