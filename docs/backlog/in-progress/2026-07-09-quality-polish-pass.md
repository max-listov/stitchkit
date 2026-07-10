---
title: Quality polish pass — доки, дедупликация, тесты, ленивые пиры, client parity
description: Результат 4-агентного аудита кодовой базы (ядро / tools / public API / tests+docs). База чистая; чиним реальные находки — слепой llms.txt, тихо разъехавшиеся клиентские пути, непокрытый stateful-код, дубли, падающий quick start из-за eager socket.io-client.
type: task
status: in-progress
created: 2026-07-09
updated: 2026-07-09
---

# Quality polish pass

Источник — аудит 4 read-only агентами (2026-07-09). Общий вердикт: ядро чистое,
ADR-дисциплина образцовая. Ниже — реальные находки, сгруппированные в пакеты.
Версию НЕ бампаем — копим в CHANGELOG `[Unreleased]`, релиз отдельным заходом.

## Пакет G — CORS пропускает `traceparent` (баг нашей же фичи `trace:true`) ✅

Найдено агентом на живой миграции bro. `createHttpClient({ trace: true })` (0.18)
шлёт `traceparent` на каждый запрос, а дефолтный CORS allow-headers его не
содержал → браузерный preflight падал, API мёртв cross-origin при `trace:true`.
Мы сами выкатили сломанную фичу в 0.18. Плюс три разных CORS-дефолта в коде.

- [x] `DEFAULT_CORS_ALLOW_HEADERS` (`Content-Type, Authorization, X-Trace-Id, traceparent, tracestate`) — одна shared-константа в `cors.ts`
- [x] Использована во всех трёх местах (HTTP `cors.ts`, `oauth-provider.ts`, `oauth-metadata.ts`) — 3 дивергентных дефолта → 1
- [x] `X-Trace-Id` сохранён (жив: `request.ts` читает `x-trace-id` как trace id)
- [x] Экспорт `DEFAULT_CORS_ALLOW_HEADERS` из `/server` + reference.md (расширять при override `cors.headers`)
- [x] Тесты в `middleware.test.ts` (дефолт содержит traceparent/tracestate/X-Trace-Id; override побеждает); CHANGELOG `### Fixed`; нотка в `observability.md`

## Пакет F — Тайпчек-гейт для `scripts/` (закрыт слепой каталог) ✅

Найдено при правке `gen-llms.ts`: весь `scripts/` был **вне любого tsconfig** →
`bun run check`/`verify` его не тайпчекали, ошибки всплывали только в IDE
(`node:fs`/`process`/`import.meta.dir` unknown, `readdirSync`→any→`f: any`).

- [x] `@types/bun` + `typescript` в root `devDependencies` (у корня свой `.ts`-тулинг)
- [x] `scripts/tsconfig.json` (зеркало опций `packages/core` + `"types": ["bun"]`)
- [x] `check:scripts` в root scripts, вплетён в `check` → покрыт `verify`/CI
- [x] Логика `gen-llms.ts` не менялась — файл был корректен, просто не типизирован. `check:scripts` = exit 0

## Пакет A — Docs (чинит llms.txt для агентов-потребителей) ✅

- [x] `reference.md`: дозаполнены ~45 экспортов + новая секция `/node`
- [x] Тест-гард `exports ⊆ reference.md` — `tests/reference-coverage.test.ts` (8 entrypoints)
- [x] `gen-llms.ts`: assert «каждый `docs/guide/*.md` учтён в GUIDE» (fail build иначе)
- [x] CHANGELOG-хедер исправлен (0.1.0–0.7.0 additive; первый breaking в 0.10.0)
- [x] CONTRIBUTING число тестов убрано; `verify` = +smoke:node; getting-started «five»→«eight» + полная таблица 8 entrypoints
- [x] AGENTS.md: правило `as` переписано (boundary-only, `internal/typed.ts` + external emitters)

## Пакет B — Дедупликация + мёртвый код (частично)

- [x] base64url-кодек ×3 → `internal/base64url.ts` (pagination / auth / pkce переведены)
- [ ] duplicate-name-check ×3 (mcp / agent / cli) → shared machinery → **отложено** (внутренний рефактор, низкий риск)
- [x] `errorHint` инлайн ×7 → named `ErrorHintFn` (в `execute.ts`, экспортнут + задокументирован)
- [ ] download-пайплайн ×2 (cli / mount-download) → `internal/downloadToFile` → **отложено**
- [x] Мёртвый код: `StitchServeOptions` удалён, `RouteMatch.service`/`RouteEntry.service` удалены (identity уже в `MethodDef.serviceName`). `AgentContext` — оставлен (публичный экспорт, удаление breaking, низкая ценность)

## Пакет C — Тесты (частично)

- [x] `sanitize.ts` — 16 прямых ассертов маскирования (`tests/sanitize.test.ts`)
- [ ] `mcp-handler.ts` — session store / LRU / 404 / stateless → **отложено** (M, отдельный заход)
- [x] Порт-коллизия 9899 → scoped-client на 9886 (уникален)

## Пакет D — Ленивый socket.io-client (реальный баг quick start) ✅

- [x] `socket.io-client` грузится лениво (косвенный specifier → нативный `import()`, не `__require`)
- [x] `check-browser-clean.mjs` расширен: ловит статический импорт ленивого пира из браузерного entry
- [x] Проверено: dist root entry больше не тянет пир статически; 23 socket-теста зелёные

## Пакет E — Client parity (поведенческое изменение, в CHANGELOG breaking) ✅

- [x] Оба пути валидируют `output` (ky-путь — новое, breaking); оба применяют `endpoint.timeout` (fetch — новое, аддитивно)
- [x] multipart на ky-пути уважает declared method (throw на GET/DELETE-multipart)
- [x] `onRequest` early-response получает CORS-заголовки
- [x] Parity-тесты: `tests/client-parity.test.ts` (4)
- [ ] Разрезать `client.ts` (438 строк) → **отложено** (чистый рефактор без изменения поведения, отдельный заход)

## Вынесено на отдельное решение (breaking-суждения, НЕ в этом заходе)

- Ленивость `ai` / MCP SDK по отдельности (развилка: `/agent` entry vs lazy-peer)
- Флип дефолта `stateless: false→true` в MCP-handler (меняет рантайм всем)
- Переименования (`createCli`→`runCli`, `mount*` расслоение) — копить в один breaking-заход

## Acceptance

- [ ] `bun run verify` зелёный
- [ ] Поведенческие изменения (Пакет E, mountDownload baseDir) — в CHANGELOG с явной пометкой
- [ ] Ни одно имя потребительского проекта в публичных доках
