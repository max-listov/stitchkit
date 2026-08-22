---
title: "Production-grade agent persistence and projection ergonomics"
description: "Зонтичная задача: оставить invariants, reducer, admission projection и recovery orchestration во framework, а consumer-у — атомарные storage primitives и product mapping."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 19:52 +0000
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-durable-run-store.md
  - docs/backlog/done/2026-08-22-agent-runtime-delivery-events.md
---

# Production-grade agent persistence and projection ergonomics

## Зачем

Runtime core уже владеет loop, coordination, fencing и canonical schemas, но
production consumer всё ещё реализует восемь aggregate mutations и повторяет
reference invariants. Короткий JSON-snapshot adapter дублирует всю message
history; normalized relational adapter превращается в собственный reducer.
Оба результата противоречат цели удалить generic runtime mechanics из apps.

## Результат

- Framework владеет одним reducer для admission, acquisition, checkpoint,
  interrupt, recovery, terminal и compaction.
- Consumer реализует только atomic load/CAS/recovery scan и storage codec для
  существующей message history; ORM и transport types не входят в core.
- Durable runtime state хранит runs/version/idempotency, а canonical messages
  могут оставаться единственным источником правды в application tables.
- Admission, checkpoint и terminal delivery несут готовые canonical records и
  normalized telemetry; startup recovery вызывается одним framework helper.
- Реальный PostgreSQL/Prisma proof проверяет транзакционные races, а не только
  memory semantics.

## План

- [x] Реализовать framework-owned reducer и coherent transaction boundary: state и
      history читаются/пишутся одним adapter-owned transaction runner.
- [x] Обогатить durable events/admission receipt и добавить recovery helper.
- [x] Добавить официальный PostgreSQL/Prisma adapter proof и conformance matrix.
- [x] Синхронизировать ADR, architecture, guide, API reference и changelog.
- [x] Выполнить конвейер 2/2 и полный `bun run verify` без release/deploy/git writes.

## Acceptance

- [x] Production adapter не реализует восемь state transitions вручную.
- [x] Existing message table может быть source of truth без полного snapshot JSON.
- [x] State CAS и history write имеют один атомарный commit/rollback boundary.
- [x] Duplicate/coalesced admission, stale checkpoint, terminal race, compaction
      conflict и restart recovery доказаны reusable conformance + PostgreSQL proof.
- [x] Delivery adapter не перечитывает store для durable placeholders/result.
- [x] Public core остаётся ORM- и transport-neutral.

## Конвейер 2/2

- [x] Plan validator 1: reducer linearizability, atomic storage and recovery safety.
- [x] Plan validator 2: consumer ergonomics, event/projection API and deletion proof.
- [x] Implementation validator 1: adversarial persistence/concurrency review.
- [x] Implementation validator 2: public API, docs and real-consumer ergonomics review.

## Что сделано

- [x] **Boundary:** `packages/core/src/agent-runtime/store-driver.ts` владеет reducer,
      coherent transaction, archive-aware duplicate projection и bounded recovery index.
- [x] **Projection:** `packages/core/src/agent-runtime/runtime.ts` публикует canonical
      admission/metrics и предоставляет bounded `recover()` orchestration.
- [x] **Regression:** `packages/core/tests/agent-runtime-store-driver.test.ts`, cases
      `memory driver passes the reusable production-store contract`,
      `atomically refuses out-of-order or sibling acquisition` и
      `recovery pagination is tuple-safe and legacy scans deduplicate conversations`.
- [x] **Validation:** disposable PostgreSQL proof 6/6 и полный `bun run verify`
      завершились с exit 0; release, deploy, commit и git index не выполнялись.
