import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AgentStoreEventEnvelopeSchema,
  AgentStoreEventPageSchema,
} from '../durability/events';
import type { SqliteValue } from '../internal/sqlite';
import {
  CountRowSchema,
  encodeJson,
  parseEventRow,
  parseJson,
  type SqliteStoreDriver,
} from './sqlite-rows';
import type { AgentStoreEventDraft } from './store-events';

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

export const sqliteEvents: SqliteStoreDriver['events'] = {
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
};

/** Projections and spills: the durable companions an archive carries beside the events. */
export const sqliteArchive: NonNullable<SqliteStoreDriver['archive']> = {
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
};
