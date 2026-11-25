---
title: "ADR 0304: Sync is a client half, a server half and the app's own merge"
description: Offline-first sync ships as stitchkit/sync (pure, browser and Hermes) and stitchkit/sync/postgres (server leaf inside the app's transaction), with SQLite migrations in stitchkit/application; entities and merge stay with the app, an unknown outcome is retried within a bound and then held.
type: decision
status: accepted
created: 2026-11-22 09:19 +08:00
updated: 2026-11-25 00:11 +08:00
---

# ADR 0304 — Sync is a client half, a server half and the app's own merge

Serves **I5**, **I8**, **I9**, **I10** and **I11**. Builds on [ADR 0128](0128-sqlite-runtime-store-is-a-leaf-adapter.md),
[ADR 0144](0144-generic-application-primitives-declare-facts-not-infrastructure.md) and
[ADR 0207](0207-session-lifetimes-fence-client-work.md).

## Context

Two consuming projects build offline-first clients — a desktop runtime on `bun:sqlite`, a phone on
`expo-sqlite`, a cloud on Postgres — and each wrote the same machinery around its own domain: an
outbox that decides what leaves next, pending local edits kept on top of remote rows, deletes that
win until acknowledged, a cursor session that pages, catches up and retries, a ledger so a repeated
change is not applied twice, version numbers for a change feed, and a SQLite migration ledger. One
of them already ships it, tested; the other was writing it again.

A first plan put all of it behind one entrypoint with its own session machine. Validation against
this repository and against the shipping consumer changed five things: a server store needs
`node:crypto`, which breaks the browser and Hermes promise of a client entry; a session machine
duplicated `createSessionScope` and `createSessionCredentials` (ADR 0207); a SHA-256 migration
checksum would orphan every installed database of the consumer, which uses FNV-1a; versions must be
allocated by every writer of a stream inside its transaction, not only by the push path — the
consumer hands them out from 26 places, some outside a transaction; and renaming the wire's
`terminal_rejected` would break released clients.

## Decision

Three parts, each with one owner.

**`stitchkit/sync`** (browser, Hermes, Bun; no driver, no domain): `decideOutboxBatch`, the overlay
of pending edits, tombstones and full-snapshot cleanup, `createSyncSession`, and the wire. The
session is the consumer's, ported with its test suite: one session at a time, paging by a cursor that
must grow, catch-up, a deferred or server-forced full snapshot, the same page again after a dropped
transport, a generation check after every wait, synchronous or asynchronous ports. Its request and
page header are neutral (`{ sessionId, requestId, after, full }`); the app maps them to its wire. The
pause between failed sessions is a `BackoffPolicy` with documented defaults.

**The outbox orders by keys, and a refused row holds its chain.** A row names the keys it depends
on (by default its entity) and is ripe when no earlier unresolved row shares one; a waiting row holds
all its keys, so a row behind it never overtakes it through a key it does not share with the head.
A row set aside — quarantined, or held for a person — holds its keys too, by default: the rows after
it were made on top of it, and one that was to take its version as a base carries none, so sent
alone it writes over another device unseen. The release is a person's: retry or discard. An app
whose rows stand alone names `setAside: 'releases-keys'`, and `rejected: 'acknowledge'` for its
results; both defaults are the side that loses nothing. A row that has left is never replaced
(`replaceableOutboxRow`): its id stands for one content. What folds into what, and how a conflict
merges the rows after it, are the app's — that is the meaning of its operations, which keys alone
do not carry.

**An acknowledged change stays on top until the cursor covers it.** A result names the version the
change got; the row is `confirmed` until the saved cursor reaches it, so a page read before the
answer never shows the older value. The server store answers the newest version the change's
transaction took, and a replay the same one, from its ledger.

**A full snapshot may be paged by token, and a stale cursor reloads one.** A server that pages its
snapshot by kind and id returns an opaque `nextToken` and lists only rows at or below the version the
snapshot began at; the session saves the token with the version, continues from it after a restart,
and ends with that version as its cursor. A cursor older than the feed the server keeps is refused
with `stale_cursor`, and the session loads a full snapshot at once. After every full snapshot the
session asks the app to rebase its pending changes (`rebasePending`) before the cursor is saved;
the outbox is never cleared by a reload.

**The outcome vocabulary is open.** `applied | replayed | terminal_rejected | retryable_failed` are
the names already on the wire; `code` is any string. Each result is read on its own: a client that
validated the answer as a closed list dropped every acknowledgement in it the day a server sent a
value it did not know. An unknown outcome is `retryable_failed` — the server's ledger makes the
repeat safe — up to a bound, after which the row is held for a person to see instead of retried by
guess, as ADR 0144 asks of a fact the client cannot interpret.

**`stitchkit/sync/postgres`** (server leaf): the store never opens a connection; the app hands it its
`transaction` and a way to run one statement, so a change and the app's own writes commit together.
A scope's counter is one row updated by a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which
holds the row lock until commit: versions commit in their order, so a reader that saw 7 never finds a
6 committed behind it. A sequence, or a number taken in a transaction of its own, does not have that
property; the integration test proves both negative controls against a live database. The ledger is
`UNIQUE(scope, replicaId, changeId)` with a fingerprint of the content and the stored outcome: a
repeat gets the outcome without running, the same id with other content is refused, a rejection is
recorded and a throw is not. The feed holds one row per entity, so it grows with the entities, not
the edits; the ledger is pruned by age (I10). `checkSyncStore` is the rule set every store keeps,
the memory store included.

**SQLite migrations live in `stitchkit/application`**, beside the SQLite keyspace backend: the
consumer's `schema_migrations` ledger and FNV-1a checksum, so its databases read as theirs; a pure
plan that checks every applied migration first; a synchronous runner that never awaits inside a
transaction (ADR 0128) and a promise-only one for drivers that have nothing else.

**Not here.** What an entity contains and how a conflict merges stay with the app. Refreshing a
session before its token ends extends `createSessionCredentials` ([ADR 0306](./0306-proactive-session-refresh-and-deferred-write-recovery.md)); the
connection state a screen shows is the app's projection of `SessionScope`, credentials and transport.

## Consequences

- A consumer replaces its own outbox, overlay, session and migration runner with these, keeping its
  wire and its tables; the session's test suite is the consumer's, on the neutral shapes.
- A server keeps its tables; the three sync tables are added by `postgresSyncStoreDdl` or
  created on first use. A scope that already has versions seeds its counter row once.
- Two concurrent pushes of the same new change both run; the second fails the unique key, returns
  `retryable_failed`, and its repeat is `replayed`.
- A full snapshot saves the version its first page named, not its last, and catches up from there:
  its pages list live rows only, so an entity deleted after its page went by would otherwise never
  reach the client. The consuming app's own session saved the last page's version; this one
  deliberately does not.
- A rejection rolls back what `apply` wrote and is recorded in a transaction of its own; a throw is
  not recorded, and its cause goes back to the server in `failures`, never to the client.
- A row whose outcome this client does not know is held after `holdAfter` returns, as status
  `held`, which the outbox skips and which holds its keys like a quarantined row; a known failure is
  held after `holdAfterFailures`, when the app counts them.
- The client half needs no server of ours: an app with its own journal answers in the same wire
  (proved against one in the tests), and the client entry never imports the server store.
- Both entrypoints start evolving (ADR 0103).
