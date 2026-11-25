---
title: "ADR 0315: The agent event search on Postgres is a tsvector index kept beside the events"
description: "createAgentEventSearch gets a Postgres backend: a tsvector ('simple') per event in its own table, indexed per conversation when a search needs it rather than inside appendEvent, matched per word with phraseto_tsquery joined by &&, with a bounded document size, a halving fallback past the tsvector limit, a bounded indexing budget per search, and diacritics preserved unless the unaccent extension is chosen."
type: decision
status: accepted
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0315: The agent event search on Postgres is a tsvector index kept beside the events

Serves **I8**, **I10** and **I13**. Extends [ADR 0314](0314-postgres-agent-store-and-one-sql-for-two-dialects.md).

## Context

The event search answered on SQLite only, from an FTS5 table filled by a trigger on the event table. On Postgres the nearest equivalent is a `tsvector` with the `simple` configuration; `pg_trgm` and `ILIKE` search substrings, which is another semantics. Two traps: `to_tsvector` refuses a document whose vector passes 1 MiB (`54000`), which dense distinct tokens reach from about half that much text, and a whole-query `phraseto_tsquery` turns a multi-word request into an exact phrase — the defect FTS5 searching already had and lost.

## Decision

1. **One factory, a backend per database.** `createAgentEventSearch({ host })` splits the query into words once (`extractSearchTerms`: a word without a letter or digit is punctuation, none left is a refusal, more than 64 is a refusal) and pages candidates from the backend the host names, so the requester's own matches cannot starve behind a neighbour's on either.
2. **The Postgres index is a table of its own**, `<prefix>_event_search` (conversation, seq, time, indexed text, `tsvector`, GIN), with `<prefix>_event_search_state` recording how far each conversation is indexed. It is filled when a search needs it, per conversation in the store's write transaction, never inside `appendEvent`: an append that failed because of its search index would lose an event to an optional feature.
3. **Bounds.** `maxIndexedChars` (65 536) characters of each payload are indexed; a document still past the `tsvector` limit is indexed again from half as many, in a savepoint, down to none. `maxSyncEvents` (10 000) bounds the indexing one search does: a search further behind indexes that many and refuses with how far, instead of answering from an index that has not seen the rest.
4. **Matching.** Each word is a `phraseto_tsquery('simple', word)`, joined by `&&`; a word the parser reduces to nothing is refused rather than dropped from the conjunction. Ranking is `ts_rank_cd`, then time; snippets are `ts_headline` with the FTS5 markers `[` `]`.
5. **Diacritics** are preserved by default. `diacritics: 'unaccent'` folds them as FTS5 does, through the `unaccent` extension, which the database must already have — the store does not install extensions, and refuses rather than quietly preserving. The choice is recorded with the index, and a search with the other choice refuses it.

## Divergences from SQLite, measured

| Query against `well-known café` | SQLite FTS5 | Postgres `simple` |
|---|---|---|
| `well`, `well-known` | found | found |
| `wellknown` | not found | not found |
| `cafe` | found | found only with `unaccent` |

Ranking and snippet text differ by engine; results, order of words and refusals do not.

## Consequences

- One suite (`agent-runtime-event-search-backends.test.ts`) runs on both stores. Its controls: without the halving fallback a dense document past the limit fails to index; a whole-query phrase turns the multi-word case red; without the per-search budget the catch-up case never refuses.
- A database without `unaccent` cannot have diacritic folding, and says so.
