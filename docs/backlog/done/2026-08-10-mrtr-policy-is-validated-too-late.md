---
title: "MRTR policy is validated per call, never at build time"
description: "Ошибки конфигурации многораундовых тулов проходят все деплойные гейты и всплывают только на первом вызове модели."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# MRTR policy is validated per call, never at build time

## Зачем

`tools/mcp-round.ts:171-198` — единственное место, где проверяется политика
многораундового тула, и достижимо оно только из `resolveMcpRound`
(`mcp.ts:509`, `native-mcp.ts:82`), то есть **во время вызова**. Ни
`prepareMcpTool`, ни `prepareMcpServerSurface`, ни `validateMcpSchemas` не читают
`method.mcp` вовсе.

Следствие: дублирующиеся ключи раундов, `inputRequired.length > maxRounds` и
«объявлен `inputRequired`, но не сконфигурирован ключ `multiRound.state`»
(`mcp-round.ts:237`) проходят **все** деплойные гейты и всплывают обобщённой
ошибкой тула на первом обращении модели. `mcp-mrtr.test.ts:559` это подтверждает:
отказ наблюдается только через `.fetch(modernCall(...))`.

Это прямо противоречит этосу, записанному в том же слое: «Better a failed deploy
than a tool that silently vanishes» (`mcp.ts:47-50`).

## Результат

- Некорректная политика многораундового тула валит сборку поверхности, а не
  первый вызов модели.
- Правила валидации живут в одном месте и применяются и на подготовке, и на вызове.

## План

- [x] Вызывать валидацию политики из подготовки поверхности
      (`prepareMcpTool` / `prepareMcpServerSurface` / `validateMcpSchemas`), не
      дублируя правила: одна функция, два вызывающих.
- [x] Проверять там же наличие сконфигурированного `multiRound.state`, если тул
      объявляет `inputRequired`.
- [x] Тесты: дублирующийся ключ раунда, превышение `maxRounds` и отсутствующий
      ключ состояния валят построение поверхности; сообщение называет тул.

## Acceptance

- [x] Каждая из трёх ошибок конфигурации обнаруживается без единого вызова модели.
- [x] Существующие тесты MRTR остаются зелёными.
- [x] `bun run verify` зелёный.

## Не входит

- Изменение модели аудита для промежуточных раундов — отдельная задача
  `2026-08-10-mrtr-rounds-in-the-audit-model.md`.

## Что сделано

- [x] Реализация: packages/core/src/tools/mcp-prepare.ts and packages/core/src/tools/mcp-round.ts.
- [x] Регрессия: packages/core/tests/mcp-mrtr.test.ts::fails first on duplicate round keys and max-round overflow
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
