import { z } from 'zod';
import { AgentMessageSchema } from './schemas';
import {
  encodeJson,
  HeadRowSchema,
  missing,
  parseJson,
  parseRunRow,
  placeholders,
  type SqliteStoreDriver,
} from './sqlite-rows';
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

/** Head, runs, admissions and seeds: the rows a store mutation reads and writes. */
export const sqliteHeads: SqliteStoreDriver['head'] = {
  async load(transaction, conversationId) {
    const value = transaction
      .prepare('SELECT version FROM stitchkit_agent_runtime_heads WHERE conversation_id = ?')
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
      .prepare('SELECT version FROM stitchkit_agent_runtime_heads WHERE conversation_id = ?')
      .get(input.conversationId);
    const actualVersion = missing(current) ? 0 : HeadRowSchema.parse(current).version;
    if (actualVersion !== input.expectedVersion) return { outcome: 'conflict', actualVersion };
    transaction
      .prepare(`
        INSERT INTO stitchkit_agent_runtime_heads (conversation_id, version)
        VALUES (?, ?)
        ON CONFLICT (conversation_id) DO UPDATE SET version = excluded.version
      `)
      .run(input.conversationId, input.next.version);
    return { outcome: 'applied' };
  },
};

export const sqliteRuns: SqliteStoreDriver['runs'] = {
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
};

export const sqliteAdmissions: SqliteStoreDriver['admissions'] = {
  async load(transaction, input) {
    const value = transaction
      .prepare(`
        SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
        FROM stitchkit_agent_runtime_admissions
        WHERE conversation_id = ? AND idempotency_key = ?
      `)
      .get(input.conversationId, input.idempotencyKey);
    return missing(value) ? undefined : parseAdmissionRow(value);
  },
  async loadByInputMessageId(transaction, input) {
    const value = transaction
      .prepare(`
        SELECT conversation_id, idempotency_key, input_payload, run_id, assistant_message_id
        FROM stitchkit_agent_runtime_admissions
        WHERE conversation_id = ? AND input_message_id = ?
      `)
      .get(input.conversationId, input.inputMessageId);
    return missing(value) ? undefined : parseAdmissionRow(value);
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
};

export const sqliteSeeds: SqliteStoreDriver['seeds'] = {
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
};
