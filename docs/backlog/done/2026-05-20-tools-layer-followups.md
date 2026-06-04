---
title: Tools-слой — follow-up'ы после таска целостности
description: Три пункта, всплывшие при реализации tool-surface-integrity и осознанно оставленные вне его скоупа — типизированный tool-контекст, проверка implementRemote, перф per-session сборки MCP
type: task
status: done
created: 2026-05-20
updated: 2026-06-05
completed: 2026-06-05 20:52
related: docs/backlog/done/2026-05-20-tools-surface-integrity.md, docs/backlog/inbox/2026-06-05-mcp-build-per-session-cache.md
---

# Tools-слой — follow-up'ы

## Зачем

При реализации таска **[«Целостность tool-поверхности»](../done/2026-05-20-tools-surface-integrity.md)**
(F1–F20) всплыли три пункта, которые осознанно оставлены вне его скоупа: тот
таск был про *целостность* — тихий drift контракта и security-дыру авторизации.
Эти три — другая природа: эргономика, уже-покрытое, перф. Здесь они собраны,
чтобы не потерялись.

Источник каждого указан ссылкой на находку в таске целостности.

---

## Item 1 — Типизированный контекст для tool-пути

**Приоритет: P3 (DX). Стоит сделать — отдельной задачей.**

### Откуда

Находка **F9** таска целостности (там F9 закрыт документацией; саб-агент-аудит
отметил, что за доками стоит реальный код-гэп).

### Что за гэп

Хендлер сам типизирован: `createImplement<AppContext>()` даёт `ctx.user: User`
внутри хендлера на всех трёх поверхностях. Не типизирована **проводка**:

- `mountMcp({ context })` / `mountAgent({ context })` принимают
  `context?: Record<string, unknown>`.
- `McpServerBuildConfig.context` — `(auth) => Record<string, unknown>`.
- `ToolExtend.resolve` возвращает `Record<string, unknown>`.

То есть TypeScript не поймает, если в MCP/agent-контекст забыли положить `user`
или положили не того типа. Рантайм-дыры нет — если проводку сделал верно, всё
работает. Это DX-гэп: питч про fullstack type safety на tool-стороне протекает.

### Почему отложено

- Не дефект целостности/безопасности — таск был не про это.
- Инвазивно: каждый конфиг (`McpMountConfig`, `McpServerBuildConfig`,
  `AgentMountConfig`, `McpHandlerConfig`, `StdioMcpServerConfig`) надо делать
  generic по `<TContext>` и протащить через `buildMcpServer` →
  `createMcpHandler` / `createStdioMcpServer`.
- Архитектурное решение: ADR 0002 намеренно держит контекст «loose» на
  транспортном уровне, типизация — только на границе хендлера через
  `createImplement`. Типизированный tool-контекст — расширение этой линии,
  нужен **ADR**.

### Возможные подходы (решить при проработке)

1. **Generic по конфигам.** `McpMountConfig<TCtx>` и т.д., `context` типизирован,
   `ToolExtend.resolve` типизирован. Максимальная безопасность, максимально
   инвазивно.
2. **Фабрика-зеркало `createImplement`.** `createMountMcp<TCtx>()` /
   `createMountAgent<TCtx>()` — фиксируют тип контекста один раз, как
   `createImplement<TCtx>()` для HTTP. Меньше шума на каждом конфиге, тот же
   паттерн, что уже есть в фреймворке.

Рекомендация — склоняюсь к (2): консистентно с `createImplement`, не размывает
ADR 0003.

### Открытые вопросы

- Вписывается ли типизированный tool-контекст в ADR 0002 («generic core, no
  domain model»), или это новый ADR?
- Достаточно ли фабрики (подход 2), или нужны generic-конфиги (подход 1)?

---

## Item 2 — `implementRemote` и валидация remote-output

**Приоритет: P3. Скорее всего УЖЕ закрыто — нужна проверка ~2 мин.**

### Откуда

«Additional dirt» из аудита таска целостности (саб-агент по MCP-lifecycle):
*«implementRemote возвращает то, что прислал remote API, без валидации против
`outputSchema`»* — но это было замечание по коду **до** фикса F5.

### Текущая оценка

Похоже, фикс **F5** это уже закрыл. После F5 `executeToolMethod` валидирует
возврат хендлера против `outputSchema`. `implementRemote` строит `MethodDef` с
`outputSchema: endpoint.output`. Значит remote-сервис, примонтированный как
MCP/agent-тул, при дрейфе remote API ловится F5 → `INTERNAL_SERVER_ERROR`.
HTTP-путь ловит через output-parse в `server/create.ts`. Плюс типизированный
клиент сам парсит ответ через `output`.

### Что осталось

- Подтвердить, что F5 действительно покрывает `implementRemote` на обоих путях
  (тест: remote-хендлер вернул данные не по контракту → tool-вызов даёт ошибку).
- Единственный незакрытый край — контракт **без** объявленного `output`: тогда
  не валидирует ничего. Но это общее свойство любого эндпоинта без `output`, не
  специфика `implementRemote`.

### План

Проверить → если подтвердилось, закрыть как «done-by-F5» с тест-кейсом. Если
вскрылся реальный остаточный гэп — отдельно заскоупить.

---

## Item 3 — Per-session перестройка `McpServer`

**Приоритет: P4 (перф). Делать только если всплывёт в профайле.**

### Откуда

«Additional dirt» из аудита таска целостности (саб-агент по MCP-lifecycle):
`createMcpHandler` пересобирает весь `McpServer` на каждую новую сессию.

### Что за гэп

`tools/mcp-handler.ts` — в ветке «fresh session» зовётся `buildMcpServer`, то
есть `collectTools` + `mergeSchemas` + probe каждой схемы + `registerTool` —
**на каждую новую MCP-сессию**. Для статичного массива сервисов результат
детерминирован и мог бы кэшироваться.

### Почему отложено

- Чистый перф, не дефект целостности — корректно вне скоупа таска.
- Влияние малое: сессия живёт долго (много вызовов на одну сессию), не
  пересоздаётся на каждый запрос. Для десятка тулов — доли миллисекунды.
- Чистого фикса «собрать один раз» нет: в модели MCP SDK каждой сессии нужен
  свой `McpServer` + `transport` (инстанс не шарится). Кэшировать можно только
  дорогую детерминированную часть.

### План (если делать)

Когда `config.services` — статичный массив: один раз вычислить `collectTools` +
probe-результаты, на каждую сессию делать только `registerTool` по готовому
списку. Для `services` / `context` в форме функции от auth — кэш невозможен
(разные тенанты видят разные тулы), оставить как есть.

---

## Ссылки

- Исходный таск: [`docs/backlog/done/2026-05-20-tools-surface-integrity.md`](../done/2026-05-20-tools-surface-integrity.md).
- ADR 0002 (generic core), ADR 0003 (два контекста) — `docs/decisions/`.
- Код: `packages/core/src/tools/mcp.ts`, `tools/mcp-handler.ts`,
  `tools/mount.ts`, `tools/remote.ts`, `server/implement.ts`.

---

## Итог (закрыто 2026-06-05)

Сверено с кодом на момент релиза 0.4.0:

- [x] **Item 1 — типизированный tool-контекст → СДЕЛАН.** Реализован как
  `createToolkit<TContext>()` (`packages/core/src/tools/toolkit.ts`, экспорт из
  `stitchkit/tools`) + **ADR 0017** (`docs/decisions/0017-typed-tool-context.md`).
  Это ровно «подход 2» из плана (фабрика-зеркало `createImplement`), который и
  рекомендовался.
- [x] **Item 2 — `implementRemote` output-валидация → закрыт F5 (по коду).**
  `tools/execute.ts` валидирует `method.outputSchema` (`validateHandlerOutput`)
  → `INTERNAL_SERVER_ERROR` при дрейфе; `tools/remote.ts` проводит
  `outputSchema: endpoint.output`. Покрыты MCP/agent и HTTP пути. *Остаточный
  край:* отдельного подтверждающего теста на `implementRemote` не добавляли
  (P3, не блокер) — общая валидация output уже под тестами.
- [ ] **Item 3 — per-session перестройка `McpServer` → ВЫНЕСЕН.** Единственный
  живой пункт; перф P4 «делать только если всплывёт в профайле». Вынесен
  отдельной задачей на потом:
  [`docs/backlog/inbox/2026-06-05-mcp-build-per-session-cache.md`](../inbox/2026-06-05-mcp-build-per-session-cache.md).

Файл закрыт: Item 1 и 2 реализованы, Item 3 живёт отдельной inbox-заметкой.
