---
title: "Stable agent admission identity"
description: "Вернуть accepted-response transport фактически назначенные run/assistant IDs без store internals и закрыть identity collisions."
type: task
status: done
created: 2026-08-22
updated: 2026-08-22
completed: 2026-08-22 17:16 +00:00
related:
  - docs/backlog/in-progress/2026-08-22-agent-session-coordination.md
---

# Stable agent admission identity

## Зачем

В `stitchkit@0.56.2` `runtime.submit()` генерирует input, run и assistant IDs внутри,
но до terminal result наружу отдаёт только `accepted: Promise<void>`. Accepted-response
transport не может сразу вернуть durable user/assistant placeholders, а при
`coalescePending: true` не может предсказать назначенный successor run.

Первый draft открыл caller IDs и receipt, но plan review нашёл три correctness gap:
caller-provided assistant ID мог позже перезаписать canonical history, новая rejectable
promise могла создать unhandled rejection у старого consumer, а составной строковый
ticket key допускал collision на произвольных non-empty IDs.

## Результат

- `submit({ recordIds })` принимает stable application IDs.
- `ticket.admission` после durable CAS возвращает фактически назначенные `runId`,
  `assistantMessageId` и `snapshotVersion`, включая duplicate/coalesced assignment.
- Reference store fail-closed отклоняет assistant identity, способную перезаписать
  message/history другого run; discarded coalescing proposal не резервирует IDs.
- Existing consumers, которые читают только `accepted/result`, не получают новый
  unhandled rejection.
- Runtime ticket deduplication использует collision-free nested identity map.

## План

- [x] Проверить published `0.56.2` и accepted-response/coalescing failure mode.
- [x] Спроектировать additive caller IDs и admission receipt.
- [x] Закрыть assistant/message/run identity collisions в reference store.
- [x] Заменить delimiter key на nested map и internally observe admission rejection.
- [x] Синхронизировать guide, API reference и changelog.
- [x] Прогнать targeted regression tests и полный `bun run verify`.
- [x] Выпустить patch release и проверить npm/GitHub publication.

## Acceptance

- [x] Fresh submit возвращает caller-provided run/assistant identity после durable CAS.
- [x] Duplicate submit возвращает original durable run/assistant identity, а не discarded proposal.
- [x] Coalesced inputs получают общий successor run/assistant и собственные snapshot versions.
- [x] Assistant ID не может совпасть с input message, existing message или assistant другого run.
- [x] Proposed run/assistant IDs coalesced follower не создают ложный uniqueness conflict.
- [x] Любые valid conversation/idempotency strings не alias-ятся в process ticket cache.
- [x] Consumer может игнорировать новый `admission` и по-прежнему обработать только
      `accepted/result` без дополнительного unhandled rejection.
- [x] Public exports, generated docs, packed package, Bun/Node smoke и consumer/starter lanes зелёные.

## Конвейер 0/0

По явной команде Макса дополнительные plan/implementation validators не запускаются.
Findings уже завершённого раннего review включены в scope выше; новых validator rounds нет.

## Что сделано

### Runtime и store

- [x] `packages/core/src/agent-runtime/runtime.ts` — additive `recordIds`, durable
      `admission` receipt, nested ticket map и internally observed rejection.
- [x] `packages/core/src/agent-runtime/store.ts` — canonical assistant identity
      collision guard без ложного резервирования discarded coalescing proposal.

### Regression coverage

- [x] `packages/core/tests/agent-runtime-terminal.test.ts` — `accepts caller record ids and exposes the assigned admission identity`, `returns the durable admission identity for a duplicate with discarded proposals`, `keeps runtime tickets distinct for delimiter-bearing identities`, `internally observes admission rejection for accepted-result compatibility`, плюс coalesced receipt assertions в `coalesces inputs behind an active run into one durable successor`.
- [x] `packages/core/tests/agent-runtime-store.test.ts` — `rejects assistant identities that could overwrite canonical history` и discarded-ID coverage в `coalesces another durable input into the same queued successor run`.

### Gates и docs

- [x] `bun run verify` — lint, typecheck, 1 419 core tests, build, Next/Node
      smoke, packed consumer и обе target starter lanes зелёные.
- [x] `CHANGELOG.md`, `docs/guide/agent-runtime.md`, `docs/api/reference.md` и
      public type exports синхронизированы для `0.56.3`.
- [x] Release commit [`7c34c57`](https://github.com/max-listov/stitchkit/commit/7c34c57590a9f02533095ef168c09abfbe8b3ab0)
      прошёл [exact-SHA CI](https://github.com/max-listov/stitchkit/actions/runs/32587061800);
      tag `v0.56.3` указывает на тот же SHA.
- [x] [Release workflow](https://github.com/max-listov/stitchkit/actions/runs/32587186586)
      опубликовал `stitchkit@0.56.3` в public npm registry и создал
      [GitHub Release](https://github.com/max-listov/stitchkit/releases/tag/v0.56.3).
