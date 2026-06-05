---
title: Scope-driven mounting — scope→pathPrefix groups + scope-typed handler context
description: Scope today drives only auth. A multi-tenant consumer also needs scope→URL-prefix (resource-scoped paths like /tenants/:id/...) and scope→handler-context guarantees. Both are hand-rolled today — manual group partitioning + one "superset" context that lies. Make scope drive path + context generically, scope still a free string.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0002-generic-core.md, docs/decisions/0024-scope-driven-mounting.md
---

# Scope-driven mounting

**Type: DO (code + types, generic).** Surfaced during a multi-tenant consuming
project's migration. The single biggest source of boilerplate + a type-level lie
in that project. Respects ADR 0002 — scope stays an opaque free string.

## Problem

A `scope` already lives on every contract and drives auth (`createAuthHook`
rules). But a resource-scoped / multi-tenant app needs scope to drive two more
things, and stitchkit makes the consumer wire both by hand:

1. **scope → URL prefix.** Tenant paths are `/tenants/:tenantId/widgets`,
   `/projects/:projectId/...`, flat for the rest. Today the consumer manually
   partitions services by `service.scope` into arrays and lists each under a
   `groups: [{ pathPrefix }]` entry — the scope↔prefix mapping is duplicated
   (partition + group config) and drifts.

2. **scope → handler context.** Each scope guarantees different injected fields
   (`tenantId`/`projectId`/`userId`). `createImplement<TCtx>` fixes ONE context,
   so the consumer declares a single superset context with every field as
   `string` — and a `public`-scoped handler is now typed `tenantId: string` that
   is actually `undefined` at runtime. **The type lies.**

## Proposal

Two generic additions, scope still a free string (no domain model):

```ts
// 1. scope → prefix map: services auto-group by `service.scope`.
createServer({
  services,
  scopePrefixes: { tenant: 'tenants/:tenantId', project: 'projects/:projectId' },
  // unscoped / unmapped scopes mount flat (or under a `defaultPrefix`)
})

// 2. scope → context types, one declaration, no lie.
const { implement } = createScopedImplement({
  tenant:  (ctx: RuntimeContext) => ctx as TenantCtx,    // shape per scope
  project: (ctx: RuntimeContext) => ctx as ProjectCtx,
  public:  (ctx: RuntimeContext) => ctx as BaseCtx,
})
// implement(contract, handlers) picks the handler ctx type from contract.meta.scope
```

Exact ergonomics open — the point is: declare the scope→prefix map and the
scope→context shapes **once**, and the framework applies them by `meta.scope`.

## Scope — generic only

- ✅ Take: group-by-`service.scope` under a configured prefix (incl. `:param`
  segments, which the router already matches into `ctx.pathParams`); a type-level
  scope→context binding.
- ✂️ Leave out: what the scopes *mean* (auth stays `createAuthHook`); resolving
  the tenant (the consumer's `beforeHandle` injects ids). No "tenant" concept in
  core — just the string key → prefix/context wiring.

## Acceptance

- [x] `scopePrefixes` on `createServer`/`createHandler` — services mount by
      `service.scope`; `:param` prefixes reach the context (spread as top-level
      keys, e.g. `ctx.tenantId` — **not** `ctx.pathParams`, corrected); unmapped → flat.
- [x] A scope→context type binding without a superset lie — solved with the
      existing primitive: one `createImplement<Ctx>()` **per scope** (documented).
      A `meta.scope`-driven `createScopedImplement` was **deferred** (speculative;
      per-scope factory already removes the lie). See ADR 0024.
- [x] Docs: `guide/multi-tenant.md` (step 2) + `guide/server.md` (Scope-driven
      mounting) + `api/reference.md`.
- [x] No `as` casts in core. `bun run verify` green — 414 tests.

## Что сделано (2026-06-05)

- [x] **`scopePrefixes`** — `server/types.ts` (`HandlerConfig.scopePrefixes?:
  Record<string,string>`) + `server/create.ts` (`normalizeGroups` mounts each
  `services` entry under `scopePrefixes[service.scope]`, unmapped flat, explicit
  `groups` unaffected). `:param` already lands on the context.
- [x] **scope→context** — no new API: per-scope `createImplement<Ctx>()` removes
  the superset-context lie. `createScopedImplement` (meta-driven) **deferred** as
  speculative.
- [x] **Tests** — `tests/scope-prefixes.test.ts` (tenant-scoped under prefix +
  `:param` on ctx; not mounted flat; unmapped scope flat).
- [x] **Docs + ADR** — `guide/multi-tenant.md`, `guide/server.md`,
  `api/reference.md`, `CHANGELOG`, **ADR 0024**.

Ships in the **0.6.0** batch. Scope stays a free string (ADR 0002 upheld).
