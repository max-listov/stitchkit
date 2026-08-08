---
title: Unified HTTP observability emission
description: Produce one framework-owned request completion and project it into operational logging and audit sinks without duplicate wrapping.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:53 +00:00
---

# Unified HTTP observability emission

## Problem

Request logging is emitted inside the HTTP handler while HTTP audit is an outer
`audit.http` wrapper. Enabling both means two independently timed completion
paths, and audit clones the request body before the handler. Consumers that want
one canonical HTTP record must filter one system manually and still compose the
wrappers in the correct order.

Logging and audit are not the same product: terminal/structured operational logs
and durable normalized audit events need different sinks and payload policies.
The defect is duplicate capture/emission machinery, not the existence of two
projections.

## Decision

Move HTTP completion capture into one framework-owned pipeline. It creates one
canonical completion snapshot and feeds independent logging and audit
projections. Tool events continue through the shared tool-hook runner, but are
configured through the same top-level observability surface. Request payload
capture is explicit and off by default, so no body clone occurs unless a request
sink asks for it.

## Target shape

```ts
const observability = createObservability({
  request: {
    write: writeRequestEvent,
    includePayload: false,
  },
  tools: {
    write: writeToolEvent,
    sanitize,
  },
});

createServer({ services, logging, observability: observability.request });
mountAgent(services, { hooks: observability.toolCall });
```

The exact exported names may be refined during implementation, but there must
be one HTTP capture path, one request event, and separate projections—not two
nested HTTP wrappers.

## Plan

1. Introduce an internal request-completion value containing the final status,
   duration, trace/operation identity, error state and response metrics exactly
   once.
2. Refactor request logging to consume that completion rather than owning a
   separate timer/finalization path.
3. Integrate HTTP `RequestEvent` projection into `createHandler`/server config;
   clone and sanitize a body only when `includePayload` is true and the method
   can carry one.
4. Keep sinks isolated and fire-and-forget: a logging or audit failure must not
   alter the response or suppress the other projection.
5. Keep tool audit on canonical `ToolCallHooks`, but expose request and tool
   configuration through one coherent observability factory.
6. Remove the obsolete HTTP wrapper API rather than shipping parallel paths;
   document the mechanical migration as a pre-1.0 breaking minor with an ADR,
   changelog before/after snippets and upgrading guide.
7. Test raw routes, unmatched routes, framework errors, hook-provided responses,
   successful contracts, payload opt-in/off, trace correlation and sink failure.

## Acceptance

- [x] Exactly one HTTP completion snapshot is created per request on every exit
  path.
- [x] Logging and request audit can both consume it without duplicate timing or
  nested fetch wrappers.
- [x] Request bodies are not cloned/read when payload capture is disabled.
- [x] Enabling payload capture records a sanitized body without interfering with
  normal request parsing or `rawBody`.
- [x] Logging and audit sinks fail independently and never affect the response.
- [x] HTTP and tool events preserve trace, identity, error and dimension
  semantics already promised by `RequestEvent`.
- [x] The old wrapper has one documented migration path and no deprecated alias
  or compatibility shim remains.
- [x] Request logging, audit, context-fork, Node smoke and packed-consumer gates
  pass.

## Что сделано

- [x] **HTTP pipeline:** `createHandler` owns one guarded completion snapshot and
  feeds the exact same duration/trace/outcome to logging and request observation —
  `packages/core/src/server/create.ts`, `packages/core/src/server/logger.ts`.
- [x] **Observability API:** `createObservability` exposes independent request and
  tool sinks; the obsolete `createAuditHook`/`audit.http` path is removed without
  wrapper or alias — `packages/core/src/observability/audit.ts`.
- [x] **Payload cost:** request cloning is opt-in via `includePayload`; off means
  zero clones, on means one sanitized capture.
- [x] **Tests:** success, payload modes, shared completion, sink isolation, error
  attribution and context forks are covered by
  `packages/core/tests/unified-observability.test.ts` and migrated audit suites.
- [x] **Migration/docs:** ADR 0063, observability guide, upgrading guide, API
  reference and breaking changelog entry describe one clean replacement path.
- [x] **Gates:** all logging/audit tests, Node smoke, packed consumers and starter
  E2E pass in the full `bun run verify` pipeline.
