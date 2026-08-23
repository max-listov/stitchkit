---
title: "ADR 0100: The agent store reducer owns runtime transitions"
description: Applications provide one coherent transaction driver; Stitchkit owns run, admission and history-mutation invariants.
type: decision
status: accepted
created: 2026-08-22
updated: 2026-08-23
---

# ADR 0100 — The agent store reducer owns runtime transitions

## Context

ADR 0098 put eight aggregate operations behind `AgentRuntimeStore`. That kept
the runtime ORM-neutral, but every durable adapter still had to reproduce the
reference state machine: revisions, ownership, collisions, idempotency,
coalescing, terminal mapping and contiguous compaction. Storing the whole
`AgentSnapshot` as JSON avoided that reducer only by duplicating canonical
message history already present in application tables.

Separate state and history callbacks are not enough. Independent reads can
assemble a torn snapshot, and a state CAS followed by an unrelated history
write can commit half a transition.

## Decision

`createAgentRuntimeStore(driver)` owns all runtime transitions. A driver owns:

- an adapter-created `transaction(work)` boundary;
- state and history loads using the same opaque transaction token;
- one version-checked state CAS;
- application-row mapping for a typed history mutation;
- a bounded, paged recoverable-run scan.

The original persistence shape stored version, runs and complete admission identities in
`AgentStoredState`. ADR 0101 replaces that lifetime aggregate with a bounded head and normalized
records while retaining this reducer ownership. Messages remain canonical application rows. A winning CAS
and its history mutation execute inside the same transaction callback; an
exception rolls both back. The driver contains no run-state switch, revision
arithmetic, coalescing, terminal or collision policy.

`createMemoryAgentRuntimeStore()` is implemented through this same factory.
Third-party adapters can execute the public black-box conformance helper from
`stitchkit/testing`. The repository carries an executable Prisma/PostgreSQL
reference fixture, but Prisma is not a runtime dependency, peer or public
adapter commitment.

Admission delivery uses a canonical committed input and assigned run plus a
separate `pending` assistant projection. It does not pretend that a pending UI
placeholder is already an `AgentMessage` in history. Publisher callbacks remain
post-commit, at-most-once notifications: exactly-once delivery still requires
an application outbox in the same database transaction.

Recovery scans are bounded. Queued work may resume by default; an acquired run
is skipped unless application policy supplies replay-safe or stale-owner
evidence. Abandoning a run atomically materializes its terminal assistant row.

## Consequences

- Applications write transaction plumbing and row codecs, not a second engine.
- State/history consistency is part of the driver contract and can be tested.
- Existing stores must persist the full admission identity, not only `runId`.
- Full snapshots are assembled only from one coherent transactional read; no
  second durable history blob is required.
- Post-commit events remove projection rereads but do not claim outbox delivery.
