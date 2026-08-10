---
title: "MCP OAuth — Client ID Metadata Documents (CIMD)"
description: "Сделать URL-based client metadata каноническим modern MCP registration path с SSRF-safe fetch, validation, caching и issuer-bound authorization flow."
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:14 +00:00
related:
  - docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
  - docs/backlog/done/2026-07-28-oauth-hardening-mcp-spec.md
---

# MCP OAuth CIMD

## Зачем

Собственный OAuth provider Stitchkit уже реализует RFC 9207 `iss`, issuer-bound
tokens, PKCE, application type и RFC 9728 discovery. Но клиент всё ещё появляется
через unauthenticated Dynamic Client Registration write endpoint.

Modern MCP рекомендует Client ID Metadata Documents: HTTPS URL документа является
`client_id`, authorization server загружает metadata on demand и проверяет
redirect URI по авторитетному документу. Это убирает неограниченный registry и
expiry credentials, но создаёт серьёзную SSRF/cache/redirect security boundary,
которой должен владеть framework.

## Результат

- OAuth provider принимает HTTPS metadata URL как `client_id`.
- Metadata загружается безопасно, строго валидируется и привязывается к exact URL.
- Authorization request разрешает только redirect URI из проверенного документа.
- Fetch имеет timeout, size/content-type/redirect limits и SSRF policy.
- Cache уважает HTTP freshness, bounded и не превращает stale документ в вечную
  регистрацию.
- DCR остаётся только как отдельно объявленная protocol interoperability option
  на время interoperability window; CIMD является default, DCR включается явно.
- Discovery публикует `client_id_metadata_document_supported: true`; поле
  `registration_endpoint` и route `/register` существуют только при включённом DCR.

## Security model

- `client_id` — exact absolute HTTPS URL документа: без credentials, fragment,
  dot-segments и query (query запрещён policy ради однозначной identity).
- Loopback exception относится к `redirect_uris` native client-а; сам CIMD
  `client_id` остаётся HTTPS.
- DNS resolution и каждый redirect target проверяются против private, loopback,
  link-local, metadata-service и non-routable addresses; DNS rebinding не должен
  обходить policy.
- Redirect URI сравнивается exact, без prefix/subdomain matching.
- Metadata parsing — Zod schema; неизвестные безопасные поля могут сохраняться
  только если это нужно spec, security-critical поля перечислены явно.
- Outbound request использует `AbortSignal.timeout`, bounded bytes и допустимый
  JSON content type.
- Cache key — canonical metadata URL; fetch result не шарится через иной client ID.
- Pre-resolution + обычный `fetch(hostname)` запрещён: он уязвим к DNS rebinding.
  Runtime adapter соединяется с уже проверенным IP, сохраняя original hostname
  для TLS SNI/Host и повторяя всю policy на каждом redirect.
- `client_id` в body документа обязан byte-for-byte совпасть с requested URL;
  обязательны `client_name` и непустые `redirect_uris`. Display metadata
  sanitizes/escapes; Stitchkit не скачивает logo URI на authorization path.

## Целевая публичная форма

```ts
mountOAuthProvider({
  issuer,
  clientRegistration: {
    preRegistered: { get: findRegisteredClient },
    cimd: {
      cache: { maxEntries: 1_000, maxTtlMs: 3_600_000 },
      fetcher: createSecureClientMetadataFetcher(),
    },
    dcr: false,
  },
});
```

Для legacy host consumer осознанно меняет `dcr: false` на `{ register }`.
Именно это добавляет `/register` и `registration_endpoint`; aliases и hidden
fallback отсутствуют.

## План

- [x] Прочитать финальный auth section `2026-07-28`, SEP-991 и актуальный OAuth
      Client ID Metadata Document draft, закреплённый MCP release (draft `-00`);
      отдельно проверить дельту актуального draft (`-02+`) и не принять её молча.
- [x] Заменить обязательные `clients.register/get` на discriminated config:
      `clientRegistration: { cimd: { ... }, dcr: false | { register(...) } }` плюс
      exact pre-registered resolver. Default: CIMD enabled, DCR false.
- [x] Резолвить client строго: exact pre-registered entry → HTTPS URL CIMD →
      opaque unknown client отказ; opaque DCR id существует только после явно
      включённого `/register`. Hidden fallback между mechanisms запрещён.
- [x] Добавить Zod schema + inferred metadata type; не дублировать existing
      registered-client type там, где поля семантически совпадают.
- [x] Реализовать Fetch-clean policy engine и server-only secure HTTP adapter:
      resolve all addresses, reject forbidden ranges, pin validated IP for socket,
      preserve original SNI/Host, повторять validation на redirect; timeout,
      redirect count, max bytes и JSON content type. Injectable DNS/connector/clock
      используются в deterministic tests, не как consumer workaround.
- [x] Реализовать bounded HTTP-aware cache: positive freshness, controlled
- [x] Уважать `Cache-Control`, `Age`, `Expires`, validators (`ETag`/
      `Last-Modified`) и framework caps; stale identity fail-closed, если
      revalidation не удалась. Redirect aliases не создают второй cache identity.
- [x] На `/authorize` определить URL client ID, загрузить metadata, проверить
- [x] На создании authorization code snapshot-ить exact `clientId`, redirect URI,
      PKCE challenge и approved scopes; `/token` проверяет сохранённый snapshot и
      не перефетчивает изменившийся metadata document.
- [x] Сохранить существующие PKCE, issuer response parameter, token issuer/audience
      и consent boundaries; CIMD не выдаёт client secret.
- [x] Разрешить public clients только с token endpoint auth method `none`.
      Secret-based metadata auth запрещена; `private_key_jwt` не добавлять без
      отдельного consumer case и `jwks` validation task.
- [x] Discovery modes покрыть тестами: CIMD-only не имеет `/register` и
      `registration_endpoint`; CIMD+DCR имеет оба; explicit pre-registered-only
      не заявляет неподдерживаемую capability.
- [x] Negative tests: HTTP URL, credentials/fragment, private IP, redirect в private
      network, DNS rebinding simulation, oversized/non-JSON/invalid metadata,
      redirect URI mismatch, timeout, cache poisoning и stale metadata.
- [x] Positive tests: hosted web client, native metadata allowed final spec,
      cache hit/revalidation, issuer-bound complete authorization-code flow.
- [x] Consent seam показывает sanitized `client_name` и exact origin/client ID,
      отдельно предупреждает про loopback native redirect; не доверяет logo URI.
- [x] Обновить OAuth architecture/guide/API и migration section: как разместить
      metadata document и когда временно включать DCR interoperability.

## Не входит

- Hosting metadata documents за consumer-а.
- OAuth client implementation.
- Enterprise Managed Authorization.
- Бессрочное сохранение fetched documents в БД Stitchkit.

## Acceptance

- [x] HTTPS metadata URL работает как client ID в полном authorize→token flow.
- [x] Redirect URI и client properties берутся только из validated metadata.
- [x] SSRF matrix и DNS/redirect/timeout/size limits покрыты тестами.
- [x] Cache bounded, freshness observable и не принимает stale identity молча.
- [x] Existing RFC 9207/PKCE/issuer/audience tests остаются зелёными.
- [x] CIMD default и DCR interoperability policy явно описаны без hidden fallback.
- [x] Metadata `client_id` exact-match, required fields, query/credentials/
      fragment/dot-segment rejection и native loopback redirect покрыты тестами.
- [x] CIMD-only discovery/route surface не содержит DCR; DCR route появляется
      только при explicit config.
- [x] Authorization code/token flow использует сохранённый client/redirect
      snapshot и устойчив к metadata change между `/authorize` и `/token`.

## Конвейер 2/2 со стопом

- [x] Валидатор плана 1: OAuth/CIMD spec и SSRF/cache security.
- [x] Валидатор плана 2: provider architecture/public config/migration impact.
- [x] Findings внесены; ожидается owner stop-gate перед кодом.
- [x] Валидатор реализации 1: security and protocol conformance audit.
- [x] Валидатор реализации 2: API/flow/cache tests and docs audit.

## Правки валидатора 1

- DNS rebinding закрывается pinned-IP connector с original SNI/Host, а не
  небезопасной парой pre-resolve + обычный fetch.
- Уточнены exact URL identity, required metadata fields, redirect/native rules,
  conditional revalidation и authorize→token snapshot semantics.
- Зафиксирован MCP-referenced draft baseline и обязательный audit новых drafts.

## Правки валидатора 2

- Выбран один conditional config: CIMD default, DCR explicit; route и discovery
  metadata DCR исчезают при выключенном DCR.
- Задан детерминированный resolver precedence без hidden fallback.
- Consent/display data sanitizes, secret auth и logo fetching исключены из scope.

## Что сделано

- [x] CIMD-first client resolution с explicit DCR mode реализован в
      `packages/core/src/tools/oauth-provider.ts`; discovery/route surface следует
      выбранной policy без hidden fallback.
- [x] Zod-first metadata model, exact client identity и redirect snapshot проходят
      полный authorize→token flow.
- [x] HTTPS-only secure fetch с DNS/IP pinning, original SNI/Host, redirect,
      timeout и response-size limits реализован в
      `packages/core/src/internal/secure-fetch.ts`.
- [x] Bounded HTTP-aware positive/negative cache поддерживает freshness,
      validators и observable `CimdCacheEvent`.
- [x] SSRF, metadata mutation, native loopback, PKCE, issuer/audience и conditional
      DCR matrix покрыты `packages/core/tests/oauth.test.ts` и
      `packages/core/tests/secure-fetch.test.ts`.
