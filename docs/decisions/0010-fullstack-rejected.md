---
title: "ADR 0010 — Grow stitchkit into a fullstack framework"
type: decision
status: rejected
created: 2026-05-13
updated: 2026-05-20
---

# ADR 0010 — Grow stitchkit into a fullstack framework

- **Status:** Rejected
- **Date:** 2026-05-13 (explored), 2026-05-20 (rejected)

## Context

There was a push to grow stitchkit from a contract-and-transport library into a
full fullstack framework — SSR, HMR, a dev-server integration, file-based
routing, server functions, type-safe links — "to the level of TanStack Start or
Next.js".

## What was explored

- A **Vite dev-server integration**: `createHandler()` was split out of
  `createServer()` so Vite middleware could call the request handler directly;
  a `stitchkit/vite` plugin routed API requests and SSR through it.
- An **SSR path**, an **HMR client**, and a render error boundary.
- Two earlier dev-server attempts were tried and abandoned first: a
  Bun-HTML-import server (single 2+ MB bundle, slow browser parse, broken code
  splitting) and a `bun build --watch` dual-process (live reload only, no true
  HMR, dev code leaking into request hooks).

## Decision

**Rejected for the core.** The projects consuming stitchkit are Next.js apps or
Vite single-page apps. They already own a frontend toolchain; a fullstack layer
inside stitchkit is redundant for every actual consumer.

The Layer-1 fullstack code — the Vite plugin, the SSR module, the HMR client,
the prebundle plugin — was deleted.

## What survived

- The **Ky-based HTTP client** (`createHttpClient`) — genuinely useful on its
  own, independent of any fullstack ambition. Kept; it backs the typed client
  in ADR 0005.
- The bundled `starter` example uses plain Vite as its own toolchain — it does
  not depend on a stitchkit fullstack layer.

## Consequences

- stitchkit stays a contract layer plus a transport (ADR 0008) — focused, small.
- If the fullstack ambition is ever revived, it belongs in a separate
  `stitchkit-fullstack` package, never in the core.
