---
title: "The audit hook breaks the call it observes"
description: "measureSize и sanitizePayload вычисляются вне try/catch эмиттера, а afterToolCall — единственный незащищённый хук."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:40 +07:00
---

# The audit hook breaks the call it observes

## Зачем

`observability/audit.ts:18-21` обещает прямо: «its own errors are swallowed, so a
slow or failing write never blocks or breaks the request it observes». Обещание не
выполняется.

`createEmitter` (`audit.ts:198-202`) оборачивает в try/catch только `filter` и
`write`. Но `measureSize(result.data)` и `sanitizePayload(...)` вычисляются **в
выражении аргумента**, то есть снаружи защиты, а `measureSize` зовёт голый
`JSON.stringify` на сырых данных хендлера. Со стороны исполнения тулов
`execute.ts:277-288` ждёт `afterToolCall` **без** try/catch — при том что
`beforeToolCall` и `onToolError` защищены оба. То есть незащищён ровно тот хук,
которым пользуется `createObservability`.

```
контракт: outputSchema z.object({ total: z.bigint() }), handler -> { total: 10n }

без хуков                          -> { ok: true, data: { total: 10n } }
+ createObservability({tools:...}) -> THREW TypeError: JSON.stringify cannot serialize BigInt
строк аудита записано: 0
```

Последствия расходятся по двум путям:

- MCP-монтирование ловит исключение на `mcp.ts:523` и сообщает модели `isError`
  для операции, которая **успешно выполнилась и уже применила побочные эффекты**;
- на HTTP-пути тот же бросок уходит из `void (async()=>…)()` как **unhandled
  rejection** (под Node с дефолтами — завершение процесса).

И в обоих случаях строка аудита теряется — то есть наблюдатель не только ломает
наблюдаемое, но и не оставляет записи о том, что ломал.

Триггеры: любой `BigInt`, циклическая ссылка в `result.data`, бросающий геттер в
аргументах.

## Результат

- Отказ внутри слоя наблюдаемости не меняет результат наблюдаемой операции ни на
  одном транспорте.
- Успешная операция никогда не сообщается модели как `isError` из-за аудита.
- Данные, которые невозможно сериализовать, приводят к записи аудита с пометкой
  вместо потери строки и падения вызова.

## План

- [x] Внести вычисление размера и санитизацию **внутрь** try/catch эмиттера —
      сейчас они снаружи по недосмотру, а не по замыслу.
- [x] `measureSize` не должен полагаться на голый `JSON.stringify`: несериализуемое
      значение обязано давать `null`/пометку, а не бросок.
- [x] Обернуть `afterToolCall` в `execute.ts` так же, как уже обёрнуты
      `beforeToolCall` и `onToolError` — привести три хука к одному правилу.
- [x] Проверить HTTP-путь на unhandled rejection: `void (async()=>…)()` обязан
      иметь `.catch`.
- [x] Тест: контракт с `bigint` в выходе — вызов тула возвращает `ok: true`,
      строка аудита записана с пометкой о несериализуемых данных.
- [x] Тест: циклическая ссылка в `result.data` — то же поведение.
- [x] Тест: `write` бросает — вызов не затронут, процесс жив.
- [x] Тест: бросающий геттер в аргументах — санитизация не роняет вызов.

## Acceptance

- [x] Ни один сценарий несериализуемых данных не меняет `ok` наблюдаемого вызова.
- [x] Ни один не порождает unhandled rejection.
- [x] Во всех сценариях строка аудита существует (пусть с пометкой), а не теряется.
- [x] Обещание в шапке `audit.ts` подтверждено тестом, а не только текстом.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/observability/audit.ts and packages/core/src/tools/execute.ts.
- [x] Регрессия: packages/core/tests/audit-tool-event.test.ts::bigint and circular results still produce a successful audit row; packages/core/tests/audit-tool-event.test.ts::a throwing sink is swallowed; packages/core/tests/mcp-v2-modern.test.ts::a successful call with unserialisable output is NOT reported as isError
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Основное сделано и проверено: BigInt, циклы, бросающие геттеры, падение
`write`/`filter` вызов больше не ломают, строка аудита пишется, unhandled rejection
нет ни на Bun, ни на Node.

Не выполнено и внесено:

- Acceptance «Успешная операция никогда не сообщается модели как `isError`» —
  **ложно**: `formatMcpResult` (`tools/mcp-prepare.ts:71`) зовёт
  `JSON.stringify(result.data, null, 2)` без защиты, и циклическое значение даёт
  `isError: true` при уже применённых побочных эффектах — даже когда наблюдаемость
  отключена вовсе.
- Чтение конфигурации (`audit.ts:195-197`) осталось **до** `try`, а единственный
  backstop в `execute.ts:284` — голый `console.error`; связка бросающего геттера
  конфигурации и бросающего `console` доводит исключение до вызывающего.
- Внесена регрессия производительности через `truncatePreview` — ведётся в
  `audit-payload-serialisation-semantics`.
- «Пометка о несериализуемых данных» реализована как `responseBytes: 0`, что
  неотличимо от «хендлер ничего не вернул».

### Осталось сделать

- [x] `formatMcpResult` защищён: несериализуемый успешный результат проецируется
      в JSON-safe форму (`redact` с never-matching `sensitiveKeys: /(?!)/` — циклы
      → `[circular]`, bigint → строка, маскирование секретов НЕ применяется: это
      ответ, а не аудит) и уходит как `content` + `structuredContent`. Просто
      опустить `structuredContent` нельзя — SDK при объявленной `outputSchema`
      сам превращает его отсутствие в `isError` (проверено пробником). Бросок
      `produced a non-JSON output` удалён.
- [x] Чтение `config.tools` и `createEmitter` внесены внутрь `try` в
      `audit.ts::afterToolCall`; оба backstop-`console.error` в `execute.ts`
      (afterToolCall и onToolError) обёрнуты — бросающий console не достигает
      вызова.
- [x] Явная пометка: `SizeMeasure.unserializable?: true` из `measureSize` →
      `resultUnserializable: true` в строке аудита (`event.ts`); отличимо от
      «хендлер ничего не вернул» (`responseBytes: 0` без пометки).
- [x] Тест через контракт (defineContract → implement → createMcpHandler →
      `tools/call` по HTTP): `packages/core/tests/mcp-v2-modern.test.ts::a
      successful call with unserialisable output is NOT reported as isError` —
      циклический выход через `z.unknown()`; bigint-СХЕМА, как выяснено, честно
      отвергается ещё на построении поверхности (`mcp-prepare` JSON-Schema
      probe), поэтому runtime-цикл — единственная форма, доходящая до
      `formatMcpResult`.

**Финальная проверка 2026-08-10:** `bun test mcp-v2-modern audit-tool-event
execute sanitize mcp-preparation-cache` — 75 pass; `tsc --noEmit` чистый.
