---
title: "Durable agent run store and crash recovery"
description: "Зафиксировать versioned run records, atomic admission, ownership CAS, recovery scan и outbox boundary."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-message-history-runtime.md
  - docs/backlog/done/2026-08-22-agent-session-coordination.md
---

# Durable agent run store and crash recovery

## Зачем

Process `Map` координирует только живой instance. Crash между input commit и scheduling, restart с
active run или terminal commit до external delivery требуют durable versioned run protocol. ORM и
distributed lease implementation остаются consumer-owned adapters.

## State model

```text
queued -> running -> interrupt_requested -> completed | interrupted | failed | cancelled | abandoned
```

Abort — сигнал, не terminal state. Ownership и каждый checkpoint/terminal переход проверяются через
expected run/revision. Optional approvals deferred до отдельной durable state machine.

## Результат

- Один aggregate `AgentRuntimeStore` является единственным владельцем durable message/run/compaction
  mutations. Он атомарно выполняет `acceptInputAndAssignRun`, `checkpointRunAssistant`,
  `commitRunTerminal` and `replaceCompactedRange`.
- Records versioned; operations use expected revision/run ID and idempotency keys.
- Startup recovery scanner получает recoverable queued/active work и explicit stale-owner outcome.
- Transactional outbox capability optional; без неё delivery использует stable IDs and dedupe, но
  exactly-once не обещается.
- Distributed lease/fencing token is typed adapter capability, не hidden framework database.

## План

- [x] Зафиксировать aggregate message/run capabilities, states, operations and linearization points.
- [x] Спроектировать atomic input assignment and ownership acquisition CAS.
- [x] Определить checkpoint/terminal conflicts, retries and idempotency.
- [x] Спроектировать startup scan, stale ownership and abandoned recovery policy.
- [x] Определить optional lease/fencing-token and transactional-outbox capabilities.
- [x] Покрыть crash before scheduling, during checkpoint and after terminal commit.

## Acceptance

- [x] Durable accepted input не теряется при crash до scheduling.
- [x] Только выигравший CAS меняет canonical run/checkpoint/terminal state.
- [x] Невозможно принять input в history без atomic queued-run assignment.
- [x] Recovery не возобновляет side-effectful step без replay/idempotency evidence.
- [x] Store API не содержит ORM types and supports process-local-only adapters honestly.
- [x] Schema evolution and read-old/write-new policy explicit.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: adapter ergonomics, recovery UX and deployment modes.
- [x] Plan validator 2: CAS, ownership, crash windows and outbox guarantees.
- [x] Implementation validator 1: schemas/store contract and reference adapter. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: crash/restart/stale-owner conformance probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/store.ts`, `store-driver.ts` и `schemas.ts` владеют atomic admission, revision CAS, fencing token, checkpoint/terminal commit и bounded recovery.
- **Регрессия:** `packages/core/tests/agent-runtime-store.test.ts::rejects a stale checkpoint and commits terminal state once`; `packages/core/tests/agent-runtime-store.test.ts::requires replay evidence before requeueing an acquired run`.
- **Transaction proof:** `examples/agent-store-prisma/adapter.test.ts::passes the reusable store conformance contract`; `examples/agent-store-prisma/adapter.test.ts::reconstructs bounded recovery after a fresh adapter process`.
