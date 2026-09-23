import { z } from 'zod';
import { AgentStoreEventEnvelopeSchema } from '../durability/events';
import type { SqliteDatabase } from '../internal/sqlite';
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import { type AgentRuntimeStoreDriver, AgentStoredRunSchema } from './store-driver-contract';

export type SqliteStoreDriver = AgentRuntimeStoreDriver<SqliteDatabase>;

/**
 * The row shapes and JSON codecs every part of the SQLite store reads through.
 *
 * Rows arrive from the driver as `unknown`; each is parsed here once, so no
 * part of the store touches a column it has not validated.
 */
export const HeadRowSchema = z.object({ version: z.number().int().nonnegative() });
export const RunRowSchema = z.object({
  payload: z.string(),
  terminal_assistant_payload: z.string().nullable(),
});
export const MessageRowSchema = z.object({ payload: z.string() });
export const PositionedMessageRowSchema = z.object({
  position: z.number().int().nonnegative(),
});
export const CountRowSchema = z.object({ count: z.number().int().nonnegative() });
export const EventRowSchema = z.object({
  event_id: z.string(),
  conversation_id: z.string(),
  seq: z.int().positive(),
  schema_version: z.int().positive(),
  kind: z.string(),
  occurred_at: z.string(),
  ignorable: z.union([z.literal(0), z.literal(1)]),
  payload: z.string(),
});

export function parseJson(value: string): unknown {
  return JSON.parse(value);
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function missing(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function parseRunRow(value: unknown) {
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

export function parseEventRow(value: unknown) {
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
