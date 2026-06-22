---
title: "ADR 0032 — Brand-based AppError identification (not instanceof)"
type: decision
status: accepted
created: 2026-06-22
updated: 2026-06-22
---

# ADR 0032 — Brand-based `AppError` identification (not `instanceof`)

- **Status:** Accepted — fixes the error model of [ADR 0026](0026-stitch-error-code-registry.md);
  consequence of the multi-chunk build ([ADR 0011](0011-bun-only-one-package.md) /
  [ADR 0013](0013-runtime-agnostic-core.md)).
- **Date:** 2026-06-22

## Context

`AppError.is(err)` was `err instanceof AppError`, and `normalizeError` routes every
thrown value through it: an `AppError` is returned with its own `code`, anything
else logs `[stitchkit] unhandled error` and becomes `INTERNAL_SERVER_ERROR`. Both
the tool path (`executeToolMethod` → `toolResultFromError`) and the HTTP path
(`respondError`) depend on it.

The package ships as **two independent `bun build` invocations** — a browser build
(`stitchkit`, `/react`, `/contract`) and a server build (`/server`, `/node`,
`/tools`, `/cli`, `/observability`). Each bundles its own copy of `contract/errors`,
so `class AppError` exists in two chunks. A consumer's domain error
(`class DomainError extends AppError`) extends the copy from whichever entrypoint it
imported (`stitchkit`), but the tool path runs the *server* build's copy. Thrown on
a tool call, `domainErr instanceof <server-copy>` is **false** → the consumer's
`FEATURE_LOCKED` / `NOT_FOUND` arrived at the model as `INTERNAL_SERVER_ERROR`, with
`code` / `details` / `hint` lost. A consuming project saw weak models (which can't
read the real cause) blindly retry, cascading 500s. `instanceof` is fragile across
exactly this kind of boundary — duplicate class copies, and realms (workers).

## Decision

Identify `AppError` by a **global brand**, not `instanceof`:

- The constructor stamps a non-enumerable `Symbol.for('stitchkit.AppError')`
  property on every instance.
- `AppError.is(err)` checks for that symbol (`typeof err === 'object' && err !==
  null && BRAND in err`).

`Symbol.for` resolves to a single symbol per process, so **every** chunk's copy of
`AppError` stamps and recognises the *same* brand — duplication and realm
boundaries stop mattering. A consumer subclass is recognised too (its `super()`
runs the stamp). The symbol is non-enumerable, so it never appears in
`JSON.stringify`, `toJSON`, spreads or `Object.keys`.

## Alternatives considered

- **Deduplicate `AppError` into one shared chunk.** Rejected as the primary fix:
  the browser and server builds are separate `bun build` runs with no shared chunk
  between them, so deduping needs a build restructure — and the brand makes
  duplication irrelevant, so it is unnecessary. (A single chunk would also still be
  fragile across realms.)
- **Duck-typing (`err.name === 'AppError' && typeof err.code === 'string'`).**
  Weaker — collides with any unrelated object that happens to match. The branded
  symbol is an explicit, collision-free marker.

## Consequences

- **Additive — no breaking change.** The brand recognises every value `instanceof`
  did (each instance is stamped) **plus** cross-chunk / cross-realm copies and
  subclasses. Nothing previously recognised is rejected. Ships in 0.14.0.
- **Domain errors surface correctly on every transport** — HTTP, MCP and agent
  tools alike return the real `code` / `details` / `hint`, so a model can
  self-correct instead of retrying an opaque 500.
- A consumer subclassing `AppError` across the package boundary is now safe by
  construction.
