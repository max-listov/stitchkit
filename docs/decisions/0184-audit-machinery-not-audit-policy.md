---
title: "ADR 0184: The audit layer ships the filter and the spool, and stays optional"
description: "A ready-made mutation filter and a spooled sink become framework machinery; making audit mandatory at startup was considered and rejected on a measurement."
type: decision
status: accepted
created: 2026-09-15
updated: 2026-09-15T09:26+07:00
---

# ADR 0184 — Audit machinery, not audit policy

## Decision

`stitchkit/observability` gains two pieces of machinery:

- **`auditChanges`** — a `RequestEvent` predicate: drop `GET`, `HEAD` and
  `OPTIONS`; keep everything else; keep `401` and `403` whatever the verb was.
  An unrecognised verb is kept. One predicate for HTTP, MCP and agent calls,
  because a tool call carries its contract verb in `httpMethod` (→ ADR 0030).
- **`createSpooledSink`** — writes the row to a local append-only file before
  offering it to the store, marks it delivered once the store took it, and
  replays what a previous process left unmarked. At-least-once; the store must
  be idempotent on the record key (the `spanId` by default).

**Audit remains opt-in.** `createHandler` and the tool mounts are unchanged: a
project that does not audit still never imports this entrypoint (→ ADR 0012).

## Why the machinery

Measured across six consuming projects that do audit, the same two pieces had
been written six times and had diverged: one audited only tool calls, one
excluded `/mcp`, two disagreed on `OPTIONS`, and five lost the event whenever
the store was unreachable. Nobody decided any of that. They each started from the
one form the `httpMethod` doc gives — `(event.httpMethod ?? event.method) !==
'GET'` — which is right about `GET` and silent about the two other verbs that
change nothing.

That is the duplicated observability layer ADR 0012 exists to end, one level
further in.

## Rejected: audit on by default

A proposal (base, 2026-09-14) would have made a decision about audit mandatory:
`createHandler` and every tool mount accept either an observer or an explicit
refusal with a reason, and a server with neither fails to start. It came from a
real incident — an operator changed a setting, and three days later nobody could
name who, because that application had no sink and the bus log had rotated.

Rejected on the measurement it rested on. The proposal counted
`createObservability` across sixteen consumers, found six, and read the other ten
as forgetting. Re-measured on the eight consumers visible from the framework's
own machine, the split is perfect and it is not forgetting: **all four projects
without a sink call `createHandler` zero times.** They have no HTTP surface to
audit. Counting the sink across all consumers answers "how many wire an audit",
not "how many should have and did not" — the denominator does not contain what it
is read as containing.

Four of the sixteen live on another machine and were not measured here, so the
original six-of-sixteen is neither confirmed nor refuted; only the local slice is.

Beyond the number: a mandatory decision moves policy into the core, which is the
line ADR 0012 draws. A required `audit: false, reason: '…'` becomes a line
pasted unread, which is a ritual rather than a journal — and a framework that
demands a declared position on each of its subsystems is unusable by the fifth
one.

The frozen task carries the defrost condition: a measurement that finds a project
with an HTTP surface and no sink — forgetting rather than an absent subject — or
a second unanswered "who changed this" in an application that has a server.

## Limits

`createSpooledSink` is one process, one file. Two processes on one path replay
each other's records: harmless against an idempotent store, wasteful always.
Exactly-once would need the spool and the store to share a transaction; they do
not, and an audit layer that claimed otherwise would be lying about the one thing
it exists to be trusted on.
