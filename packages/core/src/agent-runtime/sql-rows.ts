import { z } from 'zod';
import { AgentStoreEventEnvelopeSchema } from '../durability/events';
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import type { AgentSqlDialect, AgentSqlSession } from './sql-session';
import { type AgentRuntimeStoreDriver, AgentStoredRunSchema } from './store-driver-contract';

export type SqlStoreDriver = AgentRuntimeStoreDriver<AgentSqlSession>;

/**
 * An integer column, whichever way the client returns it.
 *
 * SQLite hands back a number. Postgres's `COUNT(*)`, `MAX()` and `bigint`
 * columns arrive as a string from Bun's SQL client and as a `bigint` from
 * Prisma, so a schema that took `number` only refused a correct row on one
 * client and not the other. Every integer the store reads goes through here.
 */
export const SqlIntegerSchema = z
  .union([z.number(), z.bigint(), z.string().regex(/^-?\d+$/)])
  .transform(Number)
  .pipe(z.int());

const SqlFlagSchema = SqlIntegerSchema.pipe(z.union([z.literal(0), z.literal(1)]));

/**
 * The row shapes and JSON codecs every part of the SQL store reads through.
 *
 * Rows arrive from the driver as `unknown`; each is parsed here once, so no
 * part of the store touches a column it has not validated.
 */
export const HeadRowSchema = z.object({
  version: SqlIntegerSchema.pipe(z.int().nonnegative()),
});
export const RunRowSchema = z.object({
  payload: z.string(),
  terminal_assistant_payload: z.string().nullable(),
});
export const MessageRowSchema = z.object({ payload: z.string() });
export const PositionedMessageRowSchema = z.object({
  position: SqlIntegerSchema.pipe(z.int().nonnegative()),
});
export const CountRowSchema = z.object({
  count: SqlIntegerSchema.pipe(z.int().nonnegative()),
});
export const FlagSchema = SqlFlagSchema;
export const EventRowSchema = z.object({
  event_id: z.string(),
  conversation_id: z.string(),
  seq: SqlIntegerSchema.pipe(z.int().positive()),
  schema_version: SqlIntegerSchema.pipe(z.int().positive()),
  kind: z.string(),
  occurred_at: z.string(),
  ignorable: SqlFlagSchema,
  payload: z.string(),
});

/** The columns `parseEventRow` reads, in one place for every statement that selects an event. */
export const EVENT_COLUMNS =
  'event_id, conversation_id, seq, schema_version, kind, occurred_at, ignorable, payload';

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

/** `MAX(seq) + 1` — correct only where the write transaction excludes every other writer. */
export async function nextEventSeqByMaximum(
  dialect: Pick<AgentSqlDialect, 'tables'>,
  session: AgentSqlSession,
  conversationId: string,
): Promise<number> {
  const row = await session.get(
    `SELECT COALESCE(MAX(seq), 0) AS count FROM ${dialect.tables.events} WHERE conversation_id = ?`,
    [conversationId],
  );
  return CountRowSchema.parse(row).count + 1;
}
