---
title: "ADR 0004 — Four lifecycle hooks instead of a middleware chain"
type: decision
status: superseded
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0004 — Four lifecycle hooks instead of a middleware chain

- **Status:** Superseded by [ADR 0072](0072-http-authorization-precedes-payload-parsing.md)
- **Date:** 2025-05

## Context

An earlier framework used Hono's per-path `.use()` middleware: a registration
step mounted middleware by scope, and request behaviour was assembled from a
chain of middleware functions. That chain is a framework-specific construct —
adopting it means adopting the framework (see ADR 0001).

stitchkit still needs the cross-cutting behaviour middleware usually provides:
logging, auth, response shaping, error formatting.

## Decision

Four lifecycle hooks, plain functions, no chain:

- **`onRequest(req)`** — runs first; logging, rate limiting. May short-circuit
  with a `Response`.
- **`beforeHandle(ctx, endpoint)`** — auth, scope checks. Runs after the context
  is built, before the handler.
- **`afterHandle(ctx, result, endpoint)`** — response transform, cache headers,
  audit logging. May replace the result.
- **`onError(ctx, error, endpoint)`** — error formatting, alerting.

Route groups (ADR 0006) may carry their own hooks. Execution order is
global hook → group hook → handler.

## Consequences

- Hooks are ordinary functions with zero framework dependency — the opposite of
  middleware lock-in.
- The four hooks cover every cross-cutting concern the source projects needed.
- There is no composable middleware *pipeline* — hooks are flat, not chained.
  Behaviour that a middleware stack would compose is instead expressed as plain
  code inside a hook. For stitchkit's scope this is simpler, not weaker.
