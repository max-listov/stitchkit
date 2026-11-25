import type { SqliteDatabase } from '../internal/sqlite';
import { conversationTables } from './sql-purge';
import { agentSqlTables } from './sql-session';

const TABLES = agentSqlTables('stitchkit_agent_runtime');

/** Additive v1 feature; install inside the schema initialization transaction. */
export function initializeSqliteConversationPurge(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLES.purged} (
      conversation_id TEXT PRIMARY KEY
    );
  `);
  // Identifiers are library constants, never request data. Triggers also fence writers
  // using older store code on a connection opened before this feature was installed.
  for (const table of conversationTables(TABLES)) {
    for (const operation of ['INSERT', 'UPDATE']) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_purge_${operation.toLowerCase()}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM ${TABLES.purged} WHERE conversation_id = NEW.conversation_id
        )
        BEGIN SELECT RAISE(ABORT, 'Agent conversation has been purged'); END;
      `);
    }
  }
}

/** Uninitialized v1/read-only connections remain readable without claiming purge support. */
export function sqlitePurgeInstalled(database: SqliteDatabase): boolean {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(TABLES.purged);
  return table !== null && table !== undefined;
}
