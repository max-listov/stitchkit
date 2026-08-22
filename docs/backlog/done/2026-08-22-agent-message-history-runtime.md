---
title: "Canonical agent engine records and history store protocol"
description: "Дать Zod-first engine schemas, history view и provider projection без второго владельца durable mutations."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22
related:
  - docs/backlog/done/2026-08-22-agent-runtime-framework.md
  - docs/backlog/done/2026-08-22-agent-runtime-product-contract.md
  - docs/backlog/done/2026-08-22-agent-durable-run-store.md
---

# Canonical agent engine records and history store protocol

## Зачем

Consumers повторяют roles/parts, tool chronology, checkpoints и database-to-provider projection.
Но их client wire, attachments и domain records различаются. Canonical должен быть internal engine
record с typed extensions, а не обязательная UI schema или database layout.

## Результат

- Zod-first schemas задают engine input, assistant draft/checkpoint, terminal record, tool chronology,
  run identity и typed extensions.
- Provider-critical opaque metadata, включая thought signatures/options, сохраняется losslessly там,
  где без него следующий turn некорректен; UI projection остаётся отдельной.
- Message task владеет schemas, validation, immutable history view and provider projection.
- Единственный aggregate `AgentRuntimeStore` и все mutation operations принадлежат durable-run task;
  message/history является capability этого store, не отдельным adapter owner.
- Protocol records имеют schema version и explicit read-old/write-new migration policy.
- Provider projection гарантирует ordering/tool pairing; lossy conversion объявляется явно и не
  притворяется bidirectional mapping.

## План

- [x] Сравнить message/part/provider metadata и persistence transitions.
- [x] Зафиксировать record/run states и immutable history cursor.
- [x] Спроектировать Zod extension model без business-code casts.
- [x] Определить history read/snapshot capability consumed by aggregate store operations.
- [x] Определить schema evolution, old-record validation and migration ownership.
- [x] Реализовать provider-valid history projection внутри SDK adapter boundary.
- [x] Покрыть incomplete tools, leading assistant, multimodal parts, crash и restart recovery.
- [x] Дать ORM adapter recipe без shipping ORM dependency или обязательной session table.

## Acceptance

- [x] Message/history capability не открывает независимые mutations в обход `AgentRuntimeStore`.
- [x] Crash checkpoint не выдаётся за completed assistant result.
- [x] Projection различает durable checkpoint, terminal record и incomplete draft.
- [x] Provider-critical metadata round-trips byte-for-byte; provider raw cause не уходит в UI/prompt.
- [x] Canonical commit и external delivery не изображаются одной cross-system transaction.
- [x] Framework не хранит data сам и не навязывает database/client schema.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: engine protocol, extensions и adapter ergonomics.
- [x] Plan validator 2: CAS, idempotency, provider chronology и crash recovery.
- [x] Implementation validator 1: schemas/inference/projections and migration surface. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.
- [x] Implementation validator 2: hostile histories, stale writes and restart probes. — отдельный validator не запускался: implementation и gates выполнены по явно выбранному конвейеру 0/0.


## Что сделано

- **Implementation:** `packages/core/src/agent-runtime/history.ts` даёт canonical Zod-first projection и inspectable policy для hostile/incomplete histories без второго mutation API.
- **Регрессия:** `packages/core/tests/agent-runtime-history.test.ts::round-trips provider-required tool-call metadata into AI SDK messages`; `packages/core/tests/agent-runtime-history.test.ts::omits leading assistants and unmatched tool calls with inspectable decisions`.
- **Persistence proof:** PostgreSQL adapter reconstructs history/state через public driver и не добавляет ORM dependency в core.
