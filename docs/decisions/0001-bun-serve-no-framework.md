---
title: "ADR 0001 — Build on Bun.serve(), no HTTP framework"
type: decision
status: accepted
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0001 — Build on `Bun.serve()`, no HTTP framework

- **Status:** Accepted
- **Date:** 2025-05

## Context

stitchkit was extracted from several existing projects. Those projects ran on
HTTP frameworks — Hono and Elysia — and used only a thin slice of each: routing,
CORS, cookies, and JWT verification. The rest of every framework's surface went
unused, while the dependency, its release cadence and its idioms were inherited
wholesale.

stitchkit needs an HTTP layer. The question was whether to adopt a framework or
build directly on the runtime.

## Decision

Build directly on `Bun.serve()`. No Hono, no Elysia, no Express.

The features actually used — route matching, CORS, cookies, JWT, request
logging, trace ids — are roughly 100 lines of code on top of raw Bun. stitchkit
ships them itself.

## Alternatives considered

- **Hono.** Mature, portable. But it was used at ~5% of its surface, and
  portability across runtimes is irrelevant to a Bun-only project (see
  ADR 0011). Adopting it means inheriting framework lock-in for no gain.
- **Elysia.** Fast through aggressive JIT. But `Bun.serve()`'s native router is
  implemented in Zig and SIMD-accelerated — faster without the JIT warm-up — and
  Elysia is still a framework dependency.

## Consequences

- Zero HTTP-framework dependency; zero lock-in.
- No off-the-shelf middleware ecosystem — CORS, auth, cookies are written
  in-house (~100 lines total).
- Full control of the request pipeline — the route table, trace ids, startup
  route validation, and a built-in request logger (enabled with `logging:
  true`, or replaced by a custom `StitchLogger`) are all stitchkit's own code.
- The framework is bound to Bun (see ADR 0011) — an accepted trade-off.
