import { z } from 'zod';
import type { SqliteDatabase, SqliteValue } from '../internal/sqlite';

export const AgentEventSearchResultSchema = z
  .object({
    conversationId: z.string().min(1),
    seq: z.int().positive(),
    occurredAt: z.string(),
    snippet: z.string(),
  })
  .strict();

export type AgentEventSearchResult = z.infer<typeof AgentEventSearchResultSchema>;

const SearchRowSchema = z.object({
  conversation_id: z.string(),
  event_seq: z.int().positive(),
  occurred_at: z.string(),
  snippet: z.string(),
});

/**
 * Turn a natural-language query into FTS5 terms joined by `AND`.
 *
 * Quoting the whole query turned every multi-word request into an exact phrase,
 * so "deploy decision yesterday" matched only those three words adjacent in
 * that order and answered `[]` when they merely occurred — a silent zero read
 * as "the journal never said this". Terms are joined by `AND` instead: all
 * words must occur, not in order. Each term is quoted as a literal, so query
 * punctuation stays data and never becomes FTS5 syntax.
 */
function literalFtsQuery(query: string): string {
  const terms = query.split(/\s+/u).filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (terms.length === 0)
    throw new TypeError('Event search query must contain searchable terms');
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

export function createSqliteAgentEventSearch(input: {
  database: SqliteDatabase;
  authorizeConversation?(request: {
    requestingConversationId: string;
    targetConversationId: string;
  }): boolean | Promise<boolean>;
}) {
  return async (request: {
    requestingConversationId: string;
    query: string;
    conversationId?: string;
    since?: string;
    limit?: number;
  }): Promise<readonly AgentEventSearchResult[]> => {
    if (request.query.trim().length === 0)
      throw new TypeError('Event search query must not be empty');
    const limit = Math.min(request.limit ?? 20, 200);
    // Without an authorizer only the requester's own conversation can ever be
    // returned, so it is the only one worth reading: filtering afterwards let
    // a neighbour with more matches push every own hit out of the candidate
    // window and answer "nothing" to a conversation that had one.
    const target =
      request.conversationId ??
      (input.authorizeConversation ? undefined : request.requestingConversationId);
    const values: SqliteValue[] = [literalFtsQuery(request.query)];
    const targetClause = target ? 'AND f.conversation_id = ?' : '';
    if (target) values.push(target);
    const sinceClause = request.since ? 'AND f.occurred_at >= ?' : '';
    if (request.since) values.push(z.iso.datetime({ offset: true }).parse(request.since));
    const page = limit * 4;
    const candidatesFrom = (offset: number) =>
      input.database
        .prepare(`
          SELECT f.conversation_id, f.event_seq, f.occurred_at,
            snippet(stitchkit_agent_runtime_events_fts, 3, '[', ']', ' … ', 24) AS snippet
          FROM stitchkit_agent_runtime_events_fts AS f
          WHERE stitchkit_agent_runtime_events_fts MATCH ? ${targetClause} ${sinceClause}
          ORDER BY bm25(stitchkit_agent_runtime_events_fts), f.occurred_at DESC, f.rowid
          LIMIT ? OFFSET ?
        `)
        .all(...values, page, offset)
        .map((row) => SearchRowSchema.parse(row));
    const authorization = new Map<string, boolean>();
    const results: AgentEventSearchResult[] = [];
    // With an authorizer, foreign candidates are read and refused in pages
    // until the requester's limit is met or the index runs out — the
    // requester's own matches cannot starve behind a neighbour's.
    let offset = 0;
    let candidates = candidatesFrom(offset);
    while (candidates.length > 0 && results.length < limit) {
      for (const row of candidates) {
        if (row.conversation_id !== request.requestingConversationId) {
          let allowed = authorization.get(row.conversation_id);
          if (allowed === undefined) {
            allowed = input.authorizeConversation
              ? await input.authorizeConversation({
                  requestingConversationId: request.requestingConversationId,
                  targetConversationId: row.conversation_id,
                })
              : false;
            authorization.set(row.conversation_id, allowed);
          }
          if (!allowed) continue;
        }
        results.push(
          AgentEventSearchResultSchema.parse({
            conversationId: row.conversation_id,
            seq: row.event_seq,
            occurredAt: row.occurred_at,
            snippet: row.snippet,
          }),
        );
        if (results.length === limit) break;
      }
      offset += page;
      candidates = results.length < limit ? candidatesFrom(offset) : [];
    }
    return results;
  };
}
