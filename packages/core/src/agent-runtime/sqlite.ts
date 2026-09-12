import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDatabase, SqliteValue } from '../internal/sqlite';
import {
  AgentConversationMessagePageSchema,
  AgentConversationPageSchema,
  type AgentConversationReader,
} from './conversations';
import { AgentConversationPurgedError } from './purge';
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import { initializeSqliteConversationPurge, sqliteConversationPurge } from './sqlite-purge';
import { AgentRecoverableDescriptorSchema, AgentRecoverablePageSchema } from './store';
import {
  AgentAdmissionReceiptSchema,
  AgentHistoryMutationSchema,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentSeedReceiptSchema,
  AgentStoredRunSchema,
  createAgentRuntimeStore,
} from './store-driver';
import {
  type AgentStoreEventDraft,
  type AgentStoreEventEnvelope,
  AgentStoreEventEnvelopeSchema,
  AgentStoreEventPageSchema,
  type AppendAgentStoreEvent,
  AppendAgentStoreEventSchema,
  agentStoreEventDraft,
} from './store-events';
import {
  createAgentRuntimeSqliteV2Tables,
  migrateAgentRuntimeSqliteV1ToV2,
} from './store-migrations/v1-to-v2';
import {
  createAgentRuntimeSqliteV3Tables,
  migrateAgentRuntimeSqliteV2ToV3,
} from './store-migrations/v2-to-v3';

export type { SqliteDatabase, SqliteStatement, SqliteValue } from '../internal/sqlite';

export interface SqliteAgentRuntimeStoreConfig {
  database: SqliteDatabase;
  /** Create or validate Stitchkit's namespaced schema. Default true. */
  initialize?: boolean;
}

export interface SqliteAgentRuntimeStore {
  store: ReturnType<typeof createAgentRuntimeStore<SqliteDatabase>>;
  conversations: AgentConversationReader;
  /**
   * The connection the store owns — for the SQLite-bound companions
   * (`createSqliteAgentProjectionStore`, `createSqliteAgentEventSearch`,
   * `createSqliteAgentSpillStore`, `createSqliteAgentChildManager`,
   * `createAgentScheduleService`), which share it rather than open a second.
   * Without this a consumer following the guide had to copy the adapter out
   * of the package source to reach any of them.
   */
  database: SqliteDatabase;
  /**
   * One write transaction shared with the store's own serialization.
   *
   * The companions that keep rows beside the ledger — spills, schedules,
   * children, projections — write their row and append their event here, in
   * the same transaction the store's operations queue behind. A bare write on
   * the shared connection used to land inside whatever store transaction was
   * open at that moment: a conflict's ROLLBACK took the row with it while the
   * event, queued separately, was still written.
   */
  transaction<RESULT>(
    work: (scope: SqliteStoreTransaction) => Promise<RESULT>,
  ): Promise<RESULT>;
  /** Refuse new work, wait for queued operations, then close the owned connection. */
  close(): Promise<void>;
}

/** What a companion may do inside one store transaction. */
export interface SqliteStoreTransaction {
  database: SqliteDatabase;
  appendEvent(input: AppendAgentStoreEvent): Promise<AgentStoreEventEnvelope>;
}

const HeadRowSchema = z.object({ version: z.number().int().nonnegative() });
const RunRowSchema = z.object({
  payload: z.string(),
  terminal_assistant_payload: z.string().nullable(),
});
const AdmissionRowSchema = z.object({
  conversation_id: z.string(),
  idempotency_key: z.string(),
  input_payload: z.string(),
  run_id: z.string(),
  assistant_message_id: z.string(),
});
const SeedRowSchema = z.object({
  conversation_id: z.string(),
  seed_key: z.string(),
  message_ids: z.string(),
});
const MessageRowSchema = z.object({ payload: z.string() });
const PositionedMessageRowSchema = z.object({ position: z.number().int().nonnegative() });
const RecoverableRowSchema = z.object({
  conversation_id: z.string(),
  run_id: z.string(),
  payload: z.string(),
});
const MetaRowSchema = z.object({ value: z.string() });
const TableRowSchema = z.object({ name: z.string() });
const ConversationHeadRowSchema = z.object({
  conversation_id: z.string(),
  version: z.number().int().nonnegative(),
});
const CountRowSchema = z.object({ count: z.number().int().nonnegative() });
const MessagePageRowSchema = z.object({
  row_id: z.number().int().positive(),
  position: z.number().int().nonnegative(),
  active: z.union([z.literal(0), z.literal(1)]),
  payload: z.string(),
});
const EventRowSchema = z.object({
  event_id: z.string(),
  conversation_id: z.string(),
  seq: z.int().positive(),
  schema_version: z.int().positive(),
  kind: z.string(),
  occurred_at: z.string(),
  ignorable: z.union([z.literal(0), z.literal(1)]),
  payload: z.string(),
});
const ArchiveProjectionRowSchema = z.object({
  name: z.string(),
  version: z.int().positive(),
  upto_seq: z.int().nonnegative(),
  payload: z.string(),
  updated_at: z.string(),
});
const ArchiveSpillRowSchema = z.object({
  reference_id: z.string(),
  run_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  media_type: z.string(),
  bytes: z.int().nonnegative(),
  sha256: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  authorization_payload: z.string().nullable(),
  payload: z.instanceof(Uint8Array),
});

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

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

function missing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function parseRunRow(value: unknown) {
  const row = RunRowSchema.parse(value);
  return AgentStoredRunSchema.parse({
    schemaVersion: 1,
    run: AgentRunSchema.parse(parseJson(row.payload)),
    ...(row.terminal_assistant_payload === null
      ? {}
      : {
          terminalAssistant: AgentMessageSchema.parse(
            parseJson(row.terminal_assistant_payload),
          ),
        }),
  });
}

function parseEventRow(value: unknown) {
  const row = EventRowSchema.parse(value);
  return AgentStoreEventEnvelopeSchema.parse({
    schemaVersion: row.schema_version,
    eventId: row.event_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    kind: row.kind,
    occurredAt: row.occurred_at,
    payload: parseJson(row.payload),
    ...(row.ignorable === 1 && { ignorable: true }),
  });
}

function recoveryCursor(conversationId: string, runId: string): string {
  return encodeJson([conversationId, runId]);
}

function parseRecoveryCursor(cursor: string): readonly [string, string] {
  return z.tuple([z.string().min(1), z.string().min(1)]).parse(parseJson(cursor));
}

function conversationCursor(conversationId: string): string {
  return encodeJson([conversationId]);
}

function parseConversationCursor(cursor: string): string {
  return z.tuple([z.string().min(1)]).parse(parseJson(cursor))[0];
}

/**
 * Position, then the row's own identity.
 *
 * Position alone stopped being unique the moment a page could contain
 * compacted messages: a compaction summary is written at the position of the
 * first message it replaced, and a later compaction of that summary adds a
 * third row there. Ordering and paging on the pair keeps the sequence stable
 * and a boundary exact. A cursor from an earlier version carries the position
 * only and still means what it meant — everything past that position.
 */
function messageCursor(position: number, rowId: number): string {
  return encodeJson([position, rowId]);
}

function parseMessageCursor(cursor: string): { position: number; rowId?: number } {
  const parsed = z
    .union([
      z.tuple([z.int().nonnegative(), z.int().positive()]),
      z.tuple([z.int().nonnegative()]),
    ])
    .parse(parseJson(cursor));
  const [position, rowId] = parsed;
  return { position, ...(rowId !== undefined && { rowId }) };
}

function messagePreview(message: z.infer<typeof AgentMessageSchema>): string {
  const text = message.parts.find((part) => part.type === 'text');
  return text?.type === 'text' ? text.text.slice(0, 160) : message.role;
}

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

export function createSqliteAgentRuntimeStore(
  config: SqliteAgentRuntimeStoreConfig,
): SqliteAgentRuntimeStore {
  const database = config.database;
  if (config.initialize !== false) {
    try {
      initializeAgentRuntimeSqlite(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }
  let closing = false;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const insideScope = new AsyncLocalStorage<boolean>();

  const serial = <RESULT>(work: () => Promise<RESULT>): Promise<RESULT> => {
    if (closing || closed) {
      return Promise.reject(new Error('SQLite agent-runtime store is closing'));
    }
    // A store call from inside a `transaction` scope would queue behind the
    // very transaction that is waiting for it — silently, forever. Refuse.
    if (insideScope.getStore()) {
      return Promise.reject(
        new Error(
          'SQLite agent-runtime store called from inside its own transaction scope; use scope.database and scope.appendEvent',
        ),
      );
    }
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const runTransaction = <RESULT>(
    access: 'read' | 'write',
    work: (transaction: SqliteDatabase) => Promise<RESULT>,
  ): Promise<RESULT> =>
    serial(async () => {
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

  const driver: AgentRuntimeStoreDriver<SqliteDatabase> = {
    conversations: sqliteConversationPurge(database),
    transaction: (work, options) => runTransaction(options?.access ?? 'write', work),
    head: {
      async load(transaction, conversationId) {
        const value = transaction
          .prepare(
            'SELECT version FROM stitchkit_agent_runtime_heads WHERE conversation_id = ?',
          )
          .get(conversationId);
        if (missing(value)) return undefined;
        const row = HeadRowSchema.parse(value);
        return AgentRuntimeHeadSchema.parse({
          schemaVersion: 1,
          conversationId,
          version: row.version,
        });
      },
      /**
       * Read, compare, then write — rather than a conditional upsert whose
       * outcome is read back from `changes`.
       *
       * `changes` cannot carry that decision here. This boundary is satisfied
       * structurally by a raw driver handle (ADR 0142), and `bun:sqlite`
       * reports a count that also includes what the event table's AFTER INSERT
       * trigger and FTS5's deferred index flush wrote during the same
       * statement: a head upsert that moved exactly one row reported five, and
       * `changes === 1` read that as a conflict. `importConversation` refused
       * every conversation that had a run, into a target it had just found
       * empty.
       *
       * The conditional upsert was also silently not a compare-and-swap on the
       * insert path: `ON CONFLICT ... WHERE` guards the update branch only, so
       * a first write applied whatever `expectedVersion` it was given.
       *
       * Safe as two statements because every caller is inside the store's
       * `BEGIN IMMEDIATE` transaction, which no second writer — in this
       * process or another — can interleave with.
       */
      async compareAndSwap(transaction, input) {
        const current = transaction
          .prepare(
            'SELECT version FROM stitchkit_agent_runtime_heads WHERE conversation_id = ?',
          )
          .get(input.conversationId);
        const actualVersion = missing(current) ? 0 : HeadRowSchema.parse(current).version;
        if (actualVersion !== input.expectedVersion)
          return { outcome: 'conflict', actualVersion };
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_heads (conversation_id, version)
            VALUES (?, ?)
            ON CONFLICT (conversation_id) DO UPDATE SET version = excluded.version
          `)
          .run(input.conversationId, input.next.version);
        return { outcome: 'applied' };
      },
    },
    runs: {
      async load(transaction, input) {
        const row = transaction
          .prepare(`
            SELECT payload, terminal_assistant_payload
            FROM stitchkit_agent_runtime_runs
            WHERE conversation_id = ? AND run_id = ?
          `)
          .get(input.conversationId, input.runId);
        return missing(row) ? undefined : parseRunRow(row);
      },
      async loadByAssistantMessageId(transaction, input) {
        const row = transaction
          .prepare(`
            SELECT payload, terminal_assistant_payload
            FROM stitchkit_agent_runtime_runs
            WHERE conversation_id = ? AND assistant_message_id = ?
          `)
          .get(input.conversationId, input.assistantMessageId);
        return missing(row) ? undefined : parseRunRow(row);
      },
      async loadMany(transaction, input) {
        if (input.runIds.length === 0) return [];
        return transaction
          .prepare(`
            SELECT payload, terminal_assistant_payload
            FROM stitchkit_agent_runtime_runs
            WHERE conversation_id = ? AND run_id IN (${placeholders(input.runIds.length)})
          `)
          .all(input.conversationId, ...input.runIds)
          .map(parseRunRow);
      },
      async listActive(transaction, conversationId) {
        return transaction
          .prepare(`
            SELECT payload, terminal_assistant_payload
            FROM stitchkit_agent_runtime_runs
            WHERE conversation_id = ? AND state IN ('queued', 'running', 'interrupt_requested')
          `)
          .all(conversationId)
          .map(parseRunRow);
      },
      async save(transaction, rawRecord) {
        const record = AgentStoredRunSchema.parse(rawRecord);
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_runs (
              conversation_id, run_id, assistant_message_id, state, created_at, payload,
              terminal_assistant_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (conversation_id, run_id) DO UPDATE SET
              assistant_message_id = excluded.assistant_message_id,
              state = excluded.state,
              created_at = excluded.created_at,
              payload = excluded.payload,
              terminal_assistant_payload = excluded.terminal_assistant_payload
          `)
          .run(
            record.run.conversationId,
            record.run.id,
            record.run.assistantMessageId,
            record.run.state,
            record.run.createdAt,
            encodeJson(record.run),
            record.terminalAssistant ? encodeJson(record.terminalAssistant) : null,
          );
      },
    },
    admissions: {
      async load(transaction, input) {
        const value = transaction
          .prepare(`
            SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
            FROM stitchkit_agent_runtime_admissions
            WHERE conversation_id = ? AND idempotency_key = ?
          `)
          .get(input.conversationId, input.idempotencyKey);
        if (missing(value)) return undefined;
        const row = AdmissionRowSchema.parse(value);
        return AgentAdmissionReceiptSchema.parse({
          schemaVersion: 1,
          conversationId: row.conversation_id,
          idempotencyKey: row.idempotency_key,
          input: AgentMessageSchema.parse(parseJson(row.input_payload)),
          runId: row.run_id,
          assistantMessageId: row.assistant_message_id,
        });
      },
      async loadByInputMessageId(transaction, input) {
        const value = transaction
          .prepare(`
            SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
            FROM stitchkit_agent_runtime_admissions
            WHERE conversation_id = ? AND input_message_id = ?
          `)
          .get(input.conversationId, input.inputMessageId);
        if (missing(value)) return undefined;
        const row = AdmissionRowSchema.parse(value);
        return AgentAdmissionReceiptSchema.parse({
          schemaVersion: 1,
          conversationId: row.conversation_id,
          idempotencyKey: row.idempotency_key,
          input: AgentMessageSchema.parse(parseJson(row.input_payload)),
          runId: row.run_id,
          assistantMessageId: row.assistant_message_id,
        });
      },
      async create(transaction, rawReceipt) {
        const receipt = AgentAdmissionReceiptSchema.parse(rawReceipt);
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_admissions (
              conversation_id, idempotency_key, input_message_id, run_id,
              assistant_message_id, input_payload
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            receipt.conversationId,
            receipt.idempotencyKey,
            receipt.input.id,
            receipt.runId,
            receipt.assistantMessageId,
            encodeJson(receipt.input),
          );
      },
    },
    seeds: {
      async load(transaction, input) {
        const value = transaction
          .prepare(`
            SELECT conversation_id, seed_key, message_ids
            FROM stitchkit_agent_runtime_seeds
            WHERE conversation_id = ? AND seed_key = ?
          `)
          .get(input.conversationId, input.seedKey);
        if (missing(value)) return undefined;
        const row = SeedRowSchema.parse(value);
        return AgentSeedReceiptSchema.parse({
          schemaVersion: 1,
          conversationId: row.conversation_id,
          seedKey: row.seed_key,
          messageIds: z.array(z.string().min(1)).parse(parseJson(row.message_ids)),
        });
      },
      async create(transaction, rawReceipt) {
        const receipt = AgentSeedReceiptSchema.parse(rawReceipt);
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_seeds (
              conversation_id, seed_key, message_ids, created_at
            ) VALUES (?, ?, ?, ?)
          `)
          .run(
            receipt.conversationId,
            receipt.seedKey,
            encodeJson(receipt.messageIds),
            new Date().toISOString(),
          );
      },
    },
    history: {
      async load(transaction, conversationId) {
        return transaction
          .prepare(`
            SELECT payload FROM stitchkit_agent_runtime_messages
            WHERE conversation_id = ? AND active = 1 ORDER BY position ASC
          `)
          .all(conversationId)
          .map((value) =>
            AgentMessageSchema.parse(parseJson(MessageRowSchema.parse(value).payload)),
          );
      },
      async hasMessage(transaction, input) {
        // Deliberately ignores `active`: a compacted seed still occupies its
        // `(conversation_id, id)` row, and the seed write is idempotent against
        // it whether or not the active view shows it.
        const row = transaction
          .prepare(`
            SELECT count(*) AS count FROM stitchkit_agent_runtime_messages
            WHERE conversation_id = ? AND id = ?
          `)
          .get(input.conversationId, input.messageId);
        return CountRowSchema.parse(row).count > 0;
      },
      async apply(transaction, rawMutation) {
        const mutation = AgentHistoryMutationSchema.parse(rawMutation);
        const message =
          mutation.type === 'admit'
            ? mutation.input
            : mutation.type === 'upsert-assistant'
              ? mutation.message
              : mutation.type === 'seed'
                ? mutation.message
                : mutation.summary;
        if (mutation.type === 'seed') {
          // Prepended, so user instructions lead the conversation they seed.
          // The reducer emits these front-most-first, so each prepend lands
          // ahead of the previous one and the persisted order matches.
          transaction
            .prepare(`
              UPDATE stitchkit_agent_runtime_messages SET position = position + 1
              WHERE conversation_id = ?
            `)
            .run(mutation.message.conversationId);
          transaction
            .prepare(`
              INSERT INTO stitchkit_agent_runtime_messages
                (conversation_id, id, position, active, payload)
              VALUES (?, ?, 0, 1, ?)
              ON CONFLICT (conversation_id, id) DO UPDATE SET
                position = excluded.position,
                active = excluded.active,
                payload = excluded.payload
            `)
            .run(
              mutation.message.conversationId,
              mutation.message.id,
              encodeJson(mutation.message),
            );
          return;
        }
        if (mutation.type === 'replace-compacted-range') {
          const parameters = mutation.replacedMessageIds;
          const rows = transaction
            .prepare(`
              SELECT position FROM stitchkit_agent_runtime_messages
              WHERE conversation_id = ? AND active = 1
                AND id IN (${placeholders(parameters.length)})
              ORDER BY position ASC
            `)
            .all(message.conversationId, ...parameters)
            .map((row) => PositionedMessageRowSchema.parse(row));
          // The summary takes the position of the LAST message it replaces, not
          // the first.
          //
          // Both put it in the same place in the model's history — every
          // replaced row is inactive, so nothing active sits between them —
          // and the two differ only once a reader asks for the compacted
          // messages too. Anchored at the first, the summary landed between
          // the message it summarizes and the rest of the block: a person read
          // one message, then a retelling of the next ten, then those ten.
          // Anchored at the last, the block reads through and the summary
          // arrives after it, where it was written.
          const anchor = rows.at(-1);
          if (!anchor || rows.length !== parameters.length) {
            throw new Error('Compaction range changed inside the transaction');
          }
          transaction
            .prepare(`
              UPDATE stitchkit_agent_runtime_messages SET active = 0
              WHERE conversation_id = ? AND id IN (${placeholders(parameters.length)})
            `)
            .run(message.conversationId, ...parameters);
          transaction
            .prepare(`
              INSERT INTO stitchkit_agent_runtime_messages
                (conversation_id, id, position, active, payload)
              VALUES (?, ?, ?, 1, ?)
            `)
            .run(message.conversationId, message.id, anchor.position, encodeJson(message));
          return;
        }
        const existing = transaction
          .prepare(`
            SELECT position FROM stitchkit_agent_runtime_messages
            WHERE conversation_id = ? AND id = ?
          `)
          .get(message.conversationId, message.id);
        if (!missing(existing)) {
          transaction
            .prepare(`
              UPDATE stitchkit_agent_runtime_messages SET payload = ?, active = 1
              WHERE conversation_id = ? AND id = ?
            `)
            .run(encodeJson(message), message.conversationId, message.id);
          return;
        }
        const last = transaction
          .prepare(`
            SELECT position FROM stitchkit_agent_runtime_messages
            WHERE conversation_id = ? ORDER BY position DESC LIMIT 1
          `)
          .get(message.conversationId);
        const position = missing(last)
          ? 0
          : PositionedMessageRowSchema.parse(last).position + 1;
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_messages
              (conversation_id, id, position, active, payload)
            VALUES (?, ?, ?, 1, ?)
          `)
          .run(message.conversationId, message.id, position, encodeJson(message));
      },
    },
    events: {
      async append(transaction, rawEvent) {
        const event: AgentStoreEventDraft = rawEvent;
        const last = transaction
          .prepare(
            'SELECT COALESCE(MAX(seq), 0) AS count FROM stitchkit_agent_runtime_events WHERE conversation_id = ?',
          )
          .get(event.conversationId);
        const seq = CountRowSchema.parse(last).count + 1;
        transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_events (
              conversation_id, seq, event_id, schema_version, kind, occurred_at, ignorable, payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            event.conversationId,
            seq,
            event.eventId,
            event.schemaVersion,
            event.kind,
            event.occurredAt,
            event.ignorable ? 1 : 0,
            encodeJson(event.payload),
          );
        return AgentStoreEventEnvelopeSchema.parse({ ...event, seq });
      },
      async list(transaction, input) {
        const clauses = ['conversation_id = ?'];
        const values: SqliteValue[] = [input.conversationId];
        if (input.fromSeq !== undefined) {
          clauses.push('seq >= ?');
          values.push(input.fromSeq);
        }
        if (input.toSeq !== undefined) {
          clauses.push('seq <= ?');
          values.push(input.toSeq);
        }
        const rows = transaction
          .prepare(`
            SELECT event_id, conversation_id, seq, schema_version, kind, occurred_at,
              ignorable, payload
            FROM stitchkit_agent_runtime_events
            WHERE ${clauses.join(' AND ')}
            ORDER BY seq ASC LIMIT ?
          `)
          .all(...values, input.limit + 1)
          .map(parseEventRow);
        const hasMore = rows.length > input.limit;
        const items = rows.slice(0, input.limit);
        const lastEvent = items.at(-1);
        return AgentStoreEventPageSchema.parse({
          items,
          ...(hasMore && lastEvent ? { nextSeq: lastEvent.seq + 1 } : {}),
        });
      },
    },
    archive: {
      async export(transaction, conversationId) {
        const projections = transaction
          .prepare(`
            SELECT name, version, upto_seq, payload, updated_at
            FROM stitchkit_agent_runtime_projections
            WHERE conversation_id = ? ORDER BY name
          `)
          .all(conversationId)
          .map((raw) => {
            const row = ArchiveProjectionRowSchema.parse(raw);
            return {
              name: row.name,
              version: row.version,
              uptoSeq: row.upto_seq,
              value: z.json().parse(parseJson(row.payload)),
              updatedAt: row.updated_at,
            };
          });
        const spills = transaction
          .prepare(`
            SELECT reference_id, run_id, tool_call_id, media_type, bytes, sha256,
              created_at, expires_at, authorization_payload, payload
            FROM stitchkit_agent_runtime_spills
            WHERE conversation_id = ? ORDER BY created_at, reference_id
          `)
          .all(conversationId)
          .map((raw) => {
            const row = ArchiveSpillRowSchema.parse(raw);
            return {
              reference: row.reference_id,
              ...(row.run_id && { runId: row.run_id }),
              ...(row.tool_call_id && { toolCallId: row.tool_call_id }),
              mediaType: row.media_type,
              bytes: row.bytes,
              sha256: row.sha256,
              createdAt: row.created_at,
              ...(row.expires_at && { expiresAt: row.expires_at }),
              ...(row.authorization_payload && {
                authorization: z.json().parse(parseJson(row.authorization_payload)),
              }),
              base64: Buffer.from(row.payload).toString('base64'),
            };
          });
        return { projections, spills };
      },
      async import(transaction, archive) {
        for (const raw of archive.projections) {
          if (
            typeof raw === 'object' &&
            raw !== null &&
            !Array.isArray(raw) &&
            raw.archiveType === 'runtime-snapshot'
          ) {
            continue;
          }
          const projection = z
            .object({
              name: z.string(),
              version: z.int().positive(),
              uptoSeq: z.int().nonnegative(),
              value: z.json(),
              updatedAt: z.string(),
            })
            .strict()
            .parse(raw);
          transaction
            .prepare(`
              INSERT INTO stitchkit_agent_runtime_projections
                (conversation_id, name, version, upto_seq, payload, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `)
            .run(
              archive.conversationId,
              projection.name,
              projection.version,
              projection.uptoSeq,
              encodeJson(projection.value),
              projection.updatedAt,
            );
        }
        for (const raw of archive.spills) {
          const spill = z
            .object({
              reference: z.string(),
              runId: z.string().optional(),
              toolCallId: z.string().optional(),
              mediaType: z.string(),
              bytes: z.int().nonnegative(),
              sha256: z.string(),
              createdAt: z.string(),
              expiresAt: z.string().optional(),
              authorization: z.json().optional(),
              base64: z.string(),
            })
            .strict()
            .parse(raw);
          const payload = Buffer.from(spill.base64, 'base64');
          if (payload.byteLength !== spill.bytes) {
            throw new TypeError('Conversation archive spill byte count is inconsistent');
          }
          if (createHash('sha256').update(payload).digest('hex') !== spill.sha256) {
            throw new TypeError('Conversation archive spill digest is inconsistent');
          }
          transaction
            .prepare(`
              INSERT INTO stitchkit_agent_runtime_spills (
                reference_id, conversation_id, run_id, tool_call_id, media_type,
                bytes, sha256, created_at, expires_at, authorization_payload, payload
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              spill.reference,
              archive.conversationId,
              spill.runId ?? null,
              spill.toolCallId ?? null,
              spill.mediaType,
              spill.bytes,
              spill.sha256,
              spill.createdAt,
              spill.expiresAt ?? null,
              spill.authorization ? encodeJson(spill.authorization) : null,
              payload,
            );
        }
      },
    },
    scanRecoverable: (input) =>
      runTransaction('read', async () => {
        const cursor = input.cursor ? parseRecoveryCursor(input.cursor) : undefined;
        const values: SqliteValue[] = cursor
          ? [cursor[0], cursor[0], cursor[1], input.limit + 1]
          : [input.limit + 1];
        const rows = database
          .prepare(`
            SELECT conversation_id, run_id, payload
            FROM stitchkit_agent_runtime_runs
            WHERE state IN ('queued', 'running', 'interrupt_requested')
            ${cursor ? 'AND (conversation_id > ? OR (conversation_id = ? AND run_id > ?))' : ''}
            ORDER BY conversation_id ASC, run_id ASC LIMIT ?
          `)
          .all(...values)
          .map((row) => RecoverableRowSchema.parse(row));
        const hasMore = rows.length > input.limit;
        const pageRows = rows.slice(0, input.limit);
        const items = pageRows.map((row) => {
          const run = AgentRunSchema.parse(parseJson(row.payload));
          return AgentRecoverableDescriptorSchema.parse({
            conversationId: row.conversation_id,
            run,
          });
        });
        const last = pageRows.at(-1);
        return AgentRecoverablePageSchema.parse({
          items,
          ...(hasMore && last
            ? { nextCursor: recoveryCursor(last.conversation_id, last.run_id) }
            : {}),
        });
      }),
  };

  return {
    store: createAgentRuntimeStore(driver),
    database,
    transaction: (work) =>
      runTransaction('write', (transaction) =>
        insideScope.run(true, () =>
          work({
            database: transaction,
            appendEvent: async (input) => {
              const parsed = AppendAgentStoreEventSchema.parse(input);
              if (await driver.conversations?.isPurged(transaction, parsed.conversationId)) {
                throw new AgentConversationPurgedError();
              }
              return driver.events.append(transaction, agentStoreEventDraft(parsed));
            },
          }),
        ),
      ),
    conversations: {
      list: (input) =>
        runTransaction('read', async () => {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
            throw new TypeError('Conversation page limit must be between 1 and 1000');
          }
          const cursor = input.cursor ? parseConversationCursor(input.cursor) : undefined;
          const search = input.search?.trim();
          const clauses = [
            ...(cursor ? ['conversation_id > ?'] : []),
            ...(search ? ['instr(conversation_id, ?) > 0'] : []),
          ];
          const parameters: SqliteValue[] = [
            ...(cursor ? [cursor] : []),
            ...(search ? [search] : []),
            input.limit + 1,
          ];
          const rows = database
            .prepare(`
              SELECT conversation_id, version FROM stitchkit_agent_runtime_heads
              ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
              ORDER BY conversation_id ASC LIMIT ?
            `)
            .all(...parameters)
            .map((row) => ConversationHeadRowSchema.parse(row));
          const hasMore = rows.length > input.limit;
          const pageRows = rows.slice(0, input.limit);
          const items = pageRows.map((row) => {
            const latestRaw = database
              .prepare(`
                SELECT payload FROM stitchkit_agent_runtime_messages
                WHERE conversation_id = ? AND active = 1
                ORDER BY position DESC LIMIT 1
              `)
              .get(row.conversation_id);
            if (missing(latestRaw)) {
              throw new Error('Agent conversation head has no active history');
            }
            const latest = AgentMessageSchema.parse(
              parseJson(MessageRowSchema.parse(latestRaw).payload),
            );
            const active = CountRowSchema.parse(
              database
                .prepare(`
                  SELECT count(*) AS count FROM stitchkit_agent_runtime_runs
                  WHERE conversation_id = ?
                    AND state IN ('queued', 'running', 'interrupt_requested')
                `)
                .get(row.conversation_id),
            );
            return {
              conversationId: row.conversation_id,
              version: row.version,
              updatedAt: latest.updatedAt,
              preview: messagePreview(latest),
              activeRuns: active.count,
            };
          });
          const last = pageRows.at(-1);
          return AgentConversationPageSchema.parse({
            items,
            ...(hasMore && last
              ? { nextCursor: conversationCursor(last.conversation_id) }
              : {}),
          });
        }),
      messages: (input) =>
        runTransaction('read', async () => {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
            throw new TypeError('Conversation message page limit must be between 1 and 1000');
          }
          const cursor = input.cursor ? parseMessageCursor(input.cursor) : undefined;
          const before = input.direction === 'before';
          const direction = before ? 'DESC' : 'ASC';
          const comparison =
            cursor === undefined
              ? ''
              : cursor.rowId === undefined
                ? `AND position ${before ? '<' : '>'} ?`
                : `AND (position, rowid) ${before ? '<' : '>'} (?, ?)`;
          const rows = database
            .prepare(`
              SELECT rowid AS row_id, position, active, payload
              FROM stitchkit_agent_runtime_messages
              WHERE conversation_id = ?
              ${input.includeCompacted === true ? '' : 'AND active = 1'}
              ${comparison}
              ORDER BY position ${direction}, rowid ${direction} LIMIT ?
            `)
            .all(
              input.conversationId,
              ...(cursor === undefined
                ? []
                : cursor.rowId === undefined
                  ? [cursor.position]
                  : [cursor.position, cursor.rowId]),
              input.limit + 1,
            )
            .map((row) => MessagePageRowSchema.parse(row));
          const hasMore = rows.length > input.limit;
          const pageRows = rows.slice(0, input.limit);
          const ordered = before ? [...pageRows].reverse() : pageRows;
          const boundary = pageRows.at(-1);
          const items = ordered.map((row) => ({
            message: AgentMessageSchema.parse(parseJson(row.payload)),
            active: row.active === 1,
          }));
          return AgentConversationMessagePageSchema.parse({
            items: items.map((entry) => entry.message),
            compacted: items.filter((entry) => !entry.active).map((entry) => entry.message.id),
            ...(hasMore && boundary
              ? { nextCursor: messageCursor(boundary.position, boundary.row_id) }
              : {}),
          });
        }),
    },
    async close() {
      if (closed) return;
      closing = true;
      await tail;
      database.close();
      closed = true;
    },
  };
}
