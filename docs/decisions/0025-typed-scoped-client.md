---
title: "ADR 0025 — Typed scoped client (consumed keys as args)"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0025 — Typed scoped client (consumed keys as args)

- **Status:** Accepted — extends [ADR 0005](0005-typed-client.md)
- **Date:** 2026-06-05

## Context

`createClient(contract, http, { pathPrefix, stripPrefixKeys })` already injects a
URL prefix and strips the consumed keys from the query/body at **runtime**. But
the returned type was `TypedHttpClient<T>`, whose method args come only from the
endpoint schemas — so a key the prefix consumes (`tenantId`) was **not** in the
argument type. `api.list({ tenantId, … })` was a type error even though the
runtime needs it. A per-tenant consumer worked around it with a hand-written
~100-line `ScopedClient<C>` wrapper that intersected `{ tenantId: string }` into
every method and cast the result.

## Decision

Make `createClient`'s third arg type-aware: the keys named in `stripPrefixKeys`
become **required `string` args** on every method of the returned client.

- `ContractClientConfig<K extends string>` — `stripPrefixKeys?: readonly K[]`.
- `createClient<T, const K>` — the `const` type parameter infers the key tuple as
  literals (no `as const` needed at the call site).
- Return type `ScopedHttpClient<T, ScopedKeys<K>>` where
  `ScopedKeys<K> = [K] extends [never] ? unknown : { [P in K]: string }`. Each
  method's args become `EndpointArgs<E> & Extra`.
- `TypedHttpClient<C>` is redefined as `ScopedHttpClient<C, unknown>` —
  `EndpointArgs & unknown = EndpointArgs`, so a plain client is unchanged and
  every existing usage keeps compiling.

```ts
const api = createClient(widgets, http, { stripPrefixKeys: ['tenantId'] })
api.list({ tenantId, status })   // tenantId typed + required, no wrapper
```

Runtime behaviour is unchanged — this is purely the type catching up to what
`stripPrefixKeys` already does. The consumer deletes its scoped-client wrapper.

## Alternatives considered

- **Keep the hand-written wrapper.** Rejected — ~100 lines of boilerplate per
  consumer for what the config already implies, and it needed an `as` cast.
- **Type the `pathPrefix` callback arg with the consumed keys too.** Dropped —
  it created variance friction with the runtime method factory for marginal
  gain; the method args (the real ask) are what carry the keys.

## Consequences

- A resource-scoped client is fully typed from config alone — no wrapper, no `as`.
- `TypedHttpClient` is now an alias of `ScopedHttpClient<C, unknown>`; structurally
  identical, so no breakage.
- Scope-agnostic: the client only knows it needs the keys its own `pathPrefix`
  consumes — no domain model (ADR 0002 upheld).
