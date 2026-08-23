---
title: "Bounded normalized persistence contract for the agent runtime"
description: "Заменить lifetime aggregate arrays на bounded head, normalized runs и durable admission receipts при framework-owned reducer."
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T01:56:15Z
related:
  - docs/backlog/done/2026-08-22-agent-durable-run-store.md
  - docs/backlog/done/2026-08-22-framework-owned-agent-store-reducer.md
  - docs/backlog/done/2026-08-23-agent-duplicate-terminal-after-compaction.md
---

# Bounded normalized persistence contract for the agent runtime

## Зачем

Текущий `AgentStoredState` содержит все `runs` и `admissions` за жизнь conversation.
Каждая state CAS загружает, валидирует и переписывает этот растущий aggregate, а reference
PostgreSQL adapter дополнительно поддерживает производный recoverable index. Physical history
compaction не ограничивает размер runtime state.

Framework-owned reducer и его invariants должны сохраниться, но persistence contract должен
масштабироваться независимо от длины conversation. Bounded означает bounded mutation/read set
одной операции, а не обещание бесконечно хранить данные без retention policy.

## Результат

- Логическая модель разделена на product-owned conversation/history и framework-governed
  `head + normalized runs + durable admissions`.
- Conversation head содержит только identity, schema version и monotonic runtime version.
- Run record является canonical источником state/revision/ownership/fencing, terminal outcome и
  retained terminal assistant.
- Admission receipt по `(conversationId, idempotencyKey)` хранит canonical input и ссылку на
  assigned run.
- Recovery выполняется индексированным scan normalized runs по состоянию, без второй mutable копии
  active descriptors.
- Физическая Prisma/SQL схема остаётся reference profile; consumer adapters могут размещать head в
  существующей session/conversation записи.

## План

- [x] Зафиксировать entities, states, transitions, owners и linearization points для head, run,
      admission receipt, retained terminal assistant и product history.
- [x] Спроектировать следующую версию transaction driver с atomic primitives для head CAS,
      run/admission reads and writes, history mutation и indexed recoverable-run scan.
- [x] Оставить transition validation, idempotency, coalescing, fencing, checkpoint/terminal commit,
      compaction semantics и recovery decisions внутри Stitchkit reducer.
- [x] Убрать lifetime `runs/admissions` arrays из bounded head и исключить обязательную отдельную
      recoverable-index projection.
- [x] Определить retention и schema-evolution contract: terminal/admission records переживают
      product compaction; old format имеет явную migration/read policy без двух permanent API paths.
- [x] Обновить memory/JSON driver как простой profile и PostgreSQL/Prisma reference adapter как
      normalized transaction proof.
- [x] Расширить один reusable conformance suite для memory/JSON, normalized SQL и adapter с
      physically deleted product history.
- [x] Измерить mutation payload/read set на длинной synthetic conversation и доказать, что они не
      растут линейно с lifetime run/admission count.
- [x] Синхронизировать architecture, ADR, guide, API reference, generated docs и breaking migration
      в `CHANGELOG.md`.

## Acceptance

- [x] Head CAS payload имеет constant-size shape и не содержит lifetime arrays.
- [x] Одна runtime mutation читает/пишет head, affected run/admission и необходимые history records,
      но не весь lifetime runtime aggregate.
- [x] Admission uniqueness и run/checkpoint/terminal CAS сохраняют прежние linearizability
      guarantees на real transactions.
- [x] Duplicate terminal receipt полностью восстанавливается после hard-delete product compaction.
- [x] Recovery использует indexed run-state query; отдельный synchronized recoverable descriptor
      store не требуется.
- [x] Один conformance manifest одинаково проходит memory profile, normalized PostgreSQL profile и
      consumer-history adapter с physical compaction.
- [x] Public contract не содержит Prisma/ORM types, не требует конкретного числа таблиц и не
      навязывает product message schema.
- [x] Migration из `AgentStoredStateSchema` v1 описана механически; breaking pre-1.0 release
      получает minor bump и before → after snippet.

## Конвейер 0/0

Plan validators: 0. Implementation validators: 0. Gates запускаются только отдельной командой.

## Что сделано

- Public driver cut over to `head + runs + admissions + history`: head CAS is constant-size,
  run/admission identities are normalized, and recovery scans canonical run states directly.
- Memory profile and executable Prisma/PostgreSQL profile use the same framework-owned reducer;
  the SQL fixture no longer has aggregate payload or recoverable projection tables.
- ADR 0101, architecture, guide, API reference, upgrading flow, changelog and generated
  `llms.txt` surfaces describe the clean breaking migration.
- Точное покрытие: `packages/core/tests/agent-runtime-store-driver.test.ts` —
  `memory driver passes the reusable production-store contract`; `examples/agent-store-prisma/adapter.test.ts` —
  `passes the reusable store conformance contract`, `serializes competing admissions into one winner and one durable duplicate`,
  `serializes a terminal race and reports the current run revision`,
  `reconstructs bounded recovery after a fresh adapter process` и
  `keeps the runtime head constant-size across a long compacted conversation` (64 complete runs,
  one active summary, 64 normalized run/admission rows, zero recoverable rows, head version only).
