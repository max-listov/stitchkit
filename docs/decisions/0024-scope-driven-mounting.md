---
title: "ADR 0024 — Scope-driven mounting (scopePrefixes)"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0024 — Scope-driven mounting (`scopePrefixes`)

- **Status:** Accepted — extends [ADR 0002](0002-generic-core.md)
- **Date:** 2026-06-05

## Context

A `scope` already lives on every contract (`ContractMeta.scope` →
`ServiceDef.scope`) and drives auth (`createAuthHook` rules). A resource-scoped /
multi-tenant app needs scope to drive one more thing: the **URL prefix**. Tenant
routes are `/tenants/:tenantId/...`, project routes `/projects/:projectId/...`,
the rest flat. Today the consumer partitions services by `service.scope` into
arrays by hand and lists each under a `groups: [{ pathPrefix }]` entry — so the
scope↔prefix mapping is written twice (the partition and the group config) and
drifts. It was the single biggest source of boilerplate in the first
multi-tenant migration.

## Decision

Add **`scopePrefixes?: Record<string, string>`** to `HandlerConfig` (so both
`createServer` and `createHandler`). Each `services` entry mounts under
`scopePrefixes[service.scope]`; an unmapped scope mounts flat. A prefix may carry
`:param` segments — the router already matches them into the context (spread as
top-level keys, e.g. `ctx.tenantId`). Services listed under explicit `groups` are
unaffected — the group prefix wins.

```ts
createServer({
  services,                                   // mixed scopes, listed once
  scopePrefixes: { tenant: 'tenants/:tenantId', project: 'projects/:projectId' },
})
```

Scope stays an **opaque free string** (ADR 0002) — the core attaches no meaning
beyond this lookup. It models no "tenant": auth stays `createAuthHook`, and the
consumer's `beforeHandle` resolves the id behind the `:param`.

## Scope → handler context (the type-level half)

The companion gap — each scope guarantees different injected ctx fields, and a
single `createImplement<TCtx>` superset context types a `public` handler with a
`tenantId` that is actually `undefined` (a type lie) — is solved with the
**existing** primitive, no new API: call `createImplement<Ctx>()` **once per
scope** and implement each contract with the matching factory. Each handler is
typed exactly to its scope; no superset, no lie. A scope-keyed
`createScopedImplement` that picks the context from `meta.scope` automatically was
considered and **deferred** — the per-scope factory already removes the lie, and a
typed-by-meta binding is speculative until real demand. Documented in the
multi-tenant guide.

## Alternatives considered

- **A "tenant"/"resource" concept in core.** Rejected — violates ADR 0002.
- **Auto-`:param` → typed `ctx` field.** Deferred — that is the scope→context
  binding above; the per-scope `createImplement` covers it without new surface.

## Consequences

- The scope→prefix mapping is declared once; no hand-partitioning, no drift.
- Additive and cast-free: no `scopePrefixes` → unchanged flat mounting.
- The core still models no domain — `scope` remains a free string key.
