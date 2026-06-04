---
title: Endpoint meta passthrough — generic per-endpoint metadata bag
description: Добавить EndpointDef.meta (opaque Record) → проброс в MethodDef → доступно в lifecycle hooks и tool-mounts. Generic escape-hatch под app-specific метадату endpoint'а (feature-gate, rate-tier, cache-hint, doc-tag), которую generic-ядро намеренно не моделирует.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 21:10
related: docs/decisions/0002-generic-core.md, docs/decisions/0021-endpoint-meta-passthrough.md
---

# Endpoint meta passthrough

## Проблема

`EndpointDef` имеет **фиксированный набор полей** (`method/path/desc/scope/params/
input/output/multipart/timeout` + tool-поля `toolName/expose/ui/annotations`). Нет
способа прикрепить к endpoint'у **app-specific метадату**, которую generic-ядро
намеренно не моделирует (по ADR 0002 — no domain model).

Реальные кейсы проекта-консьюмера, у которого это всплывает прямо сейчас:

- **feature-gate** — endpoint доступен только на определённом тарифном плане
  (`requiredFeature: 'broadcasts'`); проверка в `beforeHandle` ПЕРЕД хендлером;
- на будущее — rate-limit тиры, cache-TTL хинты, doc/owner-теги per-endpoint.

Сегодня единственная альтернатива — side-map `Map<toolName, X>` в проекте, но она
хрупкая: HTTP-only endpoint'ы не имеют `toolName`, а `MethodDef` в hooks не несёт
стабильного service-идентификатора для матчинга. Декларация метадаты рядом с
endpoint'ом — чище и переиспользуема.

## Дизайн

Generic **opaque** мешок метадаты — ядро НЕ придаёт ему смысла (как `scope` —
free string; полностью в духе ADR 0002). Консьюмер сам сужает тип при чтении.

```ts
// EndpointDefBase
meta?: Record<string, unknown>
```

Проброс по цепочке: `EndpointDef.meta` → `MethodDef.meta` → доступно в:
- `LifecycleHooks.beforeHandle(ctx, endpoint)` / `afterHandle` / `onError`
  (`endpoint.meta?.X`) — основной кейс (auth/feature-gate);
- tool-mounts (`mountMcp` / `mountAgent` — `method` уже в скоупе) — на случай
  per-tool метадаты.

**Минимализм v1:** `Record<string, unknown>`, без generic-типизации
`defineContract` под meta (over-engineering — отложить до реального спроса).

**НЕ светить meta в OpenAPI** — это app-private метадата, не часть публичного
HTTP-контракта. `openapi.ts` мешок игнорирует.

## Файлы

- `packages/core/src/contract/define.ts` — `EndpointDefBase.meta?: Record<string, unknown>`.
- `packages/core/src/server/implement.ts` — скопировать `meta: endpoint.meta` в
  `methods[key]` (рядом с `outputSchema: endpoint.output`, ~стр 25–37).
- `packages/core/src/server/types.ts` — `MethodDef.meta?: Record<string, unknown>`.
- `packages/core/src/server/openapi.ts` — убедиться, что meta не попадает в spec
  (скорее всего и так не копируется — проверить, при необходимости явно пропустить).
- Проверить, что hooks уже получают `MethodDef` (получают: `types.ts` —
  `beforeHandle(ctx, endpoint: MethodDef)`); tool-mounts читают `method` (читают).

## Тесты (`packages/core/tests`)

- meta round-trip: `defineContract` с `meta:{...}` → `implement` → `MethodDef.meta`
  идентичен.
- `beforeHandle(ctx, endpoint)` видит `endpoint.meta` (HTTP-путь).
- meta сохраняется на tool-mount (MCP/agent — `method.meta` доступен).
- endpoint без meta → `MethodDef.meta === undefined` (не падает, не `{}`).
- meta НЕ появляется в выводе OpenAPI-генератора.

## Доки

- `docs/guide/contracts.md` — строка `meta` в таблице полей endpoint'а + короткий
  абзац «opaque app metadata, ядро смысла не придаёт; читается в hooks».
- `docs/api/reference.md` — если перечисляет поля `EndpointDef`, добавить `meta`.
- `CHANGELOG.md` `[Unreleased]` — строка про `EndpointDef.meta`.

## ADR

Новый **ADR 0021** — `docs/decisions/0021-endpoint-meta-passthrough.md` + строка в
`docs/decisions/README.md` (index). Suть: extends ADR 0002 — generic-ядро не
моделирует домен, но даёт типизированный opaque escape-hatch под per-endpoint
метадату; альтернативы (side-map в консьюмере; расширение фикс-полей под каждый
кейс) отвергнуты.

## Гейт

`bun run verify` зелёный (lint + typecheck + test + build); `dist/` пересобран.
Public API change → CHANGELOG + тест (по `AGENTS.md`). Релиз (bump + tag) — по
решению владельца, можно батчем с другими изменениями `[Unreleased]`.

## Acceptance

- [x] `EndpointDef.meta` + `MethodDef.meta` (opaque `Record<string, unknown>`).
- [x] `implement` пробрасывает meta.
- [x] meta читается в `beforeHandle`/`afterHandle`/`onError` и на tool-mounts.
- [x] meta НЕ в OpenAPI.
- [x] Тесты + доки (contracts.md, CHANGELOG) + ADR 0021 + index-row.
- [x] `bun run verify` зелёный.

---

## Что сделано (2026-06-05)

### Code
- [x] `EndpointDef.meta?: Record<string, unknown>` на `EndpointDefBase`
  (`packages/core/src/contract/define.ts`) — на общей базе, доступно обоим членам
  union (HTTP-only и tool).
- [x] `MethodDef.meta?: Record<string, unknown>` (`packages/core/src/server/types.ts`).
- [x] `implement()` пробрасывает `meta: endpoint.meta` без guard'а
  (`packages/core/src/server/implement.ts`).
- [x] OpenAPI — правок не потребовалось: `openapi.ts` берёт только конкретные
  поля метода, `meta` не читает → в спеку не попадает (проверено).

### Tests (`packages/core/tests/endpoint-meta.test.ts`, 5 тестов)
- [x] round-trip contract→implement→`MethodDef.meta`; endpoint без meta →
  `undefined` (не `{}`); `beforeHandle` видит `endpoint.meta` (HTTP-путь);
  meta доезжает до tool-mount (`collectTools(service,'MCP')`); meta НЕ в выводе
  `generateOpenApiDocument`.

### Docs / ADR
- [x] `docs/guide/contracts.md` — строка `meta` в таблице полей + секция
  «Endpoint metadata (`meta`)» с примером feature-gate в `beforeHandle`.
- [x] `docs/decisions/0021-endpoint-meta-passthrough.md` + строка в
  `docs/decisions/README.md` (index).
- [x] `CHANGELOG.md` `[Unreleased]` — «Endpoint metadata passthrough».
- `docs/api/reference.md` — без правок: перечисляет экспорты по entrypoint'ам,
  не поля `EndpointDef` (так что поля `meta` там и не было).

### Что НЕ делалось
- Generic-типизация `meta` через `defineContract` — отложена (over-engineering до
  реального спроса; зафиксировано в ADR 0021).

### Verify
- [x] `bun run verify` — зелёный (lint + tsc + **356 pass/0 fail** + build).

### Релиз
- Вышло в **0.5.0** (minor — новое публичное поле).
