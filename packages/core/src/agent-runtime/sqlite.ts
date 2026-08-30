import { z } from 'zod';
import {
  AgentConversationMessagePageSchema,
  AgentConversationPageSchema,
  type AgentConversationReader,
} from './conversations';
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import { AgentRecoverableDescriptorSchema, AgentRecoverablePageSchema } from './store';
import {
  AgentAdmissionReceiptSchema,
  AgentHistoryMutationSchema,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredRunSchema,
  createAgentRuntimeStore,
} from './store-driver';

export type AgentRuntimeSqliteValue = string | number | bigint | null | Uint8Array;

export interface AgentRuntimeSqliteStatement {
  get(...parameters: AgentRuntimeSqliteValue[]): unknown;
  all(...parameters: AgentRuntimeSqliteValue[]): readonly unknown[];
  run(...parameters: AgentRuntimeSqliteValue[]): { changes: number };
}

/** Minimal synchronous SQLite boundary implemented by the Bun and Node leaf entrypoints. */
export interface AgentRuntimeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): AgentRuntimeSqliteStatement;
  close(): void;
}

export interface SqliteAgentRuntimeStoreConfig {
  database: AgentRuntimeSqliteDatabase;
  /** Create or validate Stitchkit's namespaced schema. Default true. */
  initialize?: boolean;
}

export interface SqliteAgentRuntimeStore {
  store: ReturnType<typeof createAgentRuntimeStore<AgentRuntimeSqliteDatabase>>;
  conversations: AgentConversationReader;
  /** Refuse new work, wait for queued operations, then close the owned connection. */
  close(): Promise<void>;
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
  position: z.number().int().nonnegative(),
  payload: z.string(),
});

const SCHEMA_VERSION = 1;
const TABLES = [
  'stitchkit_agent_runtime_heads',
  'stitchkit_agent_runtime_runs',
  'stitchkit_agent_runtime_admissions',
  'stitchkit_agent_runtime_messages',
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

function messageCursor(position: number): string {
  return encodeJson([position]);
}

function parseMessageCursor(cursor: string): number {
  return z.tuple([z.int().nonnegative()]).parse(parseJson(cursor))[0];
}

function messagePreview(message: z.infer<typeof AgentMessageSchema>): string {
  const text = message.parts.find((part) => part.type === 'text');
  return text?.type === 'text' ? text.text.slice(0, 160) : message.role;
}

/**
 * Create Stitchkit's schema without claiming an application's tables or SQLite user_version.
 * An orphaned partial Stitchkit schema is refused rather than destructively repaired.
 */
export function initializeAgentRuntimeSqlite(database: AgentRuntimeSqliteDatabase): void {
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

  database.exec('BEGIN IMMEDIATE');
  try {
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
      INSERT INTO stitchkit_agent_runtime_meta (key, value) VALUES ('schema_version', '1');
    `);
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

  const serial = <RESULT>(work: () => Promise<RESULT>): Promise<RESULT> => {
    if (closing || closed) {
      return Promise.reject(new Error('SQLite agent-runtime store is closing'));
    }
    const result = tail.then(work, work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const driver: AgentRuntimeStoreDriver<AgentRuntimeSqliteDatabase> = {
    transaction: (work) =>
      serial(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = await work(database);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }),
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
      async compareAndSwap(transaction, input) {
        const result = transaction
          .prepare(`
            INSERT INTO stitchkit_agent_runtime_heads (conversation_id, version)
            VALUES (?, ?)
            ON CONFLICT (conversation_id) DO UPDATE SET version = excluded.version
            WHERE stitchkit_agent_runtime_heads.version = ?
          `)
          .run(input.conversationId, input.next.version, input.expectedVersion);
        if (result.changes === 1) return { outcome: 'applied' };
        const current = transaction
          .prepare(
            'SELECT version FROM stitchkit_agent_runtime_heads WHERE conversation_id = ?',
          )
          .get(input.conversationId);
        return {
          outcome: 'conflict',
          actualVersion: missing(current) ? 0 : HeadRowSchema.parse(current).version,
        };
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
      async apply(transaction, rawMutation) {
        const mutation = AgentHistoryMutationSchema.parse(rawMutation);
        const message =
          mutation.type === 'admit'
            ? mutation.input
            : mutation.type === 'upsert-assistant'
              ? mutation.message
              : mutation.summary;
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
          const first = rows[0];
          if (!first || rows.length !== parameters.length) {
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
            .run(message.conversationId, message.id, first.position, encodeJson(message));
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
    scanRecoverable: (input) =>
      serial(async () => {
        const cursor = input.cursor ? parseRecoveryCursor(input.cursor) : undefined;
        const values: AgentRuntimeSqliteValue[] = cursor
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
    conversations: {
      list: (input) =>
        serial(async () => {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
            throw new TypeError('Conversation page limit must be between 1 and 1000');
          }
          const cursor = input.cursor ? parseConversationCursor(input.cursor) : undefined;
          const search = input.search?.trim();
          const clauses = [
            ...(cursor ? ['conversation_id > ?'] : []),
            ...(search ? ['instr(conversation_id, ?) > 0'] : []),
          ];
          const parameters: AgentRuntimeSqliteValue[] = [
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
                SELECT position, payload FROM stitchkit_agent_runtime_messages
                WHERE conversation_id = ? AND active = 1
                ORDER BY position DESC LIMIT 1
              `)
              .get(row.conversation_id);
            if (missing(latestRaw)) {
              throw new Error('Agent conversation head has no active history');
            }
            const latest = AgentMessageSchema.parse(
              parseJson(MessagePageRowSchema.parse(latestRaw).payload),
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
        serial(async () => {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
            throw new TypeError('Conversation message page limit must be between 1 and 1000');
          }
          const cursor = input.cursor ? parseMessageCursor(input.cursor) : undefined;
          const before = input.direction === 'before';
          const rows = database
            .prepare(`
              SELECT position, payload FROM stitchkit_agent_runtime_messages
              WHERE conversation_id = ? AND active = 1
              ${cursor === undefined ? '' : before ? 'AND position < ?' : 'AND position > ?'}
              ORDER BY position ${before ? 'DESC' : 'ASC'} LIMIT ?
            `)
            .all(
              input.conversationId,
              ...(cursor === undefined ? [] : [cursor]),
              input.limit + 1,
            )
            .map((row) => MessagePageRowSchema.parse(row));
          const hasMore = rows.length > input.limit;
          const pageRows = rows.slice(0, input.limit);
          const ordered = before ? [...pageRows].reverse() : pageRows;
          const boundary = pageRows.at(-1);
          return AgentConversationMessagePageSchema.parse({
            items: ordered.map((row) => AgentMessageSchema.parse(parseJson(row.payload))),
            ...(hasMore && boundary ? { nextCursor: messageCursor(boundary.position) } : {}),
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
