import type { SqliteDatabase } from './sqlite';
import type { AgentConversationPurgeDriver } from './store-purge';

const OWNED_TABLES = [
  'stitchkit_agent_runtime_messages',
  'stitchkit_agent_runtime_admissions',
  'stitchkit_agent_runtime_runs',
  'stitchkit_agent_runtime_heads',
];

/** Additive v1 feature; install inside the schema initialization transaction. */
export function initializeSqliteConversationPurge(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_purged (
      conversation_id TEXT PRIMARY KEY
    );
  `);
  // Identifiers are library constants, never request data. Triggers also fence writers
  // using older store code on a connection opened before this feature was installed.
  for (const table of OWNED_TABLES) {
    for (const operation of ['INSERT', 'UPDATE']) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_purge_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM stitchkit_agent_runtime_purged WHERE conversation_id = NEW.conversation_id
        )
        BEGIN SELECT RAISE(ABORT, 'Agent conversation has been purged'); END;
      `);
    }
  }
}

/** Uninitialized v1/read-only connections remain readable without claiming purge support. */
export function sqliteConversationPurge(
  database: SqliteDatabase,
): AgentConversationPurgeDriver<SqliteDatabase> | undefined {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stitchkit_agent_runtime_purged'",
    )
    .get();
  if (table === null || table === undefined) return undefined;
  return {
    async isPurged(transaction, conversationId) {
      const row = transaction
        .prepare(
          'SELECT conversation_id FROM stitchkit_agent_runtime_purged WHERE conversation_id = ?',
        )
        .get(conversationId);
      return row !== null && row !== undefined;
    },
    async remove(transaction, conversationId) {
      transaction
        .prepare('INSERT INTO stitchkit_agent_runtime_purged (conversation_id) VALUES (?)')
        .run(conversationId);
      for (const table of OWNED_TABLES) {
        transaction
          .prepare(`DELETE FROM ${table} WHERE conversation_id = ?`)
          .run(conversationId);
      }
    },
  };
}
