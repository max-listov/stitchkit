import { z } from 'zod';
import type { SqliteDatabase } from '../internal/sqlite';
import { initializeSqliteConversationPurge } from './sqlite-purge';
import { missing } from './sqlite-rows';
import {
  createAgentRuntimeSqliteV2Tables,
  migrateAgentRuntimeSqliteV1ToV2,
} from './store-migrations/v1-to-v2';
import {
  createAgentRuntimeSqliteV3Tables,
  migrateAgentRuntimeSqliteV2ToV3,
} from './store-migrations/v2-to-v3';

const MetaRowSchema = z.object({ value: z.string() });
const TableRowSchema = z.object({ name: z.string() });

const SCHEMA_VERSION = 3;
const TABLES = [
  'stitchkit_agent_runtime_heads',
  'stitchkit_agent_runtime_runs',
  'stitchkit_agent_runtime_admissions',
  'stitchkit_agent_runtime_messages',
  'stitchkit_agent_runtime_seeds',
  'stitchkit_agent_runtime_events',
  'stitchkit_agent_runtime_projections',
  'stitchkit_agent_runtime_spills',
  'stitchkit_agent_runtime_schedules',
  'stitchkit_agent_runtime_children',
];

/**
 * Create Stitchkit's schema without claiming an application's tables or SQLite user_version.
 * An orphaned partial Stitchkit schema is refused rather than destructively repaired.
 */
export function initializeAgentRuntimeSqlite(database: SqliteDatabase): void {
  // The table list is read inside the write transaction: read before it, a
  // second process that opened the same file a moment earlier could finish
  // the migration in between, and this one would judge a stale list.
  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'stitchkit_agent_runtime_%' ORDER BY name`,
      )
      .all()
      .map((row) => TableRowSchema.parse(row).name);
    const hasMeta = existing.includes('stitchkit_agent_runtime_meta');
    if (!hasMeta && existing.length > 0) {
      throw new Error('Refusing an unversioned partial Stitchkit agent-runtime SQLite schema');
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const versionRow = database
      .prepare("SELECT value FROM stitchkit_agent_runtime_meta WHERE key = 'schema_version'")
      .get();
    if (!missing(versionRow)) {
      const version = Number(MetaRowSchema.parse(versionRow).value);
      if (version === 1) {
        migrateAgentRuntimeSqliteV1ToV2(database);
        migrateAgentRuntimeSqliteV2ToV3(database);
        initializeSqliteConversationPurge(database);
        database.exec('COMMIT');
        return;
      }
      if (version === 2) {
        migrateAgentRuntimeSqliteV2ToV3(database);
        initializeSqliteConversationPurge(database);
        database.exec('COMMIT');
        return;
      }
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `Unsupported Stitchkit agent-runtime SQLite schema version ${version}; expected ${SCHEMA_VERSION}`,
        );
      }
      const missingTables = TABLES.filter((table) => !existing.includes(table));
      if (missingTables.length > 0) {
        throw new Error(
          `Refusing a partial Stitchkit agent-runtime SQLite schema; missing ${missingTables.join(', ')}`,
        );
      }
      initializeSqliteConversationPurge(database);
      database.exec('COMMIT');
      return;
    }
    if (existing.some((table) => table !== 'stitchkit_agent_runtime_meta')) {
      throw new Error('Refusing an unversioned partial Stitchkit agent-runtime SQLite schema');
    }

    database.exec(`
      CREATE TABLE stitchkit_agent_runtime_heads (
        conversation_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0)
      );
      CREATE TABLE stitchkit_agent_runtime_runs (
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        terminal_assistant_payload TEXT,
        PRIMARY KEY (conversation_id, run_id),
        UNIQUE (conversation_id, assistant_message_id)
      );
      CREATE INDEX stitchkit_agent_runtime_recoverable
        ON stitchkit_agent_runtime_runs (state, conversation_id, run_id);
      CREATE TABLE stitchkit_agent_runtime_admissions (
        conversation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        input_message_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        input_payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, idempotency_key),
        UNIQUE (conversation_id, input_message_id)
      );
      CREATE TABLE stitchkit_agent_runtime_messages (
        conversation_id TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        payload TEXT NOT NULL,
        PRIMARY KEY (conversation_id, id)
      );
    `);
    createAgentRuntimeSqliteV2Tables(database);
    createAgentRuntimeSqliteV3Tables(database);
    database
      .prepare(
        "INSERT INTO stitchkit_agent_runtime_meta (key, value) VALUES ('schema_version', '3')",
      )
      .run();
    initializeSqliteConversationPurge(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
