---
title: "ADR 0006 — Route groups and GET/DELETE query params"
type: decision
status: accepted
created: 2026-05-13
updated: 2026-05-20
---

# ADR 0006 — Route groups and GET/DELETE query params

- **Status:** Accepted
- **Date:** 2026-05-13

## Context

Two gaps surfaced when preparing real projects to run on stitchkit:

1. `buildContext()` ignored `inputSchema` for GET and DELETE — every `list`
   endpoint with filters (`?status=active&limit=20`) was broken.
2. Some projects mount services under a path prefix
   (`/bots/:botId/...`, `/api/{prefix}/...`). stitchkit only built flat paths.

## Decision

**Query params on GET and DELETE.** GET and DELETE parse `inputSchema` from the
URL query. `searchParams.getAll()` supports repeated keys as arrays
(`?tag=a&tag=b`). DELETE sniffs the content-type: a JSON body when
`application/json`, the query otherwise. Coercion is the schema author's
responsibility — query params are always strings; a schema that wants a number
uses `z.coerce.number()`. The framework adds no automatic coercion (rejected:
auto-coerce primitives — magic; a `withQueryCoercion` helper — redundant with
`z.coerce.*`).

**Route groups.** `ServerConfig` accepts `groups: RouteGroup[]` alongside flat
`services`. A `RouteGroup` has a `pathPrefix`, its `services`, and optional
per-group `hooks`. `:param` segments from the prefix (`:botId`) are matched and
placed into the context. (Rejected: a `scopePaths` map keyed by the scope string
— ties URL structure to the scope vocabulary; a mutable `ServiceDef.pathPrefix`
— mutating the service after `implement()` is dirty.) Flat `services` remain
valid, so the simple case stays simple.

## Consequences

- List endpoints work with query filters; arrays are supported.
- Grouping is explicit and decoupled from the scope vocabulary; per-group hooks
  enrich the context (e.g. resolve `:botId`) before the handler runs.
- Coercion stays in the contract — no framework magic to reason around.
