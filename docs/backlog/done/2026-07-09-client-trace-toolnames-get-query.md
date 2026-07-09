---
title: Клиентский traceparent + listToolNames + fail-first GET-query
description: Три quality-of-life пункта из миграционного отчёта потребителя — trace-опция в createHttpClient, дамп имён тулов для CI-снапшотов, громкая ошибка на несериализуемый GET/DELETE input вместо тихого дропа.
type: task
status: done
created: 2026-07-09
updated: 2026-07-09
completed: 2026-07-09 20:40 +08:00
---

# Клиентский trace + tool-name baseline + fail-first GET-query

## Контекст

Отчёт агента, мигрирующего a consuming project на stitchkit 0.17.0: ни один
пункт не блокирует миграцию, но потребители дублируют обвязку, которую логично
поднять в пакет. Четвёртый кандидат отчёта (runtime-регистрация сервисов /
hot-plug) **отклонён** — мутабельный роутер усложняет ядро ради гипотетической
задачи; модули грузятся до `createServer`, фиксируется порядок бута.

## Пункты

### 1. Client-side trace propagation — `createHttpClient({ trace: true })`

Сервер уже продолжает входящий W3C `traceparent`
(`resolveTraceContext`), но клиент stitchkit его не эмитит — каждый потребитель
городит свою headers-функцию (в т.ч. нестандартный `x-trace-id`, который
серверная сторона не понимает). Генерация уже в пакете
(`createTraceContext` / `formatTraceparent`, Web-clean) — нужно:

- [x] Опция `trace?: boolean` в `HttpClientConfig` — на каждый запрос свежий root-trace в заголовке `traceparent` (уже выставленный вручную заголовок не перетирается) — `src/browser/http.ts`
- [x] Browser-safe реэкспорт trace-хелперов из корневого entry (`createTraceContext`, `formatTraceparent`, `parseTraceparent`, `childSpan`, `TraceContext`) — `src/index.ts`
- [x] Тесты: заголовок валиден по W3C-формату, разный на каждый запрос, отсутствует без опции, ручной заголовок побеждает — `tests/client.test.ts`
- [x] Доки: `guide/client.md` (`HttpClientConfig`), `guide/observability.md` (клиентская сторона трейса), `api/reference.md`

### 2. `listToolNames(services)` — baseline имён тулов

Имена MCP/agent-тулов частично автовыводятся (`toolName` override, иначе
`toToolName(service, method)`). Смена деривации при апгрейде обязана попадать в
`### ⚠️ Breaking changes`, но потребителю нужен механический способ это
поймать — CI-снапшот «имена не дрейфанули» и дифф при миграции.

- [x] `listToolNames(services): ToolNameEntry[]` (`{ name, service, method, transports }`, отсортировано) поверх `collectTools` — ноль дублирования expose-логики — `src/tools/list-names.ts`
- [x] Экспорт из `stitchkit/tools` — `src/tools.ts`
- [x] Тесты: derived + override имена, expose-фильтры, CLI opt-in, multipart skip, стабильная сортировка — `tests/list-tool-names.test.ts`
- [x] Доки: `guide/mcp-and-agents.md`, `api/reference.md`

### 3. Fail-first GET/DELETE query input

Вложенный объект в input GET/DELETE-эндпоинта клиент сейчас **молча
выбрасывает** (не сериализует вообще) — тихая порча запроса. Конвенция «что
можно в query-input» нигде не задокументирована.

- [x] Громкая ошибка на несериализуемое значение (объект / массив с не-примитивами / функция) в query-input — оба клиентских пути (`HttpClient`-адаптер и bare-fetch) — `src/browser/client.ts`
- [x] Док-раздел «что можно в GET/DELETE input» — `guide/contracts.md`
- [x] Тесты: объект в GET-input бросает с именем поля и эндпоинтом (оба пути); плоские поля и массивы примитивов работают как раньше — `tests/client.test.ts`
- [x] `### ⚠️ Breaking changes` в CHANGELOG (стало строже: тихий дроп → ошибка)

## Acceptance

- [x] `bun run verify` зелёный
- [x] CHANGELOG `[Unreleased]`: Breaking (GET-query) + Added (trace, listToolNames)
- [x] Ни одно имя потребительского проекта не попало в публичные доки/CHANGELOG

## Что сделано

Вышло в релизе **0.18.0** (breaking → minor bump по конвенции).

- **Core:**
  - [x] `trace?: boolean` в `HttpClientConfig` + генерация `traceparent` в `beforeRequest` — `packages/core/src/browser/http.ts`
  - [x] Browser-safe реэкспорт trace-хелперов — `packages/core/src/index.ts` (browser-clean гейт зелёный)
  - [x] `listToolNames` / `ToolNameEntry` — `packages/core/src/tools/list-names.ts`, экспорт в `packages/core/src/tools.ts`
  - [x] Fail-first валидация query-input (общий `collectQueryParams` на оба клиентских пути) — `packages/core/src/browser/client.ts`
- **Тесты:** 8 новых в `tests/client.test.ts` (4 query fail-first + 4 trace), 4 в новом `tests/list-tool-names.test.ts`. Полный прогон: 499 pass / 0 fail.
- **Доки:** `guide/contracts.md` (раздел «Query input (GET / DELETE)» + исправлена неверная формула дефолтного toolName), `guide/client.md`, `guide/observability.md`, `guide/mcp-and-agents.md` («Pinning tool names»), `api/reference.md`.
- **Что НЕ делалось (осознанно):** runtime-регистрация сервисов — отклонена (over-engineering, модули грузятся до `createServer`); идеи из «дублей по флоту» — заведены отдельными файлами в `inbox/` (scoped-contract-factory, error-hook-skeleton, transport-summary, entity-cache-handlers), не реализовывались.
- **Ссылки:** CHANGELOG `## [0.18.0]` (`### ⚠️ Breaking changes` + `### Added`).
