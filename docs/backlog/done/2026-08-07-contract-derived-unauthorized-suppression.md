---
title: Contract-derived unauthorized suppression
description: Вычислять expected-401 route matchers из contract operations вместо ручных authEndpoints path prefixes
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 13:51 +00:00
related:
  - docs/backlog/done/2026-08-07-all-http-endpoint-urls.md
  - docs/backlog/done/2026-08-07-scope-aware-composed-client-registry.md
---

# Contract-derived unauthorized suppression

## Архитектурная граница

Expected 401 — явная consumer policy. Framework не угадывает auth по имени или
scope, а строит точные matchers из выбранных contract operations.

## План

- [x] Prefix-only `authEndpoints` заменён единым `suppressUnauthorizedFor`.
- [x] Matcher использует contract prefix, endpoint path и `ContractClientConfig`.
- [x] Static segments, params и trailing wildcard сопоставляются точно.
- [x] Поддержаны individual operations и whole-contract shorthand.
- [x] Dynamic prefix компилируется через declared `stripPrefixKeys` без runtime id.
- [x] Non-HTTP selection и underspecified dynamic config падают fail-first.
- [x] Helper generic: cookies/login/scope naming отсутствуют.
- [x] Legacy `authEndpoints` и implicit `/auth/` default удалены без alias.
- [x] Обновлены client/auth guides, API reference, llms, changelog и upgrading.

## Tests

- [x] Selected expected 401 не эмитит event; соседний protected endpoint эмитит.
- [x] Contract prefix является единственным route source.
- [x] Shared prefix не подавляет соседний endpoint.
- [x] Params, dynamic prefix, wildcard и encoded segments покрыты.
- [x] Whole-contract и конкретные selections покрыты одним transport runtime.
- [x] Logout/reset semantics не изменились.
- [x] Полный `bun run verify` зелёный: 863 tests, build, Node smoke, consumer lane.

## Acceptance

- [x] Consumer не повторяет auth route строками.
- [x] Expected-401 policy остаётся явной и generic.
- [x] Route matching следует contract/pathPrefix semantics.
- [x] Broad prefix suppression удалён.

## Что сделано

- [x] Browser API: `contractEndpointMatchers` реализован в
      `packages/core/src/browser/client.ts`.
- [x] Matcher compiler: exact segment matching реализован в
      `packages/core/src/browser/client-url.ts`.
- [x] HTTP policy: `suppressUnauthorizedFor` реализован в
      `packages/core/src/browser/http.ts`.
- [x] Tests: `packages/core/tests/unauthorized-matchers.test.ts`.
- [x] Docs и migration: `docs/guide/client.md`, `docs/guide/auth-and-errors.md`,
      `docs/guide/upgrading.md`, `docs/api/reference.md`, llms и changelog.
- [x] Validation: полный `bun run verify` прошёл.
- [x] Не делалось: commit, push, release, deploy и внешняя consumer migration.
