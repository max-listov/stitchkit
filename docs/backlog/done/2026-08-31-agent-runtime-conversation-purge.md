---
title: Safe durable conversation deletion through a public runtime capability
description: Provide an owner-supported conversation purge contract without consumer SQL or partial runtime deletion.
type: task
status: done
created: 2026-08-31
updated: 2026-08-31
completed: 2026-08-31 13:28 +00:00
---

## Problem

The published 0.70.5 runtime store exposes admission, checkpoint, terminal commit and recovery,
but no public operation to delete a durable conversation. Optional history/catalog readers and
local attach do not remove persisted messages, runs, admission identities or conversation heads.
A consumer cannot implement complete deletion without depending on private framework tables.

## Requested result

An optional, typed, public conversation deletion capability with documented lifecycle semantics,
implemented for official memory and SQLite stores (Bun and Node). Preserve source compatibility
for custom stores that do not implement deletion. Unsupported stores must fail explicitly.

## Acceptance

- [x] Active/queued runs and controller leases cannot write into a deleted conversation. Define
  the required quiescence/fence and prove concurrent submit/checkpoint/recovery races.
- [x] Messages, runs, admissions/idempotency state, heads and owner-derived indexes are covered;
  unrelated conversations are unchanged. Define tombstone/ID reuse and repeat-delete semantics.
- [x] SQLite deletion is atomic; injected failures leave a recoverable, documented state rather
  than a partly removed conversation. Reopen/recovery cannot resurrect deleted data.
- [x] Consumer-owned metadata and external attachments remain consumer responsibility, with a
  documented composition order and retry contract; the library does not traverse arbitrary paths.
- [x] Tests exercise both official SQLite adapters, memory storage and unsupported capability.
- [x] Public exports, declarations and versioned release notes identify the accepted API.

No direct consumer SQL, hidden adapter field access, whole-store reset or deletion of live DB files.
This task requests a primitive, not a new application, provider run or automatic storage backup.

## Contract and implementation plan

- Optional `AgentRuntimeStore.purgeConversation`, with `purgeAgentConversation` as the public
  capability dispatcher. Missing capability returns `unsupported`; custom stores remain valid.
- States: absent or quiescent → purged; queued/running/interrupt-requested → active refusal;
  purged → already-purged. An optional expected snapshot version refuses stale deletion intent.
- Purge atomically removes all runtime-owned records and reserves the ID in a payload-free
  tombstone. Purging an absent ID also reserves it, fencing an admission still in preflight.
- Every mutation checks the tombstone in the same transaction as its write. SQLite additionally
  fences older writers through table triggers; transaction lock contention fails without effects.
- Tombstones are not conversations or history. Existing read APIs return empty/absent records;
  stale leases can observe emptiness but cannot write. A new conversation needs a fresh ID.
- Consumers first close their own admission/attachment ingress, settle or explicitly abandon runs,
  then purge; only after successful purge may they retry cleanup of their own metadata/files.
  No claim of erasing backups, SQLite free pages or external logs is made.
- Cover reducer races, all runtime mutation paths, both SQLite bindings, rollback/reopen,
  controller/preflight races and packed public exports. Publish core only after release gates.

## Что сделано

- [x] Public capability: `packages/core/src/agent-runtime/purge.ts`, `store-purge.ts`, `store.ts`
  and `packages/core/src/agent-runtime.ts` expose validated purge, refusal results and the optional
  normalized driver capability; existing mutation result unions and custom stores are unchanged.
- [x] Memory and SQLite: `store-driver.ts`, `sqlite.ts`, `sqlite-purge.ts` atomically remove
  owned records and retain only ID fencing. `packages/core/tests/agent-runtime-purge.test.ts` cases
  `removes compacted and terminal history, isolates other conversations and reserves IDs`,
  `refuses queued, running and interrupt-requested runs without changing data`,
  `fences every stale mutation after deletion, including checkpoint and recovery`,
  `refuses stale versions, then serializes both admission/purge orders` and
  `a delayed checkpoint cannot write after terminal commit and purge` cover both adapters.
- [x] Failure/reopen proof: `packages/core/tests/agent-runtime-purge-sqlite.test.ts` cases
  `SQLite purge rolls back after each deletion and commit failure, then survives reopen`,
  `competing SQLite connection cannot submit through an in-flight purge transaction` and
  `additive v1 initialization fences an already-open pre-purge writer` verify rollback, row-level
  removal, isolated application data and legacy-writer fencing.
- [x] Runtime proof: `packages/core/tests/agent-runtime-purge-lifecycle.test.ts` cases
  `purge fences a runtime submission paused in provider preflight`,
  `a recovery decision paused across abandonment and purge cannot requeue or execute` and
  `an attached controller lease cannot recreate a purged conversation` exercise actual runtime
  and headless control paths. `runtime.ts` also observes the accepted projection of a rejected
  admission without changing the rejection seen by callers.
- [x] Unsupported proof: `packages/core/tests/agent-runtime-purge.test.ts` case
  `unsupported stores remain source-compatible and fail explicitly without mutation`.
- [x] Packed proof: `packages/core/scripts/consumer-lane/fixtures/node/src/conversation-purge.mjs`
  passes under both real Bun and Node SQLite bindings, including rollback followed by reopen;
  paired `conversation-purge.ts` names public declaration exports. Both runs are required by
  `packages/core/scripts/consumer-lane/run.mjs`. Focused suites, workspace typecheck, build and
  the full packed consumer lane pass.
- [x] Contract and boundaries: `docs/guide/agent-runtime.md`, `docs/api/reference.md`, ADR 0138
  and `CHANGELOG.md` document tombstones, idempotency, safe consumer cleanup order and logical
  deletion limits. Core-only publication belongs to the enclosing exact-tree release train;
  the tag/registry receipt, not this implementation record, proves publication.
