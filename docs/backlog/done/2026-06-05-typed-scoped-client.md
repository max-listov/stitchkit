---
title: Typed scoped client — type the pathPrefix-consumed keys as client args
description: createClient's ContractClientConfig.pathPrefix + stripPrefixKeys work at runtime, but the typed client signature doesn't add the consumed keys to each method's args. A per-tenant client consumer hand-wrote a ~100-line type wrapper just to put `tenantId` into every method's argument type. Make the consumed keys typed.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0005-typed-client.md, docs/decisions/0025-typed-scoped-client.md
---

# Typed scoped client

**Type: DO (types, generic).** Surfaced wiring a per-tenant frontend client in a
consumer migration. The runtime is already there; only the types are missing.

## Problem

`createClient(contract, http, { pathPrefix: (a) => \`tenants/${a.tenantId}/\`,
stripPrefixKeys: ['tenantId'] })` works at **runtime** — it injects the prefix
and strips `tenantId` from query/body. But the **type** of the returned client is
`TypedHttpClient<T>`, whose method args come only from the endpoint schemas — so
`tenantId` is **not** in the argument type. Calling `api.list({ tenantId, ... })`
is a type error, even though the runtime needs `tenantId`.

The consumer worked around it with a hand-written type layer (~100 lines): a
`ScopedClient<C>` that intersects `{ tenantId: string }` into every method's args
and casts the `createClient` result to it. Pure boilerplate that the framework
could infer from `stripPrefixKeys`.

## Proposal

Make `createClient`'s third arg type-aware: the keys named in `stripPrefixKeys`
(or a typed equivalent) become **required** arguments in every method signature.

```ts
const api = createClient(widgets, http, {
  pathPrefix: (a) => `tenants/${a.tenantId}/`,
  stripPrefixKeys: ['tenantId'] as const,
})
api.list({ tenantId, status })   // tenantId now typed + required, no wrapper
```

So `TypedHttpClient<T>` gains the consumed keys: `EndpointArgs<E> & { [K in
consumed]: string }`. The consumer deletes its scoped-client type wrapper.

## Scope — generic only

- ✅ Take: thread the `stripPrefixKeys` literal into the client method arg types
  (consumed key → required `string` arg).
- ✂️ Leave out: scope semantics — this is purely "the client needs the keys its
  own `pathPrefix` consumes", inferred from config.

## Acceptance

- [x] `stripPrefixKeys` (as a `const` tuple) adds those keys as required args to
      every method of the returned client; runtime unchanged — `createClient<T,
      const K>` → `ScopedHttpClient<T, ScopedKeys<K>>`.
- [x] A consumer needs no hand-written type wrapper for a per-tenant client —
      verified by the `@ts-expect-error` type tests.
- [x] Docs — `guide/multi-tenant.md` (step 4) + `api/reference.md` (`ScopedHttpClient`).
      No `as` (only the pre-existing internal proxy `as unknown as` in `createClient`).
- [x] `bun run verify` green — 414 tests.

## Что сделано (2026-06-05)

- [x] **Scoped types** — `contract/define.ts`: `ScopedEndpointFn<E, Extra>`,
  `ScopedHttpClient<C, Extra>`; `TypedHttpClient<C> = ScopedHttpClient<C, unknown>`
  (structurally identical → no breakage). Exported via `contract/index.ts` + root.
- [x] **`createClient<T, const K>`** — `browser/client.ts`: `ContractClientConfig<K>`
  with `stripPrefixKeys?: readonly K[]`; returns `ScopedHttpClient<T, ScopedKeys<K>>`
  (`ScopedKeys<never> = unknown` → plain client unchanged). `const K` → no `as const`
  needed at the call site.
- [x] **Tests** — `tests/scoped-client.test.ts`: runtime (prefix applied, unscoped 404s)
  + type-level `@ts-expect-error` (tenantId required; plain client has no tenantId),
  validated by `tsc --noEmit`.
- [x] **Docs + ADR** — `guide/multi-tenant.md`, `api/reference.md`, `CHANGELOG`,
  **ADR 0025**.
- [x] **pathPrefix callback typing** — kept `Record<string, unknown>` (typing it with
  the consumed keys created variance friction with the runtime factory; the method
  args are the real win). Noted in ADR 0025.

Ships in the **0.6.0** batch.
