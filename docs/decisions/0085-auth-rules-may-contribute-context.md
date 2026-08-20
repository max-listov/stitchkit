---
title: "ADR 0085: Auth rules may contribute typed context"
description: Async auth resolvers may return validated plain-object context fields; the hook remains the single runtime and type source.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0085 — Auth rules may contribute typed context

## Context

An authorization rule often resolves membership or ownership before it can
decide. Applications then duplicated the resolved fields in a handwritten scope
map, so the declared handler context could drift from the fields actually added
at runtime.

## Decision

An auth rule may return `true`, `false`, or a plain-object context contribution,
synchronously or asynchronously. `false` denies, `true` authorizes without new
fields, and an object authorizes and contributes its inferred fields. The return
type is the source for `AuthScopes` and scoped handler inference.

Before any mutation, Stitchkit validates the whole contribution. Arrays,
non-plain objects, accessors, symbols, unsafe prototypes, `__proto__`, proxies
that fail inspection, and runtime-owned context keys are rejected with a stable
framework error. A failed contribution cannot partially mutate the context.
Existing scoped `inject` uses the same merger.

## Consequences

- One resolver drives runtime authorization and handler types.
- A `false | object` rule contributes required fields; `true | object` makes
  those fields optional. Union object variants retain only their sound common
  guarantees.
- Domain roles and membership logic remain application-owned.
- Invalid legacy falsy returns other than `false` now fail instead of silently
  authorizing; this is an intentional breaking correction.
