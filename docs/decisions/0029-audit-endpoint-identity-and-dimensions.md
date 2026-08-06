---
title: "ADR 0029 — Endpoint identity and domain dimensions on the audit event"
type: decision
status: accepted
created: 2026-06-18
updated: 2026-06-18
---

# ADR 0029 — Endpoint identity and domain dimensions on the audit event

- **Status:** Accepted — extends [ADR 0012](0012-observability-module.md) (the
  observability module), [ADR 0022](0022-endpoint-identity.md) (stable endpoint
  identity), [ADR 0021](0021-endpoint-meta-passthrough.md) (opaque passthrough)
  and keeps the core generic per [ADR 0002](0002-generic-core.md).
- **Date:** 2026-06-18

## Context

`createAuditHook` normalises every completed call into a `RequestEvent` and hands
it to the project's sink. The HTTP event is built by an **outer fetch wrapper**
(`createAuditHook.http`) that reads the `AsyncLocalStorage` `RequestContext`
established by `wrapInRequestContext` — symmetric for success and failure, but
established *before* routing, so it never sees the matched route. Two gaps
followed, both reported by a consuming project:

- **A — no `(serviceName, action)` for HTTP.** The tool path carries `toolName`,
  but the HTTP event had only `path`. A sink whose audit table has `service` /
  `action` columns had to parse them out of the URL — fragile. The stable
  identity already exists on `MethodDef` (`serviceName` / `key`, → ADR 0022) and
  reaches the lifecycle hooks, but not the ALS-based audit event. Because of this
  the consumer abandoned `createAuditHook` and hand-rolled an audit from the
  `afterHandle` + `onError` hooks (where the typed endpoint *is* available) — at
  the cost of the success/failure asymmetry those two halves create.
- **B — nowhere for domain dimensions.** `RequestEvent` carries generic identity
  (`userId` / `authMethod` / `clientId`) but no place for an app's tenant /
  project / entity id, so the sink re-derived them from the path.

## Decision

- **A — the pipeline surfaces endpoint identity into the request context.** When a
  contract route matches, `createHandler` calls `setRequestEndpoint(serviceName,
  action)` **before validation**, so the audit event is attributed to its
  operation even on a pre-handler (400) failure. `RequestEvent` gains
  `serviceName` / `action`, populated on the HTTP path (from the context) and the
  tool path (from the `endpoint` the hook already receives) alike — from the
  contract, never parsed from the path. The write is a **no-op** without an active
  observability context, so a server that does not use observability pays nothing.
- **B — an opaque `dimensions` bag.** `RequestEvent` gains
  `dimensions?: Record<string, string>`, filled by `setRequestDimensions(...)`.
  The core attaches **no** meaning to it (the ADR 0021 opaque-passthrough pattern):
  the app resolves a tenant / project / entity id cheaply from `ctx.params` /
  headers in `beforeHandle` (success) or `onError` (a pre-handler failure, which
  carries `ctx.params` / `ctx.req` since 0.10.0) and it lands on the event for the
  request, success or failure alike.

  > **Scoped by [ADR 0045](0045-a-tool-call-runs-in-its-own-context.md)
  > (2026-08-06).** "The event for the request" held only while one request meant
  > one call. Concurrent tool calls shared the request's store and overwrote each
  > other, so a row could name another call's entity. A tool call now writes into
  > its own forked context and the value lands on **that call's** event.

## Alternatives considered

- **Add `projectId` / `botId` / `entityId` fields.** Rejected — domain modelling
  in a generic core (ADR 0002). The opaque `dimensions` bag carries the same data
  without the core naming a domain, exactly like endpoint `meta` (ADR 0021).
- **Have `createAuditHook` return lifecycle hooks that bind the endpoint, for the
  consumer to compose.** Rejected — wiring burden, and easy to forget on the
  `onError` path. The pipeline writing identity is zero-wiring and batteries-
  included, which is the point of `createAuditHook`.
- **A dedicated pre-validation `resolveIdentity` phase (a 5th lifecycle hook).**
  Deferred — with (A) + (B) and the 0.10.0 `onError` context (`params` / `req`), a
  failure is attributed in `onError`; a new lifecycle phase is not justified yet.

## Consequences

- **Additive — no breaking change** (new optional `RequestEvent` fields and two
  new setters). Ships in 0.11.0.
- **A consuming project can drop a hand-rolled HTTP audit and adopt
  `createAuditHook`** — it now carries `(serviceName, action)` and `dimensions`,
  which also removes the success/error asymmetry of an `afterHandle` + `onError`
  split (one symmetric terminal event).
- **`createHandler` now imports the observability context setter** (a no-op
  without an active context). Observability stays layered above the server
  (obs → server); there is no import cycle, and the browser-safe entrypoints are
  unaffected (server-only).
