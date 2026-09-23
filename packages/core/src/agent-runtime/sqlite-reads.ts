import { z } from 'zod';
import type { SqliteValue } from '../internal/sqlite';
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
  MessageRowSchema,
  missing,
  parseJson,
} from './sqlite-rows';
import { runSqliteTransaction, type SqliteStoreState } from './sqlite-transactions';
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
  version: z.number().int().nonnegative(),
});
const MessagePageRowSchema = z.object({
  row_id: z.number().int().positive(),
  position: z.number().int().nonnegative(),
  active: z.union([z.literal(0), z.literal(1)]),
  payload: z.string(),
});

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
 * The reads that answer a caller directly rather than a store operation, so
 * each opens its own read transaction instead of running inside one.
 */
export function scanSqliteRecoverable(
  state: SqliteStoreState,
  input: { cursor?: string; limit: number },
): Promise<AgentRecoverablePage> {
  const database = state.database;
  return runSqliteTransaction(state, 'read', async () => {
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
  });
}

export function listSqliteConversations(
  state: SqliteStoreState,
  input: Parameters<AgentConversationReader['list']>[0],
): Promise<AgentConversationPage> {
  const database = state.database;
  return runSqliteTransaction(state, 'read', async () => {
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
      ...(hasMore && last ? { nextCursor: conversationCursor(last.conversation_id) } : {}),
    });
  });
}

export function pageSqliteConversationMessages(
  state: SqliteStoreState,
  input: Parameters<AgentConversationReader['messages']>[0],
): Promise<AgentConversationMessagePage> {
  const database = state.database;
  return runSqliteTransaction(state, 'read', async () => {
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
  });
}
