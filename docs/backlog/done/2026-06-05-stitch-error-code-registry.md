---
title: Publish stitch error-code registry (STITCH_ERROR_STATUS / StitchErrorCode)
description: The codes stitchkit itself emits (NOT_FOUND, METHOD_NOT_ALLOWED, BAD_REQUEST, …) were a private const. Consumers hand-copied them to map framework→app errors → brittle (a renamed code silently became 500). Export a single code→status map with the type derived from it.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 03:00
related: docs/decisions/0026-stitch-error-code-registry.md, docs/decisions/0002-generic-core.md
---

# Publish stitch error-code registry

**Type: DO (code + ADR).** Root of the migration's H1: stitch framework errors
collapsed to `INTERNAL_SERVER_ERROR` (500) in the consumer's wire envelope.

## Problem

A `code` is a free string (ADR 0002) — app codes are the consumer's. But stitch
**itself** emits a fixed set (`BAD_REQUEST`/`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/
`METHOD_NOT_ALLOWED`/`CONFLICT`/`RATE_LIMITED`/`VALIDATION_ERROR`/
`INTERNAL_SERVER_ERROR`). That set was **private** (`const ERROR_STATUS` in
`errors.ts`) with no exported type. The consumer hand-copied the strings into an
`onError` map → brittle: a `METHOD_NOT_ALLOWED` (wrong verb) wasn't in the copy →
fell to 500 instead of 405.

## Design (per maintainer review)

One source of truth, no duplicated string list, **not** named `Framework*` →
named **`Stitch*`** (it's stitchkit's own vocabulary). The map is the source; the
type is `keyof typeof` it, via `satisfies` (not `as`):

```ts
export const STITCH_ERROR_STATUS = { BAD_REQUEST: 400, …, METHOD_NOT_ALLOWED: 405, … }
  satisfies Record<string, number>
export type StitchErrorCode = keyof typeof STITCH_ERROR_STATUS
export function isStitchErrorCode(code: string): code is StitchErrorCode
```

Cleaner than an `enum + Record<enum, status>` (two declarations): here the
map carries the statuses *and* derives the type in one place.

## Acceptance

- [x] `STITCH_ERROR_STATUS` + `StitchErrorCode` (`keyof`, no dup) + `isStitchErrorCode`,
      exported from `stitchkit` and `stitchkit/server`.
- [x] `appError()` (and the router via it) resolve status through the registry —
      `METHOD_NOT_ALLOWED` → 405, app code → 500.
- [x] No `as` (uses `satisfies`). ADR + docs. `bun run verify` green.

## Что сделано (2026-06-05)

- [x] **`contract/errors.ts`** — replaced the private `ERROR_STATUS` with exported
  `STITCH_ERROR_STATUS` (`satisfies Record<string, number>`, + `METHOD_NOT_ALLOWED:
  405`), derived `StitchErrorCode = keyof typeof`, added `isStitchErrorCode`;
  `appError` resolves status through it.
- [x] **Exports** — `contract/index.ts` + `server/index.ts` (+ root via `export *`).
- [x] **Tests** — `tests/errors.test.ts`: registry values, guard (stitch vs app
  code), `appError('METHOD_NOT_ALLOWED')` → 405 / app code → 500.
- [x] **ADR 0026** + index row; `guide/auth-and-errors.md` ("Stitch codes vs your
  codes" + the `Record<StitchErrorCode, AppCode>` mapping pattern); `api/reference.md`;
  CHANGELOG.
- [x] **Снять у консьюмера:** the consumer's framework-code map becomes
  `Record<StitchErrorCode, AppCode>` — drift now a TS error, not a silent 500.

**Verdict:** stitch publishes its own codes; mapping stays the consumer's domain.
Ships in **0.7.0**.
