---
title: "MRTR rounds in the audit model"
description: "N-раундовый тул порождает N+1 событий afterToolCall, из которых N выглядят успешными вызовами."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:03 +07:00
related:
  - docs/backlog/planned/2026-08-10-mrtr-policy-is-validated-too-late.md
---

# MRTR rounds in the audit model

## Зачем

`tools/mcp-round.ts:127-145` прогоняет полный конвейер на каждый раунд с no-op
хендлером — это осознанный приём, позволяющий отработать guard'ам и валидации без
исполнения самой операции. Побочный эффект: N-раундовый тул порождает N+1 вызовов
`afterToolCall`, из которых N выглядят как `{ ok: true, data: { status: 'ok' } }`.

Отличить их можно по `context.mcp.outcome`, но это знание внутренностей. Наивный
сток аудита или биллинга посчитает один пользовательский вызов за несколько
успешных операций.

## Результат

- Промежуточный раунд отличим от завершения вызова без разбора `context.mcp`.
- Существующие потребители аудита продолжают работать.

## План

- [x] Пометить промежуточные раунды явным полем события аудита.
- [x] Описать семантику в гайде по наблюдаемости: что считать вызовом, а что
      раундом.
- [x] Тест: N-раундовый тул даёт одно событие завершения и N помеченных
      промежуточных.

## Что сделано

- [x] Реализация: packages/core/src/observability/event.ts and packages/core/src/tools/mcp-round.ts.
- [x] Регрессия: packages/core/tests/mcp-mrtr.test.ts::audit rows mark every input round and the completion, distinguishable without context.mcp; packages/core/tests/mcp-mrtr.test.ts::uses the current request trace metadata for every round
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

`toolPhase` добавлен в `audit.ts`, но заявленной регрессии нет:

- `Регрессия: mcp-mrtr.test.ts — every round keeps current trace metadata and typed
  aggregate semantics` — диф этого файла содержит только переписанную проверку
  политики, принадлежащую соседней таске. Про метаданные раундов там ничего нет.

### Осталось сделать

- [x] Тест написан: `packages/core/tests/mcp-mrtr.test.ts::audit rows mark every
      input round and the completion, distinguishable without context.mcp` —
      двухраундовый вызов через живой `createMcpHandler` с
      `createObservability({tools}).toolCall`; поток аудита даёт ровно
      `['input-round', 'operation']` по полю `toolPhase`, без разбора
      `context.mcp`.
- [x] Строка `Регрессия:` исправлена на фактические файл и кейсы (форма
      `файл::кейс`, проверяется механическим гейтом docs-hygiene).

**Финальная проверка 2026-08-10:** `bun test mcp-mrtr` — 12 pass.
