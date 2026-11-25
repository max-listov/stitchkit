import { z } from 'zod';
import {
  AgentStoreEventEnvelopeSchema,
  AgentStoreEventPageSchema,
} from '../durability/events';
import { ArchiveProjectionSchema, isRuntimeSnapshotEntry } from './archive-projection';
import { ArchiveSpillSchema } from './archive-spill';
import {
  InvocationExpiredPayloadSchema,
  type PurgeInvocationPayloadsResult,
  parsePayloadPurgeCutoff,
  redactLiveInvocationPayload,
} from './schemas-invocation-payload';
import {
  EVENT_COLUMNS,
  encodeJson,
  parseEventRow,
  parseJson,
  SqlIntegerSchema,
  type SqlStoreDriver,
} from './sql-rows';
import type { AgentSqlDialect, AgentSqlValue } from './sql-session';
import type { AgentStoreEventDraft } from './store-events';

const ArchiveProjectionRowSchema = z.object({
  name: z.string(),
  version: SqlIntegerSchema.pipe(z.int().positive()),
  upto_seq: SqlIntegerSchema.pipe(z.int().nonnegative()),
  payload: z.string(),
  updated_at: z.string(),
});
const ArchiveSpillRowSchema = z.object({
  reference_id: z.string(),
  run_id: z.string().nullable(),
  tool_call_id: z.string().nullable(),
  media_type: z.string(),
  bytes: SqlIntegerSchema.pipe(z.int().nonnegative()),
  sha256: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  authorization_payload: z.string().nullable(),
  payload: z.instanceof(Uint8Array),
});

const RedactCandidateRowSchema = z.object({
  row_id: SqlIntegerSchema,
  conversation_id: z.string(),
  seq: SqlIntegerSchema.pipe(z.int().positive()),
  occurred_at: z.string(),
  payload: z.string(),
});

/** Max valid ISO-8601 timezone offset padding (24h) so lexical pre-filtering never misses non-UTC rows. */
const MAX_ISO_OFFSET_MS = 24 * 60 * 60 * 1000;

async function redactExpiredSqlPayloads(
  dialect: AgentSqlDialect,
  transaction: Parameters<SqlStoreDriver['events']['append']>[0],
  input: { before: string; expiredAt: string; conversationId?: string; limit: number },
): Promise<PurgeInvocationPayloadsResult> {
  const cutoffEpoch = parsePayloadPurgeCutoff(input.before);
  const upperBoundIso = new Date(cutoffEpoch + MAX_ISO_OFFSET_MS).toISOString();
  const events = dialect.tables.events;
  const batchSize = Math.max(input.limit + 1, 256);
  const matched: Array<{
    row: z.infer<typeof RedactCandidateRowSchema>;
    parsed: unknown;
  }> = [];
  let cursor: { occurredAt: string; conversationId: string; seq: number } | undefined;

  while (matched.length <= input.limit) {
    const clauses = [
      "kind = 'provider/payload'",
      dialect.contains('payload'),
      'occurred_at <= ?',
    ];
    const values: AgentSqlValue[] = ['"ciphertext":', upperBoundIso];
    if (input.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      values.push(input.conversationId);
    }
    if (cursor !== undefined) {
      clauses.push(
        '(occurred_at > ? OR (occurred_at = ? AND (conversation_id > ? OR (conversation_id = ? AND seq > ?))))',
      );
      values.push(
        cursor.occurredAt,
        cursor.occurredAt,
        cursor.conversationId,
        cursor.conversationId,
        cursor.seq,
      );
    }
    const batch = (
      await transaction.all(
        `SELECT row_id, conversation_id, seq, occurred_at, payload FROM ${events}
         WHERE ${clauses.join(' AND ')}
         ORDER BY occurred_at ASC, conversation_id ASC, seq ASC LIMIT ?`,
        [...values, batchSize],
      )
    ).map((raw) => RedactCandidateRowSchema.parse(raw));
    for (const row of batch) {
      if (Date.parse(row.occurred_at) >= cutoffEpoch) continue;
      const parsed = parseJson(row.payload);
      if (InvocationExpiredPayloadSchema.safeParse(parsed).success) continue;
      matched.push({ row, parsed });
      if (matched.length > input.limit) break;
    }
    const last = batch.at(-1);
    if (batch.length < batchSize || last === undefined) break;
    cursor = {
      occurredAt: last.occurred_at,
      conversationId: last.conversation_id,
      seq: last.seq,
    };
  }

  const hasMore = matched.length > input.limit;
  const toPurge = matched.slice(0, input.limit);
  let freedBytes = 0;
  for (const { row, parsed } of toPurge) {
    const expired = redactLiveInvocationPayload(parsed, input.expiredAt);
    if (expired === undefined) continue;
    const encoded = encodeJson(expired);
    freedBytes += Math.max(0, Buffer.byteLength(row.payload) - Buffer.byteLength(encoded));
    await transaction.run(
      `UPDATE ${events} SET payload = ? WHERE conversation_id = ? AND seq = ?`,
      [encoded, row.conversation_id, row.seq],
    );
    await dialect.syncUpdatedEventSearch(transaction, {
      rowId: row.row_id,
      conversationId: row.conversation_id,
      seq: row.seq,
      occurredAt: row.occurred_at,
      payload: encoded,
    });
  }
  return { purged: toPurge.length, freedBytes, hasMore };
}

export function sqlEvents(dialect: AgentSqlDialect): SqlStoreDriver['events'] {
  const events = dialect.tables.events;
  return {
    async append(transaction, rawEvent) {
      const event: AgentStoreEventDraft = rawEvent;
      const seq = await dialect.nextEventSeq(transaction, event.conversationId);
      await transaction.run(
        `INSERT INTO ${events} (
           conversation_id, seq, event_id, schema_version, kind, occurred_at, ignorable, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.conversationId,
          seq,
          event.eventId,
          event.schemaVersion,
          event.kind,
          event.occurredAt,
          event.ignorable ? 1 : 0,
          encodeJson(event.payload),
        ],
      );
      return AgentStoreEventEnvelopeSchema.parse({ ...event, seq });
    },
    async list(transaction, input) {
      const clauses = ['conversation_id = ?'];
      const values: AgentSqlValue[] = [input.conversationId];
      if (input.fromSeq !== undefined) {
        clauses.push('seq >= ?');
        values.push(input.fromSeq);
      }
      if (input.toSeq !== undefined) {
        clauses.push('seq <= ?');
        values.push(input.toSeq);
      }
      const rows = (
        await transaction.all(
          `SELECT ${EVENT_COLUMNS} FROM ${events}
           WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
          [...values, input.limit + 1],
        )
      ).map(parseEventRow);
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit);
      const lastEvent = items.at(-1);
      return AgentStoreEventPageSchema.parse({
        items,
        ...(hasMore && lastEvent ? { nextSeq: lastEvent.seq + 1 } : {}),
      });
    },
    async find(transaction, input) {
      // `event_id` is UNIQUE, so this is one index probe.
      const row = await transaction.get(
        `SELECT ${EVENT_COLUMNS} FROM ${events} WHERE event_id = ? AND conversation_id = ?`,
        [input.eventId, input.conversationId],
      );
      return row === undefined ? undefined : parseEventRow(row);
    },
    redactExpiredPayloads: (transaction, input) =>
      redactExpiredSqlPayloads(dialect, transaction, input),
  };
}

/** Projections and spills: the durable companions an archive carries beside the events. */
export function sqlArchive(dialect: AgentSqlDialect): NonNullable<SqlStoreDriver['archive']> {
  const t = dialect.tables;
  return {
    async export(transaction, conversationId) {
      const projections = (
        await transaction.all(
          `SELECT name, version, upto_seq, payload, updated_at FROM ${t.projections}
           WHERE conversation_id = ? ORDER BY name`,
          [conversationId],
        )
      ).map((raw) => {
        const row = ArchiveProjectionRowSchema.parse(raw);
        return {
          name: row.name,
          version: row.version,
          uptoSeq: row.upto_seq,
          value: z.json().parse(parseJson(row.payload)),
          updatedAt: row.updated_at,
        };
      });
      const spills = (
        await transaction.all(
          `SELECT reference_id, run_id, tool_call_id, media_type, bytes, sha256,
             created_at, expires_at, authorization_payload, payload
           FROM ${t.spills} WHERE conversation_id = ? ORDER BY created_at, reference_id`,
          [conversationId],
        )
      ).map((raw) => {
        const row = ArchiveSpillRowSchema.parse(raw);
        return ArchiveSpillSchema.parse({
          reference: row.reference_id,
          ...(row.run_id && { runId: row.run_id }),
          ...(row.tool_call_id && { toolCallId: row.tool_call_id }),
          mediaType: row.media_type,
          bytes: row.bytes,
          sha256: row.sha256,
          createdAt: row.created_at,
          ...(row.expires_at && { expiresAt: row.expires_at }),
          ...(row.authorization_payload !== null && {
            authorization: parseJson(row.authorization_payload),
          }),
          base64: Buffer.from(row.payload).toString('base64'),
        });
      });
      return { projections, spills };
    },
    async import(transaction, archive) {
      for (const raw of archive.projections) {
        if (isRuntimeSnapshotEntry(raw)) continue;
        const projection = ArchiveProjectionSchema.parse(raw);
        await transaction.run(
          `INSERT INTO ${t.projections}
             (conversation_id, name, version, upto_seq, payload, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            archive.conversationId,
            projection.name,
            projection.version,
            projection.uptoSeq,
            encodeJson(projection.value),
            projection.updatedAt,
          ],
        );
      }
      for (const raw of archive.spills) {
        const spill = ArchiveSpillSchema.parse(raw);
        const payload = new Uint8Array(Buffer.from(spill.base64, 'base64'));
        await transaction.run(
          `INSERT INTO ${t.spills} (
             reference_id, conversation_id, run_id, tool_call_id, media_type,
             bytes, sha256, created_at, expires_at, authorization_payload, payload
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            spill.reference,
            archive.conversationId,
            spill.runId ?? null,
            spill.toolCallId ?? null,
            spill.mediaType,
            spill.bytes,
            spill.sha256,
            spill.createdAt,
            spill.expiresAt ?? null,
            spill.authorization !== undefined ? encodeJson(spill.authorization) : null,
            payload,
          ],
        );
      }
    },
  };
}
