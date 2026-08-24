---
title: Process-local managed schedules
description: Add deterministic periodic managed resources with explicit bounded overlap and shutdown drain.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related: docs/backlog/done/2026-08-23-managed-application-kernel.md
---

# Process-local managed schedules

## Зачем

Periodic services repeatedly own delayed first runs, intervals, overlap flags, error catches and
manual shutdown. Stitchkit can own that ephemeral timer machinery without owning durable jobs,
leases, retries or replica coordination.

## Результат

- `createManagedSchedule` is an ordinary application resource.
- `skip`, `queue-one` and bounded `parallel` have deterministic absolute snapshots.
- Future ticks cancel before drain; admitted executions share the application shutdown signal.
- Construction/start validates and prepares the schedule; ticks arm only on application activation
  after top-level readiness.

## План

- [x] Define schedule config/status schemas, fixed-rate monotonic cadence, wall-clock snapshots and an
      injectable timer boundary; `everyMs` is positive and `startAfterMs` nonnegative.
- [x] Use a discriminated overlap config so only parallel accepts/requires `maxConcurrent`.
- [x] Implement post-ready activation, initial delay, periodic ticks and all overlap policies.
- [x] Add `continue | stop-schedule` error policy and isolated error callback.
- [x] Specify that queue-one's pending successor is not admitted and is discarded at shutdown;
      bounded parallel overflow skips instead of hiding a queue.
- [x] Cover shutdown before readiness, stop before initial delay, callback/shutdown same-turn races,
      queued successor collapse, failures, callback reentrancy, no post-close tick and bounded drain
      with fake time.

## Acceptance

- [x] `queue-one` stores at most one successor and `skip` never overlaps.
- [x] `parallel` cannot exceed its declared concurrency.
- [x] Shutdown cancels future ticks and waits only admitted work.
- [x] `stop-schedule` cancels future/queued ticks but observes already admitted executions.
- [x] No durable cursor, retry, cron/timezone or leader-election semantics exist.

## Что сделано

### Runtime

- [x] `packages/core/src/application/schedule.ts` owns fixed-rate monotonic cadence, activation,
      overlap, cancellation, health, wall-time projection and the shared shutdown budget.
- [x] Schedule schemas and inferred public types live in
      `packages/core/src/application/schemas.ts`; the process-local/non-durable boundary is documented
      in `docs/guide/application-kernel.md` and `docs/architecture/application-kernel.md`.

### Проверка

- [x] Регрессия: packages/core/tests/application-schedule.test.ts::activates a zero-delay schedule only after the application is top-level ready; packages/core/tests/application-schedule.test.ts::never arms when shutdown wins startup readiness; packages/core/tests/application-schedule.test.ts::keeps fixed-rate cadence and skips overlapping ticks.
- [x] Регрессия: packages/core/tests/application-schedule.test.ts::queue-one collapses ticks to the latest successor and discards it on stop; packages/core/tests/application-schedule.test.ts::parallel mode never exceeds maxConcurrent and skips overflow ticks; packages/core/tests/application-schedule.test.ts::drain cancels future work, awaits admitted work and respects the shared deadline.
- [x] Регрессия: packages/core/tests/application-schedule.test.ts::uses the application force budget for an abort-aware active execution.
