---
title: "ADR 0021 — Endpoint meta passthrough (opaque per-endpoint metadata)"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0021 — Endpoint meta passthrough (opaque per-endpoint metadata)

- **Status:** Accepted — extends [ADR 0002](0002-generic-core.md)
- **Date:** 2026-06-05

## Context

`EndpointDef` has a **fixed** set of fields (`method`/`path`/`desc`/`scope`/
`params`/`input`/`output`/`multipart`/`timeout` + the tool fields `toolName`/
`expose`/`ui`/`annotations`). By ADR 0002 the core models **no domain** — so
there is no place to attach app-specific facts about an endpoint that the
framework should carry but not interpret: a feature gate (`requiredFeature`), a
rate tier, a cache-TTL hint, a doc/owner tag.

The only workaround in a consuming app is a side `Map<toolName, X>`, which is
brittle: HTTP-only endpoints have no `toolName`, and a hook's `MethodDef` carries
no stable key to match on. Declaring the metadata next to the endpoint is
cleaner and reusable.

## Decision

Add a generic, **opaque** metadata bag — the core gives it no meaning, exactly
as `scope` is a free string.

- **`EndpointDef.meta?: Record<string, unknown>`** (on the shared base, so both
  HTTP-only and tool endpoints carry it).
- It rides through `implement()` to **`MethodDef.meta`**, unchanged.
- Readable where the endpoint is already in scope: lifecycle hooks
  (`beforeHandle`/`afterHandle`/`onError` — second arg is the `MethodDef`) and
  tool mounts (`collectTools` → `MountableTool.method.meta`).
- **Never serialized into OpenAPI** — `meta` is app-private, not part of the
  public HTTP contract; the generator reads only the contract fields, so it is
  excluded by construction.
- **Untyped in v1** — a plain `Record<string, unknown>`; the consumer narrows
  when reading. No generic threading of a `meta` type through `defineContract`
  until there is real demand (avoids over-engineering).

## Alternatives considered

- **Side-map in the consumer** (`Map<toolName, X>`). Rejected: brittle —
  HTTP-only endpoints lack a `toolName`, no stable match key in hooks.
- **A fixed field per use case** (`requiredFeature`, `rateTier`, …). Rejected:
  it pulls the domain into the generic core — exactly what ADR 0002 forbids.
- **Generic `meta` type on `defineContract`**. Deferred: real ergonomic cost
  now for speculative type-safety; revisit on demand.

## Consequences

- Apps get a clean, declared escape-hatch for per-endpoint concerns the core
  deliberately does not model — consistent with ADR 0002 (generic core).
- Additive and optional: no behaviour change for endpoints without `meta`
  (`MethodDef.meta` is `undefined`, never `{}`).
- The core still models no domain — it transports the bag without reading it.
- If a typed `meta` is wanted later, it layers on without breaking this API.
- **Gotcha — declare meta as a `type`/inline/`satisfies`, not an `interface`.** A
  TS `interface` has no implicit index signature, so it is not assignable to
  `Record<string, unknown>`; on the overloaded `defineContract` the failure
  misleadingly reports a `scope` mismatch. Kept `Record<string, unknown>` over
  loosening to `object` (which breaks the cast-free `meta?.x` read in hooks and
  admits arrays/functions) or a generic `meta` (whose typed read never reaches
  the lifecycle hooks, which see the base `MethodDef`) — three independent
  reviews converged on documenting the idiom rather than changing the type.
  Documented in `docs/guide/contracts.md` and the `EndpointDef.meta` JSDoc.
