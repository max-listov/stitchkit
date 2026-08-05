---
title: Миграция MCP-слоя на stateless core (спека 2026-07-28) — stateless по умолчанию, удаление session-store и SSE event-store
description: Спека 2026-07-28 сделала MCP stateless request/response — убраны initialize-рукопожатие и Mcp-Session-Id, legacy HTTP+SSE транспорт deprecated. У нас stateless-режим уже есть, но дефолт `false`. Миграция = перевернуть дефолт и УДАЛИТЬ stateful-обвязку (session-store, TTL, LRU, InMemoryEventStore). Гейтится мажорным бампом @modelcontextprotocol/sdk (v2).
type: task
status: icebox
created: 2026-07-28
updated: 2026-07-28
defrost: the MCP SDK v2 has settled (several patch releases) OR a consumer hits `404 Session not found` at scale that the existing `stateless: true` flag cannot solve OR a client host starts requiring the `2026-07-28` spec. The migration is a deletion (~60-90 lines), so there is no feature value in doing it early.
---

# MCP stateless core — миграция транспорта

## Что произошло в спеке

`2026-07-28` превращает MCP из stateful bidirectional в **stateless
request/response**:
- **retired**: `initialize` / `initialized` рукопожатие и заголовок
  `Mcp-Session-Id` (SEP-2575, SEP-2567). Каждый запрос самодостаточен — версия
  протокола, идентичность и capabilities клиента едут в `_meta`.
- Опциональный `server/discover` — если клиент хочет capabilities заранее.
- Любой запрос садится на **любой** инстанс за round-robin, без shared storage.
- **legacy HTTP+SSE транспорт — deprecated** (офф-рамп ≥12 мес).
- Server→client запросы (`elicitation/create`, `sampling/createMessage`,
  `roots/list`) больше не требуют открытого стрима — их заменил **MRTR**
  (отдельный таск). Долгоживущий стрим остался только как **opt-in**
  `subscriptions/listen` для нотификаций.

## Что это значит для нас — мы УМЕНЬШАЕМСЯ

Проверено по коду: `tools/mcp-handler.ts` (253 строки) уже несёт **оба** режима:
- `stateless?: boolean` — **дефолт `false`** (`mcp-handler.ts:91-99, 160`), т.е.
  по умолчанию мы работаем ровно в том режиме, который спека убирает;
- stateful-обвязка: `SessionData`-store, `SESSION_TTL_MS` 30 мин
  (`:16`), LRU `MAX_SESSIONS = 1_000` (`:21`), `InMemoryEventStore` для
  SSE-resumability по `Last-Event-ID` (`:13-58`).

Миграция — это **не «пилить новое», а выкинуть**: stateless становится
дефолтом (или единственным режимом), session-store + event-store удаляются.
Минус ~60-90 строк, совпадает с принципом «small» из VISION.

Побочно: исчезает класс инцидентов `404 Session not found` после деплоя (наш же
docstring это и обещал как мотивацию stateless-режима).

## ⚠️ Гейт — мажорный бамп SDK

Протокол реализует `@modelcontextprotocol/sdk` (наш peer `^1.29.0`), а не мы.
Новый спек = **SDK v2** (ломающий; в анонсе «client-server split, −83% размера»).
**Не бросаться на day-0.** Условия начала работ (любое из):
1. SDK v2 устоялся (несколько патч-релизов, API перестали плыть);
2. реальный потребитель упёрся в масштаб/`404 Session`,
   который решает stateless.

До этого — задача лежит в inbox осознанно.

## План (когда гейт снят)

1. Бампнуть peer `@modelcontextprotocol/sdk` → v2 (+ `peerDependenciesMeta`
   без изменений; devDep тоже).
2. Адаптировать `createMcpHandler` / `buildMcpServer` / `mcp-stdio` под новый
   API SDK (client-server split — проверить, что мы импортим).
3. **Перевернуть дефолт**: `stateless` = `true` (или убрать опцию вовсе, если
   SDK v2 не даёт stateful). Это **breaking** → `⚠️ Breaking changes` + minor bump.
4. **Удалить** `InMemoryEventStore`, `SessionData`-store, `SESSION_TTL_MS`,
   `MAX_SESSIONS` и связанные ветки. Проверить, что `mcp-handler.ts` реально
   похудел (сейчас 253 стр.).
5. Тесты: `mcp-handler` до сих пор **почти не покрыт** (аудит 2026-07-09 отметил
   253 строки stateful-логики без тестов) — покрыть **новый** stateless-путь
   in-memory `Request`-тестами (транспорт Web-standard, сервер не нужен).
6. Доки: `guide/mcp-and-agents.md` — убрать упоминания сессий/`Mcp-Session-Id`,
   описать stateless-модель и **паттерн «state = handle из тула»** (спека прямо
   рекомендует: не прятать состояние в транспорте, а выдавать явный handle,
   который модель протаскивает аргументом — это ложится на наш contract-first).
7. CHANGELOG: `⚠️ Breaking changes` (смена дефолта + удаление опций) с before→after.

## Связанные

- `2026-07-28-oauth-hardening-mcp-spec.md` — НЕ гейтится SDK, делать раньше.
- `2026-07-28-mcp-spec-followons.md` — MRTR, list-caching, extensions, CIMD.
