import { z } from 'zod';
import { SqlIntegerSchema } from './sql-rows';

/** More terms than this is not a search but a pasted document; it is refused, not truncated. */
export const MAX_SEARCH_TERMS = 64;

/**
 * The words of a natural-language query, each a literal the backend matches
 * on its own: every word must occur, in any order.
 *
 * Quoting the whole query turned every multi-word request into an exact
 * phrase, so "deploy decision yesterday" matched only those three words
 * adjacent and answered `[]` when they merely occurred — a silent zero read as
 * "the journal never said this". A word with no letter or digit is
 * punctuation and is dropped; a query left with none is refused.
 */
export function extractSearchTerms(query: string): string[] {
  const terms = query.split(/\s+/u).filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (terms.length === 0)
    throw new TypeError('Event search query must contain searchable terms');
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new TypeError(
      `Event search query has ${terms.length} terms, at most ${MAX_SEARCH_TERMS} are searched`,
    );
  }
  return terms;
}

export const SearchRowSchema = z.object({
  conversation_id: z.string(),
  event_seq: SqlIntegerSchema.pipe(z.int().positive()),
  occurred_at: z.string(),
  snippet: z.string(),
});

export type SearchRow = z.infer<typeof SearchRowSchema>;

/** One page of candidates, best first; who may see them is decided by the caller. */
export interface AgentEventSearchBackend {
  /** Prepare/validate settings, index lag, and terms once per search before paging. */
  prepare?(request: { terms: readonly string[]; target?: string }): Promise<void>;
  candidates(request: {
    terms: readonly string[];
    target?: string;
    since?: string;
    limit: number;
    offset: number;
  }): Promise<readonly SearchRow[]>;
}
