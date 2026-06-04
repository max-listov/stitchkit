---
title: Кэш детерминированной части MCP-build для статичных services (perf)
description: createMcpHandler пересобирает весь McpServer (collectTools + mergeSchemas + probe схем) на каждую новую MCP-сессию. Для статичного массива services это детерминированно и кэшируемо. P4 — делать только если всплывёт в профайле.
type: task
status: inbox
created: 2026-06-05
updated: 2026-06-05
related: docs/backlog/done/2026-05-20-tools-layer-followups.md
---

# Per-session перестройка `McpServer` — кэш для статичных services

> **Вынесено из** [`tools-layer-followups`](../done/2026-05-20-tools-layer-followups.md)
> (Item 3) при его закрытии. Item 1 и Item 2 того файла закрыты в релизе 0.4.0;
> этот пункт остался единственным живым — отложен на потом, если понадобится.

## Приоритет: P4 (перф). Делать ТОЛЬКО если всплывёт в профайле.

## Что за гэп

`tools/mcp-handler.ts` в ветке «fresh session» зовёт `buildMcpServer` —
`collectTools` + `mergeSchemas` + probe каждой схемы + `registerTool` — **на
каждую новую MCP-сессию** (`mcp-handler.ts` ~стр. 167 и 240). Для статичного
массива `config.services` результат детерминирован и мог бы кэшироваться.

## Почему отложено

- Чистый перф, не дефект целостности/безопасности.
- Влияние малое: сессия живёт долго (много вызовов на сессию), не пересоздаётся
  на каждый запрос. Для десятка тулов — доли миллисекунды.
- Чистого фикса «собрать один раз» нет: в модели MCP SDK каждой сессии нужен свой
  `McpServer` + `transport` (инстанс не шарится). Кэшировать можно только дорогую
  детерминированную часть.

## План (если делать)

Когда `config.services` — статичный массив: один раз вычислить `collectTools` +
probe-результаты, на каждую сессию делать только `registerTool` по готовому
списку. Для `services` / `context` в форме функции от auth — кэш невозможен
(разные тенанты видят разные тулы), оставить как есть.

## Триггер к работе

Профилирование показало заметную долю времени в `buildMcpServer` при частом
создании сессий. До этого — не трогать (не оптимизировать вслепую).

## Ссылки

- Код: `packages/core/src/tools/mcp-handler.ts`, `tools/mcp.ts` (`buildMcpServer`,
  `collectTools`, `mergeSchemas`).
- Исходный набор follow-up'ов: `docs/backlog/done/2026-05-20-tools-layer-followups.md`.
