import { z } from 'zod';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { AgentCompanionHost } from './companion-host';
import {
  type PostgresAgentEventSearchConfig,
  postgresEventSearchBackend,
} from './event-search-postgres';
import {
  type AgentEventSearchBackend,
  extractSearchTerms,
  SearchRowSchema,
} from './event-search-terms';
import type { AgentSqlValue } from './sql-session';

export const AgentEventSearchResultSchema = z
  .object({
    conversationId: z.string().min(1),
    seq: z.int().positive(),
    occurredAt: z.string(),
    snippet: z.string(),
  })
  .strict();

export type AgentEventSearchResult = z.infer<typeof AgentEventSearchResultSchema>;

/** Matches as FTS5 literals joined by `AND`; query punctuation stays data, never FTS5 syntax. */
function sqliteBackend(host: AgentCompanionHost): AgentEventSearchBackend {
  const fts = `${host.tables.events}_fts`;
  return {
    async candidates(request) {
      const values: AgentSqlValue[] = [
        request.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '),
      ];
      if (request.target) values.push(request.target);
      if (request.since) values.push(request.since);
      const rows = await host.read((session) =>
        session.all(
          `SELECT f.conversation_id, f.event_seq, f.occurred_at,
             snippet(${fts}, 3, '[', ']', ' … ', 24) AS snippet
           FROM ${fts} AS f
           WHERE ${fts} MATCH ?
             ${request.target ? 'AND f.conversation_id = ?' : ''}
             ${request.since ? 'AND f.occurred_at >= ?' : ''}
           ORDER BY bm25(${fts}), f.occurred_at DESC, f.rowid
           LIMIT ? OFFSET ?`,
          [...values, request.limit, request.offset],
        ),
      );
      return rows.map((row) => SearchRowSchema.parse(row));
    },
  };
}

/**
 * Search a conversation's events: every word of the query, in any order,
 * across the conversations the requester may read.
 *
 * On the SQLite store the backend is FTS5. On the Postgres store it is a
 * `tsvector` index kept beside the events and brought up to date when a search
 * needs it (`postgres` configures it); the divergences between the two are
 * named in ADR 0315.
 */
export function createAgentEventSearch(input: {
  /** The store's companion host: `host` of the SQLite or Postgres store. */
  host: AgentCompanionHost;
  authorizeConversation?(request: {
    requestingConversationId: string;
    targetConversationId: string;
  }): boolean | Promise<boolean>;
  /** The Postgres index's options; refused on the SQLite store, where they would change nothing. */
  postgres?: PostgresAgentEventSearchConfig;
}) {
  const { host } = input;
  if (host.dialect === 'sqlite' && input.postgres !== undefined) {
    throw new TypeError('Event search: `postgres` options apply to the Postgres store only');
  }
  const backend =
    host.dialect === 'sqlite'
      ? sqliteBackend(host)
      : postgresEventSearchBackend(host, input.postgres);
  return async (request: {
    requestingConversationId: string;
    query: string;
    conversationId?: string;
    since?: string;
    limit?: number;
  }): Promise<readonly AgentEventSearchResult[]> => {
    if (request.query.trim().length === 0)
      throw new TypeError('Event search query must not be empty');
    const terms = extractSearchTerms(request.query);
    if (request.limit !== undefined) {
      assertPositiveSafeInteger('Event search limit', request.limit, TypeError);
    }
    const limit = Math.min(request.limit ?? 20, 200);
    // Without an authorizer only the requester's own conversation can ever be
    // returned, so it is the only one worth reading: filtering afterwards let
    // a neighbour with more matches push every own hit out of the candidate
    // window and answer "nothing" to a conversation that had one.
    const target =
      request.conversationId ??
      (input.authorizeConversation ? undefined : request.requestingConversationId);
    const since = request.since
      ? z.iso.datetime({ offset: true }).parse(request.since)
      : undefined;
    await backend.prepare?.({ terms, ...(target !== undefined && { target }) });
    const page = limit * 4;
    const candidatesFrom = (offset: number) =>
      backend.candidates({
        terms,
        ...(target !== undefined && { target }),
        ...(since !== undefined && { since }),
        limit: page,
        offset,
      });
    const authorization = new Map<string, boolean>();
    const results: AgentEventSearchResult[] = [];
    // With an authorizer, foreign candidates are read and refused in pages
    // until the requester's limit is met or the index runs out — the
    // requester's own matches cannot starve behind a neighbour's.
    let offset = 0;
    let candidates = await candidatesFrom(offset);
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
      candidates = results.length < limit ? await candidatesFrom(offset) : [];
    }
    return results;
  };
}
