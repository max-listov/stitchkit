---
title: "ADR 0094: Auth hook composition is owned and atomic"
description: Typed auth domains compose through private ownership metadata and commit context only after every applicable hook succeeds.
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0094 — Auth hook composition is owned and atomic

## Context

Applications with several authentication domains manually dispatched scopes
and intersected inferred context maps. That duplicated framework mechanics,
could run an unrelated resolver and could expose partial context when a later
domain failed.

## Decision

`composeAuthHooks({ hooks, defaultScope })` composes only Stitchkit-created
scoped auth hooks. Module-private ownership metadata and a nominal type brand
associate each declared scope with its hook; consumers do not maintain a second
scope registry.

For a request, only owners of the selected scope run, in declaration order.
Each evaluates against an isolated shadow context. Contributions are prepared
without mutation, checked for reserved keys and cross-owner collisions, and
committed to the real runtime context once after every owner succeeds. Unknown
scopes fail closed. A default scope is explicit and belongs to the composed
surface.

## Consequences

- `ComposedAuthScopes` is inferred from the hooks themselves; manual type
  intersections and dispatchers disappear.
- A failed composed request cannot expose a partial contribution to a handler.
- Domain policy and resolver side effects remain application-owned and cannot
  be rolled back by the framework.
- Isolation is per-key, not deep. The shadow copies property descriptors, and a
  contribution is the set of keys whose descriptor changed, compared by
  `Object.is`. A hook that mutates an existing context value **in place**
  (`ctx.user.role = 'admin'`) therefore reaches the shared object and is not
  reported as that hook's contribution. Framework-owned keys stay protected
  either way; hooks are expected to contribute new fields, not edit another
  owner's object.

