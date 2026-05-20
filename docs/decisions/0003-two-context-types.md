---
title: "ADR 0003 — Two context types: RuntimeContext and HandlerContext"
type: decision
status: accepted
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0003 — Two context types: `RuntimeContext` and `HandlerContext`

- **Status:** Accepted
- **Date:** 2025-05

## Context

A handler wants a typed context — `ctx.params` and `ctx.input` shaped by the
endpoint's schemas — for a good developer experience. But the transport layer
assembles the context *before* those types are known: right after a Zod parse,
`params` and `input` are `unknown`.

An earlier framework used a single `HandlerContext<TParams, TInput>` everywhere,
including in the transport, and bridged the gap with `as` casts — one in the
transport, another in the handler-binding step.

## Decision

Split the context into two interfaces.

- **`RuntimeContext`** — `{ params: unknown, input: unknown, … }`. Used by the
  transport and by lifecycle hooks. No generics, no casts.
- **`HandlerContext<P, I>`** — `{ params: P, input: I, … }`. Used only inside
  handlers, where the types are known.

`implement()` is the bridge. It accepts typed `Handlers<C>` and wraps each one
as a `MethodDef.handler(ctx: RuntimeContext)`. Runtime safety comes from the
Zod parse that runs before the handler; type safety comes from generics that
infer `P` and `I` from the endpoint schemas.

## Consequences

- Zero `as` casts on the framework's request path.
- The transport works with loose `unknown` types and never lies about them.
- Handlers see a fully typed context; the cast that used to bridge the two
  worlds no longer exists — it was replaced by an honest type boundary.
