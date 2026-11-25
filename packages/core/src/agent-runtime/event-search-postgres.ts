import { z } from 'zod';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { AgentCompanionHost } from './companion-host';
import { type AgentEventSearchBackend, SearchRowSchema } from './event-search-terms';
import { postgresErrorState } from './postgres-transactions';
import { AgentConversationPurgedError } from './purge';
import { SqlIntegerSchema } from './sql-rows';
import type { AgentSqlSession, AgentSqlValue } from './sql-session';

/** Configuration options for Postgres-backed agent conversation event search. */
export interface PostgresAgentEventSearchConfig {
  /**
   * `preserve` matches `café` only as `café`. `unaccent` matches it as `cafe`
   * too, as SQLite's FTS5 does, through Postgres's `unaccent` extension, which
   * the database must already have; without it the search refuses rather
   * than quietly preserving. The choice is recorded with the index, and a
   * search with the other choice refuses the index. Default `preserve`.
   */
  diacritics?: 'preserve' | 'unaccent';
  /**
   * Characters of each event's payload that are indexed. An event of any
   * size is stored; past this its text is not searchable. Default 65 536.
   */
  maxIndexedChars?: number;
  /**
   * Events one search may index before it answers. A search behind by more
   * refuses with how far, after indexing this many, rather than answering
   * from an index that has not seen them; the next search continues.
   * Default 10 000.
   */
  maxSyncEvents?: number;
}

const BATCH = 500;
const EventRowSchema = z.object({
  seq: SqlIntegerSchema.pipe(z.int().positive()),
  occurred_at: z.string(),
  payload: z.string(),
});
const BehindRowSchema = z.object({
  conversation_id: z.string(),
  last_seq: SqlIntegerSchema,
  indexed_seq: SqlIntegerSchema,
});
const MetaRowSchema = z.object({ value: z.string() });
const IndexedRowSchema = z.object({ indexed_seq: SqlIntegerSchema });
const CountSchema = z.object({ count: SqlIntegerSchema });

function positive(name: string, value: number | undefined, fallback: number): number {
  assertPositiveSafeInteger(`Event search: ${name}`, value);
  return value ?? fallback;
}

async function refuseOtherDiacriticsSettings(
  session: AgentSqlSession,
  metaTable: string,
  diacritics: 'preserve' | 'unaccent',
): Promise<boolean> {
  if (diacritics === 'unaccent') {
    const present = await session.get(
      "SELECT 1 AS present FROM pg_extension WHERE extname = 'unaccent'",
    );
    if (present === undefined) {
      throw new TypeError(
        "Event search: diacritics 'unaccent' needs Postgres's unaccent extension (CREATE EXTENSION unaccent)",
      );
    }
  }
  const row = await session.get(
    `SELECT value FROM ${metaTable} WHERE key = 'event_search_diacritics'`,
  );
  if (row === undefined) return false;
  const recorded = MetaRowSchema.parse(row).value;
  if (recorded !== diacritics) {
    throw new TypeError(
      `Event search: the index was built with diacritics '${recorded}', this search asks for '${diacritics}'`,
    );
  }
  return true;
}

/**
 * The event search on Postgres: a `tsvector` per event, `simple`
 * configuration, kept in `<prefix>_event_search` and brought up to date per
 * conversation, by `<prefix>_event_search_state`, when a search needs it.
 *
 * Indexing is not part of `appendEvent`: `to_tsvector` refuses a document
 * past its size limit (`54000`), and an append that failed because of its
 * search index would lose an event to an optional feature. A document that
 * is still too long is indexed again from half as many characters, inside a
 * savepoint, down to none.
 */
export function postgresEventSearchBackend(
  host: AgentCompanionHost,
  config: PostgresAgentEventSearchConfig = {},
): AgentEventSearchBackend {
  const diacritics = config.diacritics ?? 'preserve';
  if (diacritics !== 'preserve' && diacritics !== 'unaccent') {
    throw new TypeError("Event search: diacritics must be 'preserve' or 'unaccent'");
  }
  const maxIndexedChars = positive('maxIndexedChars', config.maxIndexedChars, 65_536);
  const maxSyncEvents = positive('maxSyncEvents', config.maxSyncEvents, 10_000);
  const index = host.tables.eventSearch;
  const state = host.tables.eventSearchState;
  const fold = (expression: string) =>
    diacritics === 'unaccent' ? `unaccent(${expression})` : expression;
  const refuseOtherSettings = (session: AgentSqlSession) =>
    refuseOtherDiacriticsSettings(session, host.tables.meta, diacritics);

  const indexOne = async (
    session: AgentSqlSession,
    conversationId: string,
    event: z.infer<typeof EventRowSchema>,
  ): Promise<void> => {
    for (let chars = maxIndexedChars; ; chars = Math.floor(chars / 2)) {
      await session.run('SAVEPOINT stitchkit_event_search');
      try {
        await session.run(
          `INSERT INTO ${index} (conversation_id, seq, occurred_at, body, document)
           VALUES (?, ?, ?, left(?, ?), to_tsvector('simple', ${fold('left(?, ?)')}))
           ON CONFLICT (conversation_id, seq) DO NOTHING`,
          [
            conversationId,
            event.seq,
            event.occurred_at,
            event.payload,
            chars,
            event.payload,
            chars,
          ],
        );
        await session.run('RELEASE SAVEPOINT stitchkit_event_search');
        return;
      } catch (error) {
        try {
          await session.run('ROLLBACK TO SAVEPOINT stitchkit_event_search');
        } catch (rollbackError) {
          // The transaction is now aborted; what failed first is what the caller needs.
          throw new AggregateError(
            [error, rollbackError],
            'Event search could not index an event, and its savepoint rollback failed too',
            { cause: error },
          );
        }
        if (postgresErrorState(error) !== '54000' || chars === 0) throw error;
      }
    }
  };

  /** Index up to `budget` events of one conversation; how many it indexed. */
  const catchUp = (conversationId: string, budget: number): Promise<number> =>
    host
      .transaction(conversationId, async (scope) => {
        if (!(await refuseOtherSettings(scope))) {
          await scope.run(
            `INSERT INTO ${host.tables.meta} (key, value) VALUES ('event_search_diacritics', ?)
             ON CONFLICT (key) DO NOTHING`,
            [diacritics],
          );
          await refuseOtherSettings(scope);
        }
        const done = await scope.get(
          `SELECT indexed_seq FROM ${state} WHERE conversation_id = ?`,
          [conversationId],
        );
        const from = done === undefined ? 0 : IndexedRowSchema.parse(done).indexed_seq;
        const events = (
          await scope.all(
            `SELECT seq, occurred_at, payload FROM ${host.tables.events}
             WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
            [conversationId, from, Math.min(budget, BATCH)],
          )
        ).map((row) => EventRowSchema.parse(row));
        for (const event of events) await indexOne(scope, conversationId, event);
        const last = events.at(-1);
        if (last !== undefined) {
          await scope.run(
            `INSERT INTO ${state} (conversation_id, indexed_seq) VALUES (?, ?)
             ON CONFLICT (conversation_id) DO UPDATE SET indexed_seq = excluded.indexed_seq`,
            [conversationId, last.seq],
          );
        }
        return events.length;
      })
      .catch((error: unknown) => {
        // A conversation purged between the scan and its turn has nothing to index.
        if (error instanceof AgentConversationPurgedError) return 0;
        throw error;
      });

  const behind = (target: string | undefined) =>
    host.read(async (session) =>
      (
        await session.all(
          `SELECT q.conversation_id, q.last_seq, COALESCE(s.indexed_seq, 0) AS indexed_seq
           FROM ${host.tables.eventSeq} q LEFT JOIN ${state} s USING (conversation_id)
           WHERE q.last_seq > COALESCE(s.indexed_seq, 0)
           ${target === undefined ? '' : 'AND q.conversation_id = ?'}
           ORDER BY q.conversation_id`,
          target === undefined ? [] : [target],
        )
      ).map((row) => BehindRowSchema.parse(row)),
    );

  const sync = async (target: string | undefined): Promise<void> => {
    let budget = maxSyncEvents;
    const initial = await behind(target);
    if (initial.length === 0) return;
    const watermarks = new Map(initial.map((row) => [row.conversation_id, row.last_seq]));
    for (const conversation of initial) {
      let pending = conversation.last_seq - conversation.indexed_seq;
      while (pending > 0 && budget > 0) {
        const indexed = await catchUp(conversation.conversation_id, budget);
        if (indexed === 0) break;
        pending -= indexed;
        budget -= indexed;
      }
    }
    // Check lag only against the initial watermark so concurrent appends during sync
    // do not fail a search that already caught up to its snapshot.
    const left = (await behind(target)).reduce((sum, row) => {
      const watermark = watermarks.get(row.conversation_id);
      if (watermark === undefined) return sum;
      return sum + Math.max(0, watermark - row.indexed_seq);
    }, 0);
    if (left > 0) {
      throw new TypeError(
        `Event search: the index is ${left} events behind after indexing ${maxSyncEvents - budget}; search again to continue`,
      );
    }
  };

  return {
    async prepare(request) {
      await host.read(async (session) => {
        await refuseOtherSettings(session);
        // A term the `simple` parser reduces to nothing would drop out of the
        // conjunction and widen the search; it is refused instead.
        for (const term of request.terms) {
          const row = await session.get(
            `SELECT numnode(phraseto_tsquery('simple', ${fold('?')})) AS count`,
            [term],
          );
          if (CountSchema.parse(row).count === 0) {
            throw new TypeError('Event search query must contain searchable terms');
          }
        }
      });
      await sync(request.target);
    },
    async candidates(request) {
      return host.read(async (session) => {
        const query = request.terms
          .map(() => `phraseto_tsquery('simple', ${fold('?')})`)
          .join(' && ');
        const values: AgentSqlValue[] = [...request.terms];
        if (request.target) values.push(request.target);
        if (request.since) values.push(request.since);
        const rows = await session.all(
          `SELECT s.conversation_id, s.seq AS event_seq, s.occurred_at,
             ts_headline('simple', ${fold('s.body')}, q.query,
               'StartSel=[, StopSel=], MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "') AS snippet
           FROM ${index} s, (SELECT ${query} AS query) q
           WHERE s.document @@ q.query
             ${request.target ? 'AND s.conversation_id = ?' : ''}
             ${request.since ? 'AND s.occurred_at::timestamptz >= ?::timestamptz' : ''}
           ORDER BY ts_rank_cd(s.document, q.query) DESC, s.occurred_at DESC, s.seq
           LIMIT ? OFFSET ?`,
          [...values, request.limit, request.offset],
        );
        return rows.map((row) => SearchRowSchema.parse(row));
      });
    },
  };
}
