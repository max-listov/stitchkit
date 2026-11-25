import { z } from 'zod';
import {
  type AgentConversationMessagePage,
  AgentConversationMessagePageSchema,
  type AgentConversationPage,
  AgentConversationPageSchema,
  type AgentConversationReader,
} from './conversations';
import { AgentMessageSchema, AgentRunSchema } from './schemas';
import {
  CountRowSchema,
  encodeJson,
  FlagSchema,
  MessageRowSchema,
  missing,
  parseJson,
  SqlIntegerSchema,
} from './sql-rows';
import type { AgentSqlDialect, AgentSqlSession, AgentSqlValue } from './sql-session';
import {
  AgentRecoverableDescriptorSchema,
  type AgentRecoverablePage,
  AgentRecoverablePageSchema,
} from './store';

const RecoverableRowSchema = z.object({
  conversation_id: z.string(),
  run_id: z.string(),
  payload: z.string(),
});
const ConversationHeadRowSchema = z.object({
  conversation_id: z.string(),
  version: SqlIntegerSchema.pipe(z.int().nonnegative()),
});
const MessagePageRowSchema = z.object({
  row_id: SqlIntegerSchema.pipe(z.int().positive()),
  position: SqlIntegerSchema.pipe(z.int().nonnegative()),
  active: FlagSchema,
  payload: z.string(),
});

/** Run `work` in one read transaction of the store that owns these tables. */
export type AgentSqlRead = <RESULT>(
  work: (session: AgentSqlSession) => Promise<RESULT>,
) => Promise<RESULT>;

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
 * last message it replaced, and a later compaction of that summary adds a
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
 * The reads that answer a caller directly rather than a store operation, so
 * each opens its own read transaction instead of running inside one.
 */
export function scanSqlRecoverable(
  dialect: AgentSqlDialect,
  read: AgentSqlRead,
  input: { cursor?: string; limit: number },
): Promise<AgentRecoverablePage> {
  return read(async (session) => {
    const cursor = input.cursor ? parseRecoveryCursor(input.cursor) : undefined;
    const values: AgentSqlValue[] = cursor
      ? [cursor[0], cursor[0], cursor[1], input.limit + 1]
      : [input.limit + 1];
    const rows = (
      await session.all(
        `SELECT conversation_id, run_id, payload FROM ${dialect.tables.runs}
         WHERE state IN ('queued', 'running', 'interrupt_requested')
         ${cursor ? 'AND (conversation_id > ? OR (conversation_id = ? AND run_id > ?))' : ''}
         ORDER BY conversation_id ASC, run_id ASC LIMIT ?`,
        values,
      )
    ).map((row) => RecoverableRowSchema.parse(row));
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const items = pageRows.map((row) =>
      AgentRecoverableDescriptorSchema.parse({
        conversationId: row.conversation_id,
        run: AgentRunSchema.parse(parseJson(row.payload)),
      }),
    );
    const last = pageRows.at(-1);
    return AgentRecoverablePageSchema.parse({
      items,
      ...(hasMore && last
        ? { nextCursor: recoveryCursor(last.conversation_id, last.run_id) }
        : {}),
    });
  });
}

export function listSqlConversations(
  dialect: AgentSqlDialect,
  read: AgentSqlRead,
  input: Parameters<AgentConversationReader['list']>[0],
): Promise<AgentConversationPage> {
  const t = dialect.tables;
  return read(async (session) => {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new TypeError('Conversation page limit must be between 1 and 1000');
    }
    const cursor = input.cursor ? parseConversationCursor(input.cursor) : undefined;
    const search = input.search?.trim();
    const clauses = [
      ...(cursor ? ['conversation_id > ?'] : []),
      ...(search ? [dialect.contains('conversation_id')] : []),
    ];
    const parameters: AgentSqlValue[] = [
      ...(cursor ? [cursor] : []),
      ...(search ? [search] : []),
      input.limit + 1,
    ];
    const rows = (
      await session.all(
        `SELECT conversation_id, version FROM ${t.heads}
         ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY conversation_id ASC LIMIT ?`,
        parameters,
      )
    ).map((row) => ConversationHeadRowSchema.parse(row));
    const hasMore = rows.length > input.limit;
    const pageRows = rows.slice(0, input.limit);
    const items = [];
    for (const row of pageRows) {
      const latestRaw = await session.get(
        `SELECT payload FROM ${t.messages} WHERE conversation_id = ? AND active = 1
         ORDER BY position DESC LIMIT 1`,
        [row.conversation_id],
      );
      if (missing(latestRaw)) {
        throw new Error('Agent conversation head has no active history');
      }
      const latest = AgentMessageSchema.parse(
        parseJson(MessageRowSchema.parse(latestRaw).payload),
      );
      const active = CountRowSchema.parse(
        await session.get(
          `SELECT count(*) AS count FROM ${t.runs}
           WHERE conversation_id = ? AND state IN ('queued', 'running', 'interrupt_requested')`,
          [row.conversation_id],
        ),
      );
      items.push({
        conversationId: row.conversation_id,
        version: row.version,
        updatedAt: latest.updatedAt,
        preview: messagePreview(latest),
        activeRuns: active.count,
      });
    }
    const last = pageRows.at(-1);
    return AgentConversationPageSchema.parse({
      items,
      ...(hasMore && last ? { nextCursor: conversationCursor(last.conversation_id) } : {}),
    });
  });
}

export function pageSqlConversationMessages(
  dialect: AgentSqlDialect,
  read: AgentSqlRead,
  input: Parameters<AgentConversationReader['messages']>[0],
): Promise<AgentConversationMessagePage> {
  const rowId = dialect.messageRowId;
  return read(async (session) => {
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
          : `AND (position, ${rowId}) ${before ? '<' : '>'} (?, ?)`;
    const rows = (
      await session.all(
        `SELECT ${rowId} AS row_id, position, active, payload FROM ${dialect.tables.messages}
         WHERE conversation_id = ?
         ${input.includeCompacted === true ? '' : 'AND active = 1'}
         ${comparison}
         ORDER BY position ${direction}, ${rowId} ${direction} LIMIT ?`,
        [
          input.conversationId,
          ...(cursor === undefined
            ? []
            : cursor.rowId === undefined
              ? [cursor.position]
              : [cursor.position, cursor.rowId]),
          input.limit + 1,
        ],
      )
    ).map((row) => MessagePageRowSchema.parse(row));
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
  });
}
