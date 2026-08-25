---
title: "ADR 0026 — Published stitch error-code registry"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0026 — Published stitch error-code registry

- **Status:** Accepted — extends [ADR 0002](0002-generic-core.md)
- **Date:** 2026-06-05

## Context

By ADR 0002 an error `code` is a free string — the core models no domain, so
app codes (`BOT_NOT_FOUND`, `ARTIFACT_IN_USE`) belong to the consumer. But
stitchkit **itself** throws a fixed set of codes: from the typed helpers
(`badRequest` → `BAD_REQUEST`, …), from `normalizeError` (`VALIDATION_ERROR` /
`INTERNAL_SERVER_ERROR`) and from the router (`METHOD_NOT_ALLOWED`). That set was
**private** — a `const ERROR_STATUS` map inside `errors.ts`, with no exported
type or registry.

The first consuming project had to map stitch's framework errors onto its own
wire codes in an `onError` hook. With nothing exported, it **hand-copied** the
code strings into a `Record<string, AppCode>`. Brittle: when stitch adds or
renames one of its own codes, a hand-copied map silently misses it and the error
collapses to `INTERNAL_SERVER_ERROR` (500) — exactly the bug that surfaced
(`METHOD_NOT_ALLOWED` from a wrong-verb request returned 500 instead of 405).

## Decision

Publish stitchkit's own error codes as a single, typed registry, and derive the
type from it so the two never drift:

```ts
export const STITCH_ERROR_STATUS = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, CONFLICT: 409, RATE_LIMITED: 429,
  VALIDATION_ERROR: 400, INTERNAL_SERVER_ERROR: 500,
} satisfies Record<string, number>

export type StitchErrorCode = keyof typeof STITCH_ERROR_STATUS
export function isStitchErrorCode(code: string): code is StitchErrorCode
```

- **One source of truth** — the map. `StitchErrorCode` is `keyof typeof` it (no
  duplicated string list), via `satisfies` (not `as` — keeps literal keys while
  type-checking the values). Adding a code in one place updates the type.
- Exported from `stitchkit` and `stitchkit/server`. `appError()` and the router
  now resolve status through it (so `METHOD_NOT_ALLOWED` → 405, not the 500
  fallback).
- The **mapping** stitch-code → app-code stays the consumer's job (it is domain —
  the app decides `BAD_REQUEST` → `VALIDATION_ERROR`). stitch only provides the
  stable, typed source so a consumer's map is keyed by `StitchErrorCode`.

  > **Superseded in part by [ADR 0105](0105-the-error-code-map-is-partial-and-the-registry-is-complete.md).**
  > This clause originally read "a consumer's map is
  > `Record<StitchErrorCode, AppCode>` — a missing or renamed code becomes a
  > **TypeScript error**, not a silent 500". That has the wrong sign: the code
  > set grows in ordinary releases, so an exhaustive map breaks a consumer's
  > build on an **additive** one. `codeMap` became `Partial` in 0.56.1 and an
  > omitted code falls through to `unmappedCode`. Everything else in this ADR
  > stands.

ADR 0002 still holds: app codes remain free strings the core never sees; this
registry is only the codes stitchkit *itself* authors.

## Alternatives considered

- **Keep it private, let consumers copy the strings.** Rejected — that is the
  brittle hand-copied map that caused the 500 regression.
- **A TS `enum`.** Rejected — a `const … satisfies` map derives the type *and*
  carries the statuses in one declaration; an enum would still need a separate
  status map (the duplication this ADR removes).

## Consequences

- A consumer maps stitch → app errors against a typed, exhaustive reference; the
  compiler catches drift.
- `appError('METHOD_NOT_ALLOWED')` and the router now carry 405 correctly.
- Naming is `Stitch*` (the framework's own codes), not `Framework*` — it is
  stitchkit's vocabulary, owned and published.
