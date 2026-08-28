---
title: "ADR 0128: SQLite runtime storage is a leaf adapter"
description: "One normalized mapping serves Bun and Node built-in SQLite bindings without leaking either runtime module into the neutral agent runtime."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0128 — SQLite runtime storage is a leaf adapter

## Context

The public `AgentRuntimeStoreDriver` makes database ownership explicit, but an
embedded durable runtime otherwise has to repeat the same head, run, admission,
history and recovery mapping. SQLite is available in both supported runtimes
through different built-in modules: `bun:sqlite` and `node:sqlite`. Importing
either from the neutral runtime would make the other runtime fail at module
resolution.

A synchronous connection also has a lock hazard. If one async transaction holds
a write lock while its callback yields, a second synchronous writer on the same
JavaScript thread can block that thread waiting for the lock. The first callback
then cannot resume to release it. A positive busy timeout only bounds the hang;
it does not make progress safe.

## Decision

Ship one normalized SQLite implementation behind two leaf entrypoints:
`stitchkit/agent-runtime/sqlite/bun` and
`stitchkit/agent-runtime/sqlite/node`. The shared implementation accepts a
minimal synchronous SQLite boundary; the leaves adapt Bun's `Database` and
Node's `DatabaseSync`. Neither built-in module enters
`stitchkit/agent-runtime`, its browser entrypoint or the other runtime's leaf.

The adapter owns only tables prefixed `stitchkit_agent_runtime_` and records its
schema version in its own metadata table. It does not use SQLite `user_version`,
inspect application tables or repair an unversioned partial Stitchkit schema.
Initialization is additive for a fresh database and refuses an unknown version.

One adapter instance serializes transactions. Each leaf configures
`busy_timeout = 0`, so a competing connection fails immediately with SQLite's
lock error instead of blocking the JavaScript thread. The application may retry
that explicit failure with its own bounded policy. `close()` first refuses new
operations, drains the instance queue and then closes the owned connection.

## Consequences

- Bun uses its built-in SQLite binding; Node requires a runtime that provides
  `node:sqlite` (Node 22.5 or newer). No optional package is installed.
- Durable state, idempotency, queue priority, terminal evidence, compaction and
  recovery use the existing reducer and public conformance contract.
- Two writers may contend, but contention fails promptly and never reports a
  false commit. Cross-process retry and scheduling remain application policy.
- The adapter proves process-state durability, not exactly-once external
  effects. Product rows and transactional outboxes remain application-owned.
