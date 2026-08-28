---
title: SQLite persistence for the public agent runtime store contract
description: Supply a verified SQLite driver or executable reference over existing transactional runtime primitives.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
---

## Why and evidence

docs/guide/agent-runtime.md currently instructs applications to supply one
transaction driver to createAgentRuntimeStore. The executable database reference
is examples/agent-store-prisma/adapter.ts; memory persistence is process-local.
packages/core/src/agent-runtime.ts exports the driver contract and memory reference,
not a SQLite adapter.

An embedded local harness needs durable SQLite admission/run/history storage
without repeatedly implementing generic SQL mappings and lifecycle. This is an
enhancement, not a defect in the documented application-owned driver boundary.
The owner must decide optional adapter vs executable maintained reference and record
that decision. Do not silently move application domain schema into the framework.

## Result

A supported, tested SQLite composition with exact public API, schema/migration
ownership, lifecycle and runtime support matrix. Reuse AgentRuntimeStoreDriver,
createAgentRuntimeStore, existing schemas and conformance suite.
Product titles, project links, attachments/files, provider secrets and UI state remain
application-owned. A JSON value inside a validated SQL record is not a second JSON store.

## Concurrency case to prove

An asynchronous store transaction can hold a SQLite write lock while awaiting a
callback. A synchronous writer on the same JavaScript thread can then block that
thread waiting for the lock, preventing the first transaction from resuming.
A busy timeout alone does not establish safe progress.

Provide a deterministic contention test with barriers, not arbitrary sleeps.
Choose a documented transaction execution/worker ownership model so this case either
makes progress or fails explicitly without deadlock or a false committed result.
Do not mandate a worker wrapper if the driver design avoids the hazard directly.

## Plan

- [x] Review the current driver contract, memory implementation, Prisma reference and tests;
  write ADR for adapter/reference placement and supported SQLite runtime APIs.
- [x] Implement head CAS, runs/indexes, admissions/idempotency, history load/apply and
  scanRecoverable with one transaction context and rollback on failure.
- [x] Define schema versions/migrations and initialization/close ownership; do not apply
  destructive migration to an unknown database or copy an application's schema.
- [x] Preserve normalized record identity, execution/priority ordering, retry receipts and
  retained terminal evidence after history compaction.
- [x] Exercise competing connections, duplicate input, stale revisions, rollback,
  recoverable pagination and A → urgent C → pending B after reopen.
- [x] Exercise ordered message parts, compaction usage including earlier attempts,
  interrupted/failed/context_overflow terminals and tool evidence.
- [x] Test the same-thread contention case and close with outstanding operations.
  Worker failure, if a worker is used, rejects outstanding calls rather than hanging.
- [x] Run existing public store conformance against SQLite; extend only meaningful missing cases.
  Prove reopen after process termination without claiming external effects are exactly-once.
- [x] Keep runtime-specific SQLite imports behind optional entry points; browser/root imports
  remain safe. State actual Bun and Node support with packed-consumer evidence.
- [x] Document setup, migration and recovery, application projection integration/atomicity,
  limitations and ownership. Full verify, exact-SHA CI and verified package release
  when publishing an adapter; for reference-only delivery provide executable source and gate evidence.

## Acceptance

- [x] Durable canonical state survives reopen; no in-memory or JSON fallback masks DB failure.
- [x] CAS/idempotency/queue priority/history semantics match existing store conformance.
- [x] Contention, rollback, shutdown and failure paths have deterministic evidence.
- [x] Application code does not need to copy runtime transition arithmetic.
- [x] Returned API/version and driver support are explicit; no private imports or hidden globals.

## Что сделано

- `packages/core/src/agent-runtime/sqlite.ts` implements the normalized transactional mapping;
  Bun and Node leaf adapters expose it through `stitchkit/agent-runtime/sqlite/bun` and
  `stitchkit/agent-runtime/sqlite/node`. ADR 0128 records ownership and schema boundaries.
- `packages/core/tests/agent-runtime-sqlite.test.ts` —
  `passes the public store conformance suite and closes its connection` covers the shared CAS,
  admission, history, recovery and terminal contract; `survives close and reopen without a memory
  or JSON fallback` proves durability.
- The same file's `fails competing same-thread writers promptly and permits a deterministic retry`
  uses an explicit transaction barrier; `restores acquired and urgent queue order after reopen`
  proves `A → urgent C → pending B`; `rolls back every normalized row when a transaction fails
  after history apply` proves atomic rollback.
- The same file's `close drains accepted operations and then refuses new work` and `refuses unknown
  and partial owned schemas without touching application tables` cover lifecycle and migration safety.
- Node packed smoke opens and closes the `node:sqlite` entrypoint; the optional-peer matrix covers
  both runtime leaves, while root and browser surface checks keep SQLite imports isolated.
- `docs/guide/agent-runtime.md` and `docs/api/reference.md` document setup, schema ownership,
  contention, recovery, projection atomicity and support limits. `bun run verify` passed the complete
  local release gate; release `0.68.8` carries the result.
