---
title: "ADR 0314: The agent store on Postgres, and one SQL implementation for SQLite and Postgres"
description: "Adds the evolving leaf stitchkit/agent-runtime/postgres, which owns its SERIALIZABLE transactions and their retries over the application's client; writes the store's driver members and every runtime companion once against an AgentSqlSession, with the dialect differences named in one interface; and gives both SQL stores a companion host the companions take instead of the SQLite connection."
type: decision
status: accepted
created: 2026-11-24
updated: 2026-11-24
---

# ADR 0314: The agent store on Postgres, and one SQL implementation for SQLite and Postgres

Serves **I5**, **I7**, **I8**, **I10** and **I15**. Extends [ADR 0128](0128-sqlite-runtime-store-is-a-leaf-adapter.md) and [ADR 0100](0100-agent-store-reducer-owns-transitions.md).

## Context

The agent store shipped on SQLite and as a Prisma example. A server application on Postgres copied the example — about six hundred lines of driver mechanics — or kept a store of its own beside the conformance kit. The runtime's companions (schedules, children, spills, projections, event search) took the SQLite handle and wrote through its raw connection, so they ran on SQLite only. A second SQL store would have needed a second copy of every companion and of the store's own SQL.

Two facts of Postgres shape the store. Under SERIALIZABLE a lost race surfaces as `40001` on any statement or on `COMMIT`, and the only cure is to run the whole unit again, which only the code that opened the transaction can do. And two serializable writers that each read `MAX(seq)` from their own snapshot both take the same next number.

## Decision

1. **Add the evolving leaf `stitchkit/agent-runtime/postgres`** (`browser: false`, no peer). `createPostgresAgentRuntimeStore({ transaction, query })` takes the application's transaction opener and a one-statement function, so Bun SQL, Prisma and `pg` fit without an adapter of ours. The store owns its transactions: the first statement of each is its isolation level (SERIALIZABLE for writes, a read-only snapshot for reads), and a `40001` or `40P01` — recognized by shape on the error or its cause chain, never by importing a client — runs the unit again with jitter. A broken connection on `COMMIT` is not retried. A transaction the application already used is refused (`25001`). This is the reverse of the sync store, which writes inside the application's transaction, and both are right for what they do.
2. **One SQL implementation for two dialects.** The store's driver members (ledger, history, events and archive, purge, reads) are written once against `AgentSqlSession` — `all`, `get`, `run` with `?` placeholders — and the Postgres session numbers them `$1…$n`. What differs is named in `AgentSqlDialect` and nowhere else: table names from a validated prefix, the message row id, a substring predicate, and the event counter (`MAX(seq) + 1` inside SQLite's exclusive write transaction; on Postgres one counter row per conversation advanced by `INSERT … ON CONFLICT DO UPDATE … RETURNING`, whose lock orders writers). Integers are read through one codec that takes a number, a string or a `bigint`, whichever the client returns.
3. **A companion host on both stores.** Each SQL store gives `host`: `transaction(conversationId, work)` checks the purge tombstone and hands the companion statements and the store's event append in one write transaction; `read(work)` is a read transaction. Every companion takes the host, so a row and its event commit together on either database, and the limits that companions enforce (active children, active schedules) are counted inside the transaction that records the row, which holds them between processes.
4. **The schema is versioned and never repaired.** Version 1 is created under a transaction-scoped advisory lock on first use, or checked when migrations own it (`createTables: false`, `postgresAgentRuntimeStoreDdl(prefix)`). Another version, or a schema with tables missing, is refused. Identifiers and timestamps are `TEXT COLLATE "C"`, so an archive round-trips byte for byte; a record id with NUL, which Postgres cannot store, is refused by the schema on every store.
5. **Prisma stays an example of connecting**, not a second implementation: `examples/agent-store-prisma` is the official store over `$transaction` and `$queryRawUnsafe`, and passes the same conformance kit in the Postgres lane.

## Consequences

- A Postgres application gets the store and every companion from the package, proven by `runAgentStoreConformance` with a conflict at `COMMIT` through Bun SQL and through Prisma, and by negative controls: without the retry recognizer twenty concurrent appends fail, under READ COMMITTED five concurrent first admissions collapse into one version and a due schedule fires twice, and without the advisory lock two first starts collide.
- A fix to a store query or a companion is a fix on both databases; the SQLite store's tests exercise the same code the Postgres store runs.
- The companions' reads are promises, and their factories take the host instead of the SQLite handle — a breaking change of `stitchkit/agent-runtime` recorded with its migration. The event search has a backend per database behind one factory ([ADR 0315](0315-postgres-event-search-tsvector.md)).
