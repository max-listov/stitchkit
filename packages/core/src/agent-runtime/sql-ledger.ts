import { z } from 'zod';
import { AgentMessageSchema } from './schemas';
import {
  encodeJson,
  HeadRowSchema,
  missing,
  parseJson,
  parseRunRow,
  placeholders,
  type SqlStoreDriver,
} from './sql-rows';
import type { AgentSqlDialect } from './sql-session';
import {
  AgentAdmissionReceiptSchema,
  AgentRuntimeHeadSchema,
  AgentSeedReceiptSchema,
  AgentStoredRunSchema,
} from './store-driver-contract';

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

function parseAdmissionRow(value: unknown) {
  const row = AdmissionRowSchema.parse(value);
  return AgentAdmissionReceiptSchema.parse({
    schemaVersion: 1,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    input: AgentMessageSchema.parse(parseJson(row.input_payload)),
    runId: row.run_id,
    assistantMessageId: row.assistant_message_id,
  });
}

const ACTIVE_STATES = "('queued', 'running', 'interrupt_requested')";

/** Head, runs, admissions and seeds: the rows a store mutation reads and writes. */
export function sqlLedger(
  dialect: AgentSqlDialect,
): Pick<SqlStoreDriver, 'head' | 'runs' | 'admissions' | 'seeds'> {
  const t = dialect.tables;
  return {
    head: {
      async load(transaction, conversationId) {
        const value = await transaction.get(
          `SELECT version FROM ${t.heads} WHERE conversation_id = ?`,
          [conversationId],
        );
        if (missing(value)) return undefined;
        return AgentRuntimeHeadSchema.parse({
          schemaVersion: 1,
          conversationId,
          version: HeadRowSchema.parse(value).version,
        });
      },
      /**
       * Read, compare, then write — rather than a conditional upsert whose
       * outcome is read back from an affected-row count.
       *
       * The count cannot carry that decision: `bun:sqlite` includes what the
       * event table's AFTER INSERT trigger and FTS5's deferred index flush wrote
       * during the same statement, so a head upsert that moved one row reported
       * five. A conditional upsert is also not a compare-and-swap on the insert
       * path: `ON CONFLICT ... WHERE` guards the update branch only, so a first
       * write applied whatever `expectedVersion` it was given.
       *
       * Safe as two statements because every caller is inside the store's
       * write transaction — `BEGIN IMMEDIATE` on SQLite, SERIALIZABLE on
       * Postgres — which no second writer can interleave with unnoticed.
       */
      async compareAndSwap(transaction, input) {
        const current = await transaction.get(
          `SELECT version FROM ${t.heads} WHERE conversation_id = ?`,
          [input.conversationId],
        );
        const actualVersion = missing(current) ? 0 : HeadRowSchema.parse(current).version;
        if (actualVersion !== input.expectedVersion) {
          return { outcome: 'conflict', actualVersion };
        }
        await transaction.run(
          `INSERT INTO ${t.heads} (conversation_id, version) VALUES (?, ?)
           ON CONFLICT (conversation_id) DO UPDATE SET version = excluded.version`,
          [input.conversationId, input.next.version],
        );
        return { outcome: 'applied' };
      },
    },
    runs: {
      async load(transaction, input) {
        const row = await transaction.get(
          `SELECT payload, terminal_assistant_payload FROM ${t.runs}
           WHERE conversation_id = ? AND run_id = ?`,
          [input.conversationId, input.runId],
        );
        return missing(row) ? undefined : parseRunRow(row);
      },
      async loadByAssistantMessageId(transaction, input) {
        const row = await transaction.get(
          `SELECT payload, terminal_assistant_payload FROM ${t.runs}
           WHERE conversation_id = ? AND assistant_message_id = ?`,
          [input.conversationId, input.assistantMessageId],
        );
        return missing(row) ? undefined : parseRunRow(row);
      },
      async loadMany(transaction, input) {
        if (input.runIds.length === 0) return [];
        const rows = await transaction.all(
          `SELECT payload, terminal_assistant_payload FROM ${t.runs}
           WHERE conversation_id = ? AND run_id IN (${placeholders(input.runIds.length)})`,
          [input.conversationId, ...input.runIds],
        );
        return rows.map(parseRunRow);
      },
      async listActive(transaction, conversationId) {
        const rows = await transaction.all(
          `SELECT payload, terminal_assistant_payload FROM ${t.runs}
           WHERE conversation_id = ? AND state IN ${ACTIVE_STATES}`,
          [conversationId],
        );
        return rows.map(parseRunRow);
      },
      async save(transaction, rawRecord) {
        const record = AgentStoredRunSchema.parse(rawRecord);
        await transaction.run(
          `INSERT INTO ${t.runs} (
             conversation_id, run_id, assistant_message_id, state, created_at, payload,
             terminal_assistant_payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (conversation_id, run_id) DO UPDATE SET
             assistant_message_id = excluded.assistant_message_id,
             state = excluded.state,
             created_at = excluded.created_at,
             payload = excluded.payload,
             terminal_assistant_payload = excluded.terminal_assistant_payload`,
          [
            record.run.conversationId,
            record.run.id,
            record.run.assistantMessageId,
            record.run.state,
            record.run.createdAt,
            encodeJson(record.run),
            record.terminalAssistant ? encodeJson(record.terminalAssistant) : null,
          ],
        );
      },
    },
    admissions: {
      async load(transaction, input) {
        const value = await transaction.get(
          `SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
           FROM ${t.admissions} WHERE conversation_id = ? AND idempotency_key = ?`,
          [input.conversationId, input.idempotencyKey],
        );
        return missing(value) ? undefined : parseAdmissionRow(value);
      },
      async loadByInputMessageId(transaction, input) {
        const value = await transaction.get(
          `SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
           FROM ${t.admissions} WHERE conversation_id = ? AND input_message_id = ?`,
          [input.conversationId, input.inputMessageId],
        );
        return missing(value) ? undefined : parseAdmissionRow(value);
      },
      async create(transaction, rawReceipt) {
        const receipt = AgentAdmissionReceiptSchema.parse(rawReceipt);
        await transaction.run(
          `INSERT INTO ${t.admissions} (
             conversation_id, idempotency_key, input_message_id, run_id,
             assistant_message_id, input_payload
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            receipt.conversationId,
            receipt.idempotencyKey,
            receipt.input.id,
            receipt.runId,
            receipt.assistantMessageId,
            encodeJson(receipt.input),
          ],
        );
      },
    },
    seeds: {
      async load(transaction, input) {
        const value = await transaction.get(
          `SELECT conversation_id, seed_key, message_ids FROM ${t.seeds}
           WHERE conversation_id = ? AND seed_key = ?`,
          [input.conversationId, input.seedKey],
        );
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
        await transaction.run(
          `INSERT INTO ${t.seeds} (conversation_id, seed_key, message_ids, created_at)
           VALUES (?, ?, ?, ?)`,
          [
            receipt.conversationId,
            receipt.seedKey,
            encodeJson(receipt.messageIds),
            new Date().toISOString(),
          ],
        );
      },
    },
  };
}
