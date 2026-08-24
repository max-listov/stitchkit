---
title: Managed application kernel contract
description: Define the process-local lifecycle, resource graph, readiness, admission and bounded shutdown contract.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related: docs/backlog/done/2026-08-23-managed-application-kernel.md
---

# Managed application kernel contract

## Зачем

Consumers independently compose startup order, partial rollback, required readiness, operation
admission and shutdown fan-out. Existing managed server and signal primitives solve only individual
resources. A generic application handle must compose them without inventing HTTP counters for
non-HTTP resources or creating a second process-signal machine.

## Результат

- `stitchkit/application` exports Zod-first lifecycle/health/resource snapshots.
- `createApplication` owns one deterministic DAG lifecycle and one absolute shutdown deadline.
- Generic `ShutdownTarget<TResult>` keeps existing server defaults source-compatible.
- Operations use idempotent admission leases and participate in application drain.
- Long-lived resources expose readiness separately from completion, and late failure updates health.
- `ApplicationShutdownResultSchema` reports application admission and per-resource cleanup truth
  without fake HTTP counters.

## План

- [x] Write ADR 0102 and synchronize Vision/decision index.
- [x] Generalize process-signal result generics without changing server behavior.
- [x] Define full application/resource transition tables, terminal restart prohibition and exact
      `shutdown()` behavior in `created`, `starting`, `ready`, `failed` and concurrent calls.
- [x] Define resource runtime handles with `ready`, optional observed `completion`, `activate`, health
      reporting, `stopAdmission`, `drain`, `close` and `force` boundaries.
- [x] Make every invoked `start()` rollback-eligible; `close()` must be safe after rejected/aborted
      partial startup, and cleanup errors must not skip remaining resources.
- [x] Implement schemas, fail-first DAG validation and declaration-order-stable topological ordering;
      reject duplicate/missing/cyclic graphs and required-to-optional dependencies.
- [x] Implement start, readiness, rollback, atomic admission, drain, close and force transitions.
- [x] Use `graceDeadlineAt` and `forceDeadlineAt` process-wide; force resources concurrently within
      the one remaining force budget.
- [x] Add managed-server and generic resource adapters.
- [x] Cover duplicate/missing/cyclic graphs, concurrent start/shutdown, rejected partial start,
      readiness rejection, late completion failure, rollback failure, optional degradation,
      second-signal force and idempotent leases.

## Acceptance

- [x] No resource starts before its dependencies.
- [x] Every attempted resource rolls back once, in reverse order, even when its own start rejects.
- [x] Required failure blocks readiness; optional failure is explicitly degraded.
- [x] Shutdown is one cached promise and stops admission before bounded drain.
- [x] `bindProcessSignals(app)` preserves the released force/escalation semantics.
- [x] Existing unparameterized `ShutdownTarget`, callback inference and binding promise remain
      `ShutdownResult`; application inference is `ApplicationShutdownResult`.
- [x] Managed-server adapter starts shutdown once with the application signal and awaits that exact
      promise; a repeated signal forces the first call rather than a discarded second call.

## Что сделано

### Contract и архитектура

- [x] Zod-first schemas, resource declaration and deterministic graph live in
      `packages/core/src/application/schemas.ts`, `packages/core/src/application/resource.ts` and
      `packages/core/src/application/graph.ts`.
- [x] Lifecycle, admission leases, rollback and shared grace/force deadlines are implemented in
      `packages/core/src/application/kernel.ts`.
- [x] Existing managed server and generic close/drain resources are composed through
      `packages/core/src/application/server-resource.ts` and `packages/core/src/application/resource.ts`.
- [x] Generic process-signal result inference is implemented in
      `packages/core/src/server/process-signals.ts`; the boundary is recorded in
      `docs/decisions/0102-managed-application-kernel.md` and
      `docs/architecture/application-kernel.md`.

### Проверка

- [x] Регрессия: packages/core/tests/application-kernel.test.ts::validates the whole graph before side effects; packages/core/tests/application-kernel.test.ts::starts in stable topological order and activates only after all resources are ready; packages/core/tests/application-kernel.test.ts::rolls back every attempted resource including the start that rejected; packages/core/tests/application-kernel.test.ts::continues startup rollback after a close failure and reports both causes.
- [x] Регрессия: packages/core/tests/application-kernel.test.ts::shutdown during activation prevents later activation and closes attempted resources once; packages/core/tests/application-kernel.test.ts::forces resources concurrently against one pair of absolute deadlines; packages/core/tests/application-kernel.test.ts::managed server shutdown starts once with the original application force signal.
- [x] Регрессия: packages/core/tests/process-signals.test.ts::infers a non-HTTP result while keeping the default target source-compatible; packages/core/tests/process-signals.test.ts::forces a shutdown that is already in flight.
