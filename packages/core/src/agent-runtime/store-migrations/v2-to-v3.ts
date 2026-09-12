import type { SqliteDatabase } from '../../internal/sqlite';

/**
 * Durable once-seeding receipts (→ ADR 0178).
 *
 * `seedKey` is the caller's idempotency key and `message_ids` names the
 * messages the seed wrote, so an imported conversation can match them if the
 * receipt itself was not restored. The table is deliberately beside the message
 * history: a receipt must outlive compaction and `clear`, which is exactly when
 * the messages it describes are gone.
 */
export function createAgentRuntimeSqliteV3Tables(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_seeds (
      conversation_id TEXT NOT NULL,
      seed_key TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, seed_key)
    );
  `);
}

/** Transaction body for the v2 → v3 once-seeding migration. */
export function migrateAgentRuntimeSqliteV2ToV3(database: SqliteDatabase): void {
  createAgentRuntimeSqliteV3Tables(database);
  database
    .prepare(
      "UPDATE stitchkit_agent_runtime_meta SET value = '3' WHERE key = 'schema_version'",
    )
    .run();
}
