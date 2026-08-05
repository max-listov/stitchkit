---
title: Quality polish pass — доки, дедупликация, тесты, ленивые пиры, client parity
description: Результат 4-агентного аудита кодовой базы (ядро / tools / public API / tests+docs). База чистая; чиним реальные находки — слепой llms.txt, тихо разъехавшиеся клиентские пути, непокрытый stateful-код, дубли, падающий quick start из-за eager socket.io-client.
type: task
status: done
created: 2026-07-09
updated: 2026-08-05
completed: 2026-08-05 17:30 +07:00
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
- [x] duplicate-name-check ×3 (mcp / agent / cli) → shared machinery → **вынесено** в `2026-08-05-internal-refactors-deferred.md`. За месяц «сделать заодно» не случилось ни разу; зато появилось внешнее обоснование — ADR 0035 опирается на эту дедупликацию как на гарантию, а живёт она в трёх копиях
- [x] `errorHint` инлайн ×7 → named `ErrorHintFn` (в `execute.ts`, экспортнут + задокументирован)
- [x] download-пайплайн ×2 (cli / mount-download) → **вынесено** туда же. Оценка честная: ценность только читаемость, отдельного захода не заслуживает
- [x] Мёртвый код: `StitchServeOptions` удалён, `RouteMatch.service`/`RouteEntry.service` удалены (identity уже в `MethodDef.serviceName`). `AgentContext` — оставлен (публичный экспорт, удаление breaking, низкая ценность)

## Пакет C — Тесты (частично)

- [x] `sanitize.ts` — 16 прямых ассертов маскирования (`tests/sanitize.test.ts`)
- [x] `mcp-handler.ts` — **сделано** (`tests/mcp-handler-sessions.test.ts`, 7 тестов).
      Покрыты не happy-path (его и так гоняют все прочие MCP-тесты через `mountMcp`),
      а собственные гарантии хендлера: identity резолвится ДО всего остального —
      включая запрос с session-id, иначе украденный id обходил бы гейт целиком;
      неизвестный id получает 404 и **не усыновляется** (server никогда не минтит
      сессию под клиентское значение — это и делает id неугадываемым на практике);
      выданный id — UUID и принимается на следующем запросе; `stateless: true`
      реально не заводит сессию (ветка 404 обходится — в этом и смысл: рестарт
      сервера не инвалидирует клиента)
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
- [x] Разрезать `client.ts` (438 строк) → **вынесено** туда же. Чистый рефактор публичного пути; прикрыт `client-parity.test.ts`, но не исчерпывающе — брать только вместе с другой работой в этом файле

## Вынесено на отдельное решение (breaking-суждения, НЕ в этом заходе)

- Ленивость `ai` / MCP SDK по отдельности (развилка: `/agent` entry vs lazy-peer)
- Флип дефолта `stateless: false→true` в MCP-handler (меняет рантайм всем)
- Переименования (`createCli`→`runCli`, `mount*` расслоение) — копить в один breaking-заход

## Acceptance

- [x] `bun run verify` зелёный — exit 0, **657 pass / 0 fail**, build + Node smoke
- [x] Поведенческие изменения (Пакет E, mountDownload baseDir) — в CHANGELOG, проверено грепом
- [x] Ни одно имя потребительского проекта в публичных доках — **найдено нарушение и исправлено**.
      Грепом по `docs/` + `README` + `CHANGELOG` + `AGENTS.md` + `skills/` нашлись
      четыре файла. Два из них я написал сам в этой сессии (`icebox/response-meta-cookies`,
      `icebox/mcp-stateless-core-migration`) — обезличены. Оставшиеся два лежат в
      `done/`, который по правилу иммутабелен: не трогал, фиксирую как известное
      расхождение — при следующем разборе `done/` их стоит вычистить отдельно

## Что сделано в закрывающем заходе (2026-08-05)

Таска висела в `in-progress` с 09.07 с 27 закрытыми пунктами и 7 открытыми.
Закрыта без «доделок ради галочки»:

- [x] **Единственный пункт с реальной ценностью — сделан.** `mcp-handler.ts` был
      единственным существенным stateful-куском ядра без прямого покрытия, и он же
      тот, который когда-нибудь будет мигрировать на stateless-ядро — тесты нужны
      как страховка ДО миграции, а не после. 7 тестов, зелёные с первого прогона,
      что само по себе подтверждает: поведение соответствует тому, что о нём
      написано в докстрингах.
- [x] **Три рефактора — вынесены, а не «сделаны быстренько».** Все три не меняют
      поведения; ни один за месяц не был взят «заодно». Собраны в
      `2026-08-05-internal-refactors-deferred.md` с честной оценкой: делать стоит
      только дедупликацию duplicate-name-check, у которой появилось внешнее
      обоснование (ADR 0035 сделал её документированной гарантией, живущей в трёх
      копиях). Остальные два — косметика.
- [x] **Acceptance проверен фактически, а не отмечен.** Третий пункт оказался
      нарушен — и частично мной же в этой сессии. Исправлено там, где файлы не в
      `done/`.

**Gate:** `bun run verify` exit 0 — 657 pass / 0 fail.
