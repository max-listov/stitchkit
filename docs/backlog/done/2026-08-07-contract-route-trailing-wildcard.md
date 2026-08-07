---
title: Contract routes support a trailing wildcard
description: Make a contract path such as /app/:slug/* match nested paths with typed slug and wildcard remainder parameters.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 12:13 +00:00
related: docs/backlog/done/2026-06-05-raw-route-param-plus-wildcard.md
---

# Contract routes support a trailing wildcard

## Confirmed defect

`matchRoute()` delegates to `matchSegments()`, which rejects any request whose
segment count differs from the contract pattern. A contract endpoint at
`/app/:slug/*` therefore returns 404 for every nested path even though the raw
router already supports the equivalent trailing-wildcard shape.

The existing public wildcard promise is currently attached to `RawRoute`, not
to contract endpoints. This patch makes the contract behaviour an explicit
public guarantee rather than documenting the current 404 as supported.

## Plan

- [x] Defined one terminal-wildcard matching rule shared by contract and raw
      routes: named prefix params are decoded normally and the remaining path
      segments are returned as `params['*']`.
- [x] Matched `/app/foo/page` and `/app/foo/a/b` as
      `{ slug: 'foo', '*': 'page' | 'a/b' }`.
- [x] Preserved raw-route parity for the bare prefix: `/app/foo` matches with an
      empty wildcard remainder; `/app` remains too short and does not match.
- [x] Made route ordering explicit: static routes first, named-param routes
      next and a terminal wildcard last, so a catch-all cannot steal a more
      specific endpoint.
- [x] Routed `allowedMethods()` through the same semantics so a wildcard path
      returns 405 + the correct `Allow` header instead of 404 for another verb.
- [x] Covered direct matcher behaviour and a full contract-handler round trip,
      including a params schema with `{ slug, '*': remainder }`.
- [x] Audited shadow-route diagnostics and OpenAPI/client representation so the
      new contract surface does not leave a second silent interpretation of
      `/*`.
- [x] Taught both typed-client transports to consume the `'*'` params field and
      expand it into separately encoded path segments (`'a/b'` → `/a/b`), never
      a query field or a literal `/*`.
- [x] Kept OpenAPI standards-honest: retained the literal runtime path, omitted `*`
      from standard `in: path` parameters (OpenAPI has no multi-segment path
      parameter) and emitted an explicit `x-stitchkit-trailing-wildcard` extension
      carrying the wildcard schema and semantics.
- [x] Updated contract/server documentation and the unreleased changelog.
- [x] Ran `bun run verify`; version bump, commit, tag and publication remain behind
      the owner's separate release command.

## Acceptance

- [x] `GET /app/:slug/*` reaches the contract handler for one or many trailing
      segments and exposes the exact expected path params.
- [x] Params Zod validation, lifecycle hooks and raw responses use the normal
      contract pipeline; no raw fallback is required.
- [x] Specific routes retain precedence over the wildcard regardless of
      declaration order.
- [x] Wrong-method requests resolve to 405 rather than 404.
- [x] Bare-fetch and `HttpClient` typed clients both generate the nested URL and
      preserve segment boundaries without encoding `/` into `%2F`.
- [x] The generated OpenAPI document is internally valid and explicitly marks
      the non-standard catch-all instead of presenting it as a normal path
      template parameter.
- [x] Existing exact, named-param and raw wildcard behaviour does not regress.
- [x] `bun run verify` passes, including the packed-package consumer lane. npm
      publication remains a separate release operation.

## Deliberate boundary

- No consuming repository is changed from this task.
- No compatibility shim or second router is introduced.
- The implementation and gates are approved. No commit, tag or release occurs
  without a separate explicit command.

## Что сделано

- [x] **Router:** `packages/core/src/server/router.ts` uses one segment matcher
      for contract and raw trailing wildcards, ranks catch-alls last and applies
      the same semantics to method discovery and shadow diagnostics.
- [x] **Contract surface:** `packages/core/src/contract/define.ts` documents the
      terminal wildcard and its typed `params['*']` field.
- [x] **Typed clients:** `packages/core/src/browser/client.ts` consumes `'*'`,
      encodes each remainder segment independently and excludes it from the
      query/body payload.
- [x] **OpenAPI:** `packages/core/src/server/openapi.ts` emits
      `x-stitchkit-trailing-wildcard` and avoids claiming that `*` is a standard
      path-template parameter.
- [x] **Tests:** `packages/core/tests/contract-route-wildcard.test.ts`,
      `packages/core/tests/client.test.ts` and `packages/core/tests/openapi.test.ts`
      cover matcher precedence, lifecycle/validation, 405, raw responses,
      clients, shadow diagnostics and schema publication.
- [x] **Docs:** `docs/guide/contracts.md`, `docs/guide/client.md`,
      `docs/guide/server.md` and `CHANGELOG.md` describe the public behaviour.
- [x] **Gates:** `bun run verify` passed: lint, typecheck, 832 tests, build,
      Node smoke and packed-package consumer lane.
- [x] **Not performed:** no consuming repository, commit, version, tag, push or
      npm publication was changed.
