---
title: "ADR 0086: Lifecycle composition is explicit and ordered"
description: Small composers combine existing HTTP and tool lifecycle phases without adding middleware or changing hook ownership.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0086 — Lifecycle composition is explicit and ordered

## Context

Applications repeatedly assembled `auth → policy → audit identity` chains. Flat
hooks remain the correct execution model, but hand-written forwarding duplicated
ordering, fallthrough and result-transform semantics.

## Decision

`composeLifecycleHooks(...hooks)` and `composeToolLifecycle(...hooks)` compose
the existing phase interfaces. Request/authorization/before phases run in
declaration order. A returned `Response` short-circuits `onRequest`; `onError`
continues until one hook returns a `Response`. Result transforms feed the current
value to the next hook, and `undefined` preserves it. A throw stops the chain and
is handled by the existing outer error boundary. The same context and
`AbortSignal` object is passed through unchanged.

The composers install no policy, catch no domain errors, and introduce no
middleware engine.

## Consequences

- Applications declare policy order once and keep each rule independently
  testable.
- Existing lifecycle error and observability ownership is unchanged.
- HTTP and tool composers stay separate because their phase contracts differ.
