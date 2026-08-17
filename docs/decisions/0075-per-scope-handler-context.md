---
title: "ADR 0075 — Per-scope handler context (createScopedImplement)"
description: Handlers are typed by their endpoint's effective scope through one application-declared scope map, and the contract factory holds endpoint scope overrides to that vocabulary.
type: decision
status: accepted
created: 2026-08-17
updated: 2026-08-17
---

# ADR 0075 — Per-scope handler context (`createScopedImplement`)

- **Status:** Accepted — supersedes the deferred scope→context clause of
  [ADR 0024](0024-scope-driven-mounting.md)
- **Date:** 2026-08-17

## Context

`createImplement<TCtx>()` fixes one handler-context type for a whole application.
When each scope guarantees different injected fields, that single type is a
superset: a `public` handler is typed with a `userId` that the runtime never
injects into an anonymous call. The type states something concrete and the
runtime hands back `undefined`.

ADR 0024 named this gap and **deferred** a scope-keyed factory, judging a
typed-by-meta binding speculative and proposing an existing-primitive workaround:
call `createImplement<Ctx>()` once per scope and implement each contract with the
matching factory.

Real code invalidated the workaround. The effective scope is chosen **per
endpoint**, not per contract — one contract routinely carries endpoints of two or
three scopes, and per-endpoint overrides outnumber contract-level ones. Splitting
by scope to satisfy the workaround means splitting the contracts themselves, i.e.
reshaping an application's public API to work around a typing limitation.

Note the difference from what 0024 deferred: that clause described a factory
keyed on the contract's `meta.scope`. This decision binds the **effective scope
of each endpoint** — `endpoint.scope ?? contract.meta.scope ?? 'public'`, the
same resolution `bindContract` already performs at runtime.

## Decision

Add **`createScopedImplement<TScopes>()`** to `stitchkit/server`. `TScopes` maps
each scope key to the extra context fields that scope guarantees. The returned
factory infers the contract's scope literal and types every non-streaming handler
by its endpoint's effective scope.

The map is **type-only**, mirroring `createImplement<TCtx>()`: context fields are
types, and a runtime map would force `{} as UserFields` at the call site. A scope
outside the map is a compile error in the handler map's value position, so the
compiler names the offending scope rather than reporting `not assignable to
never`.

`createContractFactory<Scope>()` is tightened in the same pass: a per-endpoint
`scope` override must now belong to the factory's union. The contract-level scope
was already held to it; the override — where typos are densest — was not.

## Consequences

- The superset lie is gone: a field of another scope no longer types as `string`.
- **It degrades to `unknown`, not to a compile error on access.**
  `RuntimeContext` / `HandlerContext` carry `[key: string]: unknown` because
  transports and `:param` spreading write through it (→ ADR 0024, ADR 0003).
  Removing it to obtain a hard error would be a far larger break than this
  decision buys. Using an `unknown` field in a typed position still fails, which
  is what catches the bug class in practice.
- **The map is an application claim the framework does not verify.** Injection is
  done by the consumer's `beforeHandle` / `createAuthHook.inject`, which is one
  function for all scopes. A scope map that promises a field nobody injects will
  type-check and yield `undefined` at runtime — the same failure the decision
  removes elsewhere. The scope map, the auth rules and `scopePrefixes` remain
  three declarations the application keeps in agreement.
- `const` inference has a boundary: an endpoint hoisted out of the contract
  literal widens `scope` to `string`, which is no key of any map, so such an
  endpoint reports instead of silently inheriting the group scope. Documented in
  the server guide and pinned by a type-test.
- The scope map is offered in all three shapes an application already uses, so
  adopting one primitive never costs the typing of another: the single-contract
  factory, `createScopedImplementRegistry` for the registry form, and
  `createScopedImplement(...).stream(scope, …)` for streaming multipart. The
  streaming builder requires the endpoint to declare its own `scope` and accepts
  only that literal: an endpoint inheriting the contract's scope is not visible
  from that call site, and typing it against a guessed scope would rebuild the
  superset. `defineMultipartStream` keeps the loose `RuntimeContext`, and
  `createMultipartStream<Ctx>()` covers applications on a single context type.
- The context base is `RuntimeContext`, not `HandlerContext`: the latter pins
  `params`/`input` to `undefined`, and intersecting that with an endpoint's
  inferred shapes reduces the whole context to `never` — silently, because
  `never` is assignable everywhere. A type-test with `params` and `input` pins
  this.
- Scope keys must be string literals. A map declared as an index signature makes
  the guard vacuous, and a numeric key is unreachable; both are documented rather
  than defended against, since the map is written once per application.
- `createImplement` is untouched; single-scope applications keep the simpler
  primitive.

## Alternatives considered

- **Split `RuntimeContext` into a field interface plus an index-signature
  variant**, so a foreign field becomes a hard error. Rejected for now — it
  changes the public context types every consumer and every transport names, for
  a strictly better error on one axis.
- **A runtime scope map.** Rejected — it buys nothing the type system needs and
  forces a cast on the application side.
- **Keeping the ADR 0024 workaround.** Rejected — it is unusable wherever the
  effective scope varies per endpoint, which is the normal case.
