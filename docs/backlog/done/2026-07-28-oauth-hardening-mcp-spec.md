---
title: OAuth-провайдер — hardening под спеку MCP 2026-07-28 (RFC 9207 iss, application_type, issuer-binding)
description: Три auth-правки в НАШЕМ oauth-provider.ts, которых требует спека 2026-07-28. Главное — мы не эмитим `iss` в authorize-redirect (RFC 9207), это открытая дыра «authorization-server mix-up». Не зависит от бампа MCP SDK — чисто наш код, можно делать сразу.
type: task
status: done
created: 2026-07-28
updated: 2026-07-28
completed: 2026-07-28 21:00 +08:00
---

# OAuth hardening под MCP 2026-07-28

## Зачем

Спека MCP `2026-07-28` принесла набор auth-hardening требований. Протокольную
часть (stateless core, MRTR, header-routing) реализует `@modelcontextprotocol/sdk`
— **не мы**. Но **OAuth 2.1 authorization server у нас свой**
(`tools/oauth-provider.ts`, 452 строки: RFC 8414 metadata, RFC 7591 DCR,
`/authorize`, `/token`, PKCE) — значит весь auth-hardening это **наша работа**,
и она **не гейтится** бампом SDK. Самый высокий рычаг из всего апдейта.

## Что чинить (проверено по исходнику)

### 1. 🔴 RFC 9207 — `iss` в authorize-redirect (SEP-2468)

**Дыра:** спека требует, чтобы AS возвращал параметр `iss` в редиректе с кодом, а
клиент валидировал его **до** обмена кода на токен. Это закрывает
**authorization-server mix-up**: клиент, работающий с несколькими AS, иначе может
отдать код не тому серверу.

**У нас `iss` не эмитится.** Редирект строится `redirectWith(uri, params)`
(`oauth-provider.ts:147-151`), в вызове с `code`/`state` параметра `iss` нет
(грепал `iss=` — пусто). `config.issuer` при этом уже есть
(`oauth-provider.ts:67`) и отдаётся в AS-метаданных (`:79`).

**Фикс:** добавить `iss: config.issuer` в параметры success-редиректа
`/authorize`. По RFC 9207 — и в error-редирект тоже. Тривиально, ~1 строка + тест.

### 2. 🟠 `application_type` в DCR (SEP-837)

**Проблема:** AS-ы отклоняют `localhost`-редиректы для desktop/CLI-клиентов,
если клиент не заявил `application_type: "native"`. Классическая «почему у моего
CLI OAuth падает с `redirect_uri` error».

**У нас:** `ClientMetadata` (`oauth-provider.ts:29`) поле `application_type` не
знает; loopback-редиректы разрешаются эвристикой по хосту
(`isLoopbackHost`, `:140` — `127.0.0.1` / `::1` / `localhost`). Работает, но не
по букве спеки и не различает native vs web клиентов.

**Фикс:** принимать `application_type` (`'native' | 'web'`) в DCR, хранить на
`RegisteredClient`, и завязать разрешение http-loopback на `native` (сейчас
loopback разрешён всем). Уточнить: не сломает существующих клиентов, которые
поле не шлют → дефолт по текущему поведению.

### 3. 🟠 Client credentials bound to issuer (SEP-2352)

**Требование:** выданные клиенту креды привязаны к тому issuer, который их
выпустил; переиспользование на другом AS запрещено.

**У нас:** access-токены — HS256 JWT с `aud` = resource
(`oauth-provider.ts:9-10, 341-349`), но `iss`-claim в токене не проставляется
(в `signJwt` передаётся `audience`, `issuer` — проверить). Проверить и, если
нет, добавить `issuer: config.issuer` в подпись + документировать проверку на
стороне resource-сервера (`verifyJwt({ issuer, audience })`).

## План

1. Прочитать SEP-2468 / SEP-837 / SEP-2352 (через context7 `/modelcontextprotocol/modelcontextprotocol`) — сверить дословные MUST, не по блогу.
2. `iss` в `/authorize` success+error redirect (`redirectWith` callsites).
3. `application_type` в `ClientMetadata` + `RegisteredClient` + логика loopback.
4. `issuer` в access-token JWT (если отсутствует) + дока проверки на RS.
5. Тесты в `oauth.test.ts` (там уже 24 теста — дописать: `iss` присутствует и равен issuer; native-клиент с loopback ок; issuer в токене).
6. Доки: `guide/mcp-and-agents.md` (секция OAuth) — что мы теперь compliant с 2026-07-28 auth.
7. CHANGELOG `### Added` / `### Fixed` (аддитивно; `iss` в редиректе — новое поле, клиенты его игнорируют, если не проверяют).

## Оговорки

- Ничего из этого **не требует** бампа `@modelcontextprotocol/sdk` — наш код.
- **DCR формально deprecated** в пользу CIMD (12+ мес окно) — это НЕ повод не
  чинить DCR сейчас; CIMD вынесен в отдельный таск (см. followons).

## Что сделано

- [x] **Пункт 3 (issuer-binding) — оказался УЖЕ сделан.** `signJwt(..., { issuer: config.issuer })` (`oauth-provider.ts:348` до правок) — access-token и раньше нёс `iss`. Дописан тест-замок + доки (`verifyJwt(..., { audience, issuer })`).
- [x] **Пункт 1 (RFC 9207 / SEP-2468)** — `iss` на всех authorize-редиректах через единый хелпер `redirectToClient` (нельзя забыть на callsite; 5 точек переведены) + `authorization_response_iss_parameter_supported: true` в AS-метаданных. **Метаданные — та деталь, которой не было в блоге:** нашлась только при чтении SEP через context7 (без анонса клиент не знает, что параметр авторитетен).
- [x] **Пункт 2 (SEP-837)** — `application_type` в `ClientMetadata`/`RegisteredClient` + новый экспорт `ApplicationType`; `isHttpUri` → `isRegistrableRedirectUri(uri, applicationType)`: `web` = https-only, `native` = loopback ок, **поле опущено = прежнее поведение** (не ломаем существующих клиентов), неизвестное значение = `invalid_client_metadata`.
- [x] Тесты: +9 в `oauth.test.ts` (33 pass) — iss в success/error редиректе, анонс в метаданных, iss в токене, native/web/omitted/невалидный application_type.
- [x] Доки: `guide/mcp-and-agents.md` (раздел «Authorization hardening (MCP 2026-07-28)» + нотка про deprecation DCR→CIMD), `reference.md` (`ApplicationType`).
- [x] CHANGELOG `### Added` (аддитивно).

## Что НЕ делалось

- CIMD — отдельный таск (`2026-07-28-mcp-spec-followons.md`), окно 12 мес.
- Транспорт/stateless — гейтится SDK v2 (`2026-07-28-mcp-stateless-core-migration.md`).
