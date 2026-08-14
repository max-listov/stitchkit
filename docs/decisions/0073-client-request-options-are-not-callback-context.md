---
title: "ADR 0073 — Client request options are not callback context"
description: Keep generated HTTP callables compatible with query libraries by separating contract variables from transport options.
type: decision
status: accepted
created: 2026-08-14
updated: 2026-08-14
---

# ADR 0073 — Client request options are not callback context

- **Status:** Accepted — extends [ADR 0005](0005-typed-client.md),
  [ADR 0008](0008-thin-wrappers.md) and [ADR 0025](0025-typed-scoped-client.md).
- **Date:** 2026-08-14

## Context

A generated endpoint is intentionally usable as a direct `react-query-kit` or
TanStack Query callback. Those libraries invoke mutation and query functions
with contract variables first and their own execution context second. Giving a
generated endpoint an optional second `ClientRequestOptions` parameter makes
the function types incompatible and creates a runtime ambiguity when a foreign
context happens to contain a similarly named field.

Per-call cancellation still belongs on every generated client surface, but it
is transport metadata rather than part of an endpoint's contract variables or
a query library's callback context.

## Decision

Every generated endpoint is a callable object with two explicit surfaces:

- the ordinary call contains only contract arguments, or no arguments when the
  contract has none;
- `.withOptions(...)` contains the same contract arguments plus a required
  `ClientRequestOptions` object.

Both surfaces delegate to one internal `(requestArgs, options)` executor. The
ordinary callable supplies no options and therefore never inspects extra
JavaScript arguments provided by a callback host. Only `.withOptions` validates
and consumes transport options.

The previous positional options form is removed. There is no alias or overload
because retaining it would preserve the same type collision.

## Alternatives rejected

- Consumer lambdas around every client method: repetitive adaptation that hides
  a framework-owned composition regression.
- Accept both positional options and `.withOptions`: keeps the incompatible
  call signature and makes runtime ownership of the second argument ambiguous.
- Detect request options by object shape: a foreign callback context may grow a
  `signal` field, so property probing cannot establish ownership.
- Put cancellation inside contract variables: transport metadata would leak
  into request schemas, query strings and request bodies.

## Consequences

- Direct `mutationFn: api.create` and `fetcher: api.search` composition remains
  type-safe and runtime-safe.
- Imperative cancellation is slightly more explicit and mechanically
  migratable to `.withOptions`.
- Plain, batch, scoped and scope-routed clients share one callable shape and
  one request executor.
