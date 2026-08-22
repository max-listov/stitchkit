---
title: "Canonical agent engine records and history store protocol"
description: "Дать Zod-first engine schemas, history view и provider projection без второго владельца durable mutations."
type: task
status: in-progress
created: 2026-08-22
updated: 2026-08-22
related:
  - docs/backlog/in-progress/2026-08-22-agent-runtime-framework.md
  - docs/backlog/in-progress/2026-08-22-agent-runtime-product-contract.md
  - docs/backlog/in-progress/2026-08-22-agent-durable-run-store.md
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

- [ ] Сравнить message/part/provider metadata и persistence transitions.
- [ ] Зафиксировать record/run states и immutable history cursor.
- [ ] Спроектировать Zod extension model без business-code casts.
- [ ] Определить history read/snapshot capability consumed by aggregate store operations.
- [ ] Определить schema evolution, old-record validation and migration ownership.
- [ ] Реализовать provider-valid history projection внутри SDK adapter boundary.
- [ ] Покрыть incomplete tools, leading assistant, multimodal parts, crash и restart recovery.
- [ ] Дать ORM adapter recipe без shipping ORM dependency или обязательной session table.

## Acceptance

- [ ] Message/history capability не открывает независимые mutations в обход `AgentRuntimeStore`.
- [ ] Crash checkpoint не выдаётся за completed assistant result.
- [ ] Projection различает durable checkpoint, terminal record и incomplete draft.
- [ ] Provider-critical metadata round-trips byte-for-byte; provider raw cause не уходит в UI/prompt.
- [ ] Canonical commit и external delivery не изображаются одной cross-system transaction.
- [ ] Framework не хранит data сам и не навязывает database/client schema.

## Конвейер 2/2 с остановкой

- [x] Plan validator 1: engine protocol, extensions и adapter ergonomics.
- [x] Plan validator 2: CAS, idempotency, provider chronology и crash recovery.
- [ ] Implementation validator 1: schemas/inference/projections and migration surface.
- [ ] Implementation validator 2: hostile histories, stale writes and restart probes.
