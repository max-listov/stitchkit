---
title: Absolute application operational projection
description: Expose sanitized lifecycle and stage-count snapshots through bounded absolute-state sinks.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related: docs/backlog/done/2026-08-23-managed-application-kernel.md
---

# Absolute application operational projection

## Зачем

Consumers separately maintain lifecycle counters and stage progress, while observers must recover
from missed events. A canonical process-local projection must publish full immutable snapshots
rather than lossy increments, without becoming a business-state or provider-payload store.

## Результат

- Typed activity stages aggregate active/queued/completed/failed counts without exposing item IDs.
- Snapshots carry stable identity, process epoch, revision, captured time and changed time.
- Subscribers receive the current absolute value and later replacements through an isolated
  latest-value/coalescing sink.

## План

- [x] Define declaration-time bounded activity/stage IDs and lifecycle event schemas with no runtime
      text, payload or metadata bag.
- [x] Implement anonymous internal activity tokens, typed stage transitions and terminal idempotency;
      token IDs never serialize.
- [x] Implement a dedicated latest-value sink: one write in flight, one replaceable pending snapshot,
      ordered revisions, replay-current, close-boundary final delivery and status containing
      coalesced/failure/last-delivered revision.
- [x] Connect application/resource/schedule facts without copying their mutable state.
- [x] Keep lifecycle events separate from canonical snapshots: observers never reconstruct state.
- [x] Cover revision 1 blocked while 2…100 coalesce to 100, missed/slow/failing subscribers,
      replay-current, process restart epoch, terminal-twice and PII/provider-payload absence.

## Acceptance

- [x] Any delivered snapshot is independently usable without prior events.
- [x] Stage totals remain internally consistent under concurrent transitions.
- [x] Only declared bounded IDs enter snapshots; arbitrary runtime text, secrets, tenant IDs and
      provider updates cannot enter the schema.
- [x] Sink failure cannot fail application work or corrupt canonical state.

## Что сделано

### Projection и delivery

- [x] `packages/core/src/application/activity.ts` owns bounded activity declarations, anonymous
      tokens, immutable absolute snapshots, epochs and revisions.
- [x] `packages/core/src/application/latest-sink.ts` implements one in-flight write plus one
      replaceable latest value with isolated delivery failures.
- [x] `packages/core/src/application/events.ts` and `packages/core/src/application/health.ts` expose
      sanitized lifecycle facts and canonical readiness without reconstructing mutable state.

### Проверка

- [x] Регрессия: packages/core/tests/application-activity.test.ts::delivers a blocked revision 1 followed by only the latest revision 100; packages/core/tests/application-activity.test.ts::uses a new epoch for a replacement process projection; packages/core/tests/application-activity.test.ts::tracks typed stage transitions as immutable absolute snapshots.
- [x] Регрессия: packages/core/tests/application-activity.test.ts::replays current state and coalesces a slow subscriber without blocking mutations; packages/core/tests/application-activity.test.ts::rejects unbounded declarations and schemas reject arbitrary operational data.
- [x] Регрессия: packages/core/tests/application-events.test.ts::application lifecycle events are sanitized and sink failures stay isolated; packages/core/tests/application-health.test.ts::application health handler reports readiness without exposing a second state model.
