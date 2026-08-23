---
title: "Restore duplicate terminal results after history compaction"
description: "Возвращать canonical terminal assistant для duplicate admission, даже если product history уже физически compacted."
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23T01:56:15Z
related:
  - docs/backlog/done/2026-08-22-framework-owned-agent-store-reducer.md
  - docs/backlog/done/2026-08-23-bounded-normalized-agent-runtime-store.md
---

# Restore duplicate terminal results after history compaction

## Зачем

В `stitchkit@0.58.0` durable duplicate admission восстанавливает original input через
`AgentRuntimeStoreDriver.history.loadById`, если message уже отсутствует в активном snapshot.
Terminal assistant восстанавливается иначе: `runtime.submit()` ищет его только среди
`acceptedSnapshot.messages` и завершает ticket ошибкой
`Duplicate terminal run has no assistant message`, когда physical compaction уже удалил запись.

Это нарушает durable idempotency: повтор того же `idempotencyKey` обязан вернуть исходные
`runId`, `assistantMessageId`, terminal reason и canonical terminal assistant независимо от
retention policy продуктовой истории.

## Результат

- Duplicate terminal admission возвращает исходный terminal result после physical compaction.
- Store/reducer boundary владеет восстановлением canonical input и assistant; runtime не читает
  adapter internals и не выдаёт pending placeholder вместо завершённого сообщения.
- Adapter может хранить retained terminal assistant отдельно от активной product history без
  обязательной ORM-схемы или framework-owned database.

## План

- [x] Добавить regression fixture: original input и terminal assistant удалены из active history,
      но доступны через durable record lookup.
- [x] Расширить duplicate result/receipt store contract так, чтобы reducer возвращал canonical
      terminal assistant вместе с canonical input и assigned run identity.
- [x] Перевести admission event и terminal ticket resolution на единый canonical duplicate
      projection.
- [x] Сохранить текущее поведение для active non-terminal duplicate, coalesced admission и
      process-local reservation.
- [x] Покрыть hard-delete compaction, duplicate после restart и отсутствие retained terminal
      assistant как явное adapter-contract нарушение.
- [x] Синхронизировать public types, API reference, guide и `CHANGELOG.md`; изменение вошло в
      breaking normalized-driver cutover и требует minor bump.

## Acceptance

- [x] Повторный `submit()` с тем же `idempotencyKey` после physical compaction resolves, а не
      выбрасывает `Duplicate terminal run has no assistant message`.
- [x] Result содержит исходные `runId`, `assistantMessageId`, terminal reason и byte-equivalent
      canonical terminal assistant.
- [x] Admission event для terminal duplicate публикует completed assistant, а не pending
      placeholder.
- [x] Recovery не зависит от присутствия input или assistant в активном history snapshot.
- [x] Missing retained record диагностируется как нарушение persistence contract и не маскируется
      новым assistant/message ID.
- [x] Core остаётся ORM-neutral; private consumer identities и domain schemas не попадают в public
      API, tests или documentation.

## Конвейер 0/0

Plan validators: 0. Implementation validators: 0. Gates запускаются только отдельной командой.

## Что сделано

- `AgentStoreDuplicateSchema` и normalized store reducer возвращают canonical run и retained
  terminal assistant прямо из durable run record.
- Runtime строит admission и terminal result из canonical duplicate projection, не из active
  history; отсутствие retained assistant получает отдельную persistence-contract диагностику.
- Точное покрытие: `packages/core/tests/agent-runtime-terminal.test.ts` —
  `returns the durable admission identity for a duplicate with discarded proposals` и
  `reports a persistence contract violation when a terminal duplicate lost its assistant`;
  `packages/core/src/testing/agent-store-conformance.ts` проверяет duplicate terminal после
  physical compaction одинаково для memory и PostgreSQL profiles.
