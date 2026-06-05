---
title: RawRoute combines `:param` with a trailing `/*` (param-prefix wildcard)
description: A route like `/app/:slug/*` did not match `/app/<slug>/nested` — the raw matcher treated trailing `/*` as a literal prefix and never interpolated the `:param` before it, breaking a consumer's SPA deep-link fallback for published mini-apps.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 07:50
related: docs/decisions/0006-route-groups-query-params.md
---

# RawRoute: `:param` + trailing `/*` did not combine

## Context (from a consuming project)

A consumer serves a mini-app SPA from raw routes and needs a fallback: any nested
path `/app/<slug>/<spa/route>` → serve the HTML shell (`/app/<slug>/c/<file>` is a
chunk route). The natural shape:

```ts
{ method: 'GET', path: '/app/:slug/c/:filename', handler: serveChunk },
{ method: 'GET', path: '/app/:slug',             handler: serveShell },
{ method: 'GET', path: '/app/:slug/*',           handler: serveShell }, // SPA fallback
```

## Problem

`/app/:slug/*` **did not match** `/app/demo/nested`. The raw matcher took the
trailing `/*` as a **literal** prefix (`/app/:slug/`) and never interpolated
`:slug`, so it expected the literal string `/app/:slug/` — which a real path
never contains:

```text
GET /app/demo/nested → 404 NOT_FOUND   (expected: match /app/:slug/* → shell)
```

Effect: opening / refreshing a nested route inside a published mini-app broke
(generic 404 instead of the HTML shell).

## What was asked

Support `:param` segments combined with a trailing `/*` in one raw path:
`/app/:slug/*` should match `/app/<slug>/<anything/nested>`, put `slug` in
`ctx.params.slug`, and expose the wildcard remainder.

## Acceptance

- [x] `/app/:slug/*` matches `/app/x/a/b/c`, `ctx.params.slug === 'x'`,
      remainder in `ctx.params['*']`.
- [x] More specific routes (`/app/:slug/c/:filename`, `/app/:slug`) listed before
      the wildcard still match first.
- [x] Pure literal wildcard (`/static/*`) unchanged (still matches the bare
      prefix and nested). Doc at `RawRoute.path` updated.

## Что сделано (2026-06-05)

- [x] **`matchRawRoute`** (`server/router.ts`) — the trailing-`/*` branch now
  segment-matches the prefix (via the shared `matchSegments`), so `:param` is
  interpolated; the remainder after the prefix is `params['*']`. A pure literal
  prefix still matches the bare path and nested. Route iteration order unchanged →
  specific-before-wildcard precedence preserved.
- [x] **Tests** — `tests/raw-route-match.test.ts`: param+wildcard (nested + bare
  prefix), too-short non-match, specific-before-wildcard ordering, literal
  wildcard backward-compat, method filter.
- [x] **Docs** — `RawRoute.path` / `RawRouteContext.params` JSDoc, `guide/server.md`
  (Raw routes), `CHANGELOG` `[Unreleased]`. No new ADR (additive routing fix).
- [x] **Снять у консьюмера:** replace the `/app/*` + `pathname.split('/')[2]`
  workaround with `/app/:slug/*` reading `ctx.params.slug`.

Ships in the next release batch (additive — no breaking change).
