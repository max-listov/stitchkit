import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDatabase } from '../../internal/sqlite';
import { AgentMessageSchema, AgentRunSchema } from '../schemas';
import { canonicalAgentJson } from '../store-events';

const ConversationRowSchema = z.object({
  conversation_id: z.string().min(1),
  version: z.int().nonnegative(),
});
const PayloadRowSchema = z.object({
  payload: z.string(),
  terminal_assistant_payload: z.string().nullable().optional(),
});
const AdmissionRowSchema = z.object({
  conversation_id: z.string(),
  idempotency_key: z.string(),
  input_payload: z.string(),
  run_id: z.string(),
  assistant_message_id: z.string(),
});

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function createDurableTables(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      event_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0),
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      ignorable INTEGER NOT NULL DEFAULT 0 CHECK (ignorable IN (0, 1)),
      payload TEXT NOT NULL,
      UNIQUE (conversation_id, seq)
    );
    CREATE INDEX IF NOT EXISTS stitchkit_agent_runtime_events_time
      ON stitchkit_agent_runtime_events (conversation_id, occurred_at, seq);
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_projections (
      conversation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      upto_seq INTEGER NOT NULL CHECK (upto_seq >= 0),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, name)
    );
    CREATE INDEX IF NOT EXISTS stitchkit_agent_runtime_projection_updates
      ON stitchkit_agent_runtime_projections (name, updated_at, conversation_id);
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_spills (
      reference_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT,
      tool_call_id TEXT,
      media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL CHECK (bytes >= 0),
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      authorization_payload TEXT,
      payload BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stitchkit_agent_runtime_spills_owner
      ON stitchkit_agent_runtime_spills (conversation_id, created_at);
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_schedules (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      next_at TEXT NOT NULL,
      interval_ms INTEGER,
      time_zone TEXT,
      input_payload TEXT NOT NULL,
      state TEXT NOT NULL,
      occurrence INTEGER NOT NULL DEFAULT 0 CHECK (occurrence >= 0),
      claim_owner TEXT,
      claim_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stitchkit_agent_runtime_schedules_due
      ON stitchkit_agent_runtime_schedules (state, next_at);
    CREATE TABLE IF NOT EXISTS stitchkit_agent_runtime_children (
      parent_conversation_id TEXT NOT NULL,
      child_conversation_id TEXT NOT NULL UNIQUE,
      seed_upto_seq INTEGER,
      state TEXT NOT NULL,
      budget_payload TEXT NOT NULL,
      usage_payload TEXT NOT NULL,
      result_reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (parent_conversation_id, child_conversation_id)
    );
  `);
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS stitchkit_agent_runtime_events_fts
      USING fts5(
        conversation_id UNINDEXED,
        event_seq UNINDEXED,
        occurred_at UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS stitchkit_agent_runtime_events_fts_insert
      AFTER INSERT ON stitchkit_agent_runtime_events BEGIN
        INSERT INTO stitchkit_agent_runtime_events_fts(
          rowid, conversation_id, event_seq, occurred_at, body
        ) VALUES (new.row_id, new.conversation_id, new.seq, new.occurred_at, new.payload);
      END;
      CREATE TRIGGER IF NOT EXISTS stitchkit_agent_runtime_events_fts_delete
      AFTER DELETE ON stitchkit_agent_runtime_events BEGIN
        DELETE FROM stitchkit_agent_runtime_events_fts WHERE rowid = old.row_id;
      END;
    `);
  } catch (error) {
    throw new Error('SQLite agent-runtime requires FTS5 support', { cause: error });
  }
}

function writeBaselines(database: SqliteDatabase, migratedAt: string): void {
  const conversations = database
    .prepare(
      'SELECT conversation_id, version FROM stitchkit_agent_runtime_heads ORDER BY conversation_id',
    )
    .all()
    .map((row) => ConversationRowSchema.parse(row));
  const insert = database.prepare(`
    INSERT INTO stitchkit_agent_runtime_events (
      conversation_id, seq, event_id, schema_version, kind, occurred_at, ignorable, payload
    ) VALUES (?, 1, ?, 1, 'runtime/baseline', ?, 0, ?)
  `);
  for (const conversation of conversations) {
    const messages = database
      .prepare(
        'SELECT payload FROM stitchkit_agent_runtime_messages WHERE conversation_id = ? AND active = 1 ORDER BY position',
      )
      .all(conversation.conversation_id)
      .map((row) => AgentMessageSchema.parse(parseJson(PayloadRowSchema.parse(row).payload)));
    const runs = database
      .prepare(
        'SELECT payload, terminal_assistant_payload FROM stitchkit_agent_runtime_runs WHERE conversation_id = ? ORDER BY created_at, run_id',
      )
      .all(conversation.conversation_id)
      .map((value) => {
        const row = PayloadRowSchema.parse(value);
        return {
          schemaVersion: 1,
          run: AgentRunSchema.parse(parseJson(row.payload)),
          ...(row.terminal_assistant_payload
            ? {
                terminalAssistant: AgentMessageSchema.parse(
                  parseJson(row.terminal_assistant_payload),
                ),
              }
            : {}),
        };
      });
    const admissions = database
      .prepare(
        'SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id FROM stitchkit_agent_runtime_admissions WHERE conversation_id = ? ORDER BY idempotency_key',
      )
      .all(conversation.conversation_id)
      .map((value) => {
        const row = AdmissionRowSchema.parse(value);
        return {
          schemaVersion: 1,
          conversationId: row.conversation_id,
          idempotencyKey: row.idempotency_key,
          input: AgentMessageSchema.parse(parseJson(row.input_payload)),
          runId: row.run_id,
          assistantMessageId: row.assistant_message_id,
        };
      });
    // The baseline happens now, at migration time — that is its `occurred_at`.
    // What it *describes* is the conversation as of its last known message or
    // run, and that goes inside the payload as `asOf`; absent when the
    // conversation had neither, rather than the epoch standing in for a time.
    const asOf = messages.at(-1)?.createdAt ?? runs.at(-1)?.run.createdAt;
    insert.run(
      conversation.conversation_id,
      randomUUID(),
      migratedAt,
      canonicalAgentJson({
        migratedAt,
        ...(asOf !== undefined && { asOf }),
        head: {
          schemaVersion: 1,
          conversationId: conversation.conversation_id,
          version: conversation.version,
        },
        messages,
        runs,
        admissions,
      }),
    );
  }
}

/** Transaction body for the single v1 → v2 durable-capabilities migration. */
export function migrateAgentRuntimeSqliteV1ToV2(
  database: SqliteDatabase,
  migratedAt: string = new Date().toISOString(),
): void {
  createDurableTables(database);
  writeBaselines(database, migratedAt);
  database
    .prepare(
      "UPDATE stitchkit_agent_runtime_meta SET value = '2' WHERE key = 'schema_version'",
    )
    .run();
}

/** Create the complete current schema in a fresh database. */
export function createAgentRuntimeSqliteV2Tables(database: SqliteDatabase): void {
  createDurableTables(database);
}
