---
title: "Framework-owned agent store reducer and history codec"
description: "Свести восемь aggregate operations к load/CAS/scan primitives и атомарному codec существующей message history."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 19:52 +0000
related:
  - docs/backlog/inbox/2026-08-22-agent-runtime-production-persistence-ergonomics.md
  - docs/backlog/done/2026-08-22-agent-durable-run-store.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
---

# Framework-owned agent store reducer and history codec

## Зачем

`AgentRuntimeStore` заставляет каждый durable adapter повторять framework state
machine. Memory adapter уже содержит canonical reducer, но его нельзя повторно
использовать поверх application persistence. Хранить `AgentSnapshot.messages`
рядом с existing message rows — ненужная вторая полная копия истории.

## Результат

- `createAgentRuntimeStore()` принимает adapter-owned transaction runner,
  transactional state/history load, CAS и paged `scanRecoverable` primitives.
- Stored state содержит versioned runs и idempotency admission identities, но не
  обязан дублировать messages.
- Optional `historyStorage` загружает existing messages и применяет typed
  input/checkpoint/terminal/compaction mutations внутри выигравшего CAS transaction.
- Opaque generic transaction token позволяет Prisma/PostgreSQL adapter-у сделать
  coherent read и state CAS + history write одним transaction, не экспортируя ORM.
- `createMemoryAgentRuntimeStore()` использует тот же reducer/primitives, а не
  остаётся параллельной реализацией invariants.

## План

- [x] Задать Zod-first stored-state, admission identity и history-mutation schemas.
- [x] Выделить pure reducer с validation, collision, revision и transition rules.
- [x] Реализовать explicit aggregate/run conflict semantics и snapshot assembly.
- [x] Подключить atomic history codec к выигравшей transaction.
- [x] Перевести memory adapter на factory и удалить duplicated reducer path.
- [x] Добавить reusable store conformance suite.

## Acceptance

- [x] Consumer persistence surface не содержит eight domain mutations.
- [x] Duplicate admission возвращает original input/run/assistant identity.
- [x] Coalescing, ownership, collision, stale checkpoint, terminal and contiguous
      compaction invariants живут только в framework reducer.
- [x] Losing CAS не вызывает history write; failing history write откатывает CAS.
- [x] `loadSnapshot` собирается из framework state и `loadMessages` без second
      durable full-history blob.
- [x] Unknown schema version fails closed; read-old/write-new policy documented.
- [x] Existing `AgentRuntimeStore` remains the runtime-facing interface; no ORM types leak.

## Конвейер 2/2

- [x] Plan validation incorporated from umbrella round.
- [x] Implementation correctness review passed.
- [x] Implementation ergonomics review passed.

## Что сделано

- [x] **Core:** `packages/core/src/agent-runtime/store-driver.ts` реализует один
      reducer и memory adapter поверх одинакового driver contract.
- [x] **Conformance:** `packages/core/src/testing/agent-store-conformance.ts`, case
      `passes the reusable store conformance contract` проверяет duplicate после
      compaction, coalescing, collision, stale ownership и recovery terminalization.
- [x] **Regression:** `packages/core/tests/agent-runtime-store-driver.test.ts`, case
      `atomically refuses out-of-order or sibling acquisition` закрывает multi-process ordering invariant.
