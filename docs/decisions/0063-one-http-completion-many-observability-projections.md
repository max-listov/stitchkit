---
title: "ADR 0063 — One HTTP completion feeds every observability projection"
description: Request logging and audit consume one framework-owned completion snapshot; payload capture is explicit and wrapper-free.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0063 — One HTTP completion feeds every observability projection

- **Status:** Accepted — supersedes the HTTP wrapper portion of ADR 0012 and
  refines ADR 0039; tool-event semantics remain unchanged.
- **Date:** 2026-08-08

## Context

Request logging completed inside `createHandler`, while `createAuditHook.http`
wrapped the finished fetch handler. Enabling both created two independently
timed completion paths and required exact wrapper ordering around
`wrapInRequestContext`. The audit wrapper also cloned every body-bearing request
even when the sink did not need payloads.

Operational logging and durable audit are distinct projections, but the final
status, timing, trace, identity and error outcome are one fact.

## Decision

`createHandler` owns one request completion snapshot. It establishes the request
context when request observability is configured, records every exit exactly
once and passes the same duration/trace/outcome to logging and the request-event
projection.

`createObservability` replaces `createAuditHook`. It accepts independent
`request` and `tools` sink configuration and returns:

- `request`, passed to `createServer` / `createHandler` as `observability`;
- `toolCall`, passed to MCP/Agent mounts as their canonical hooks.

HTTP payload capture defaults off. `includePayload: true` is the only mode that
clones and parses the request body. Tool arguments remain available to the tool
sink because the runner already owns their parsed object.

The old HTTP wrapper is removed without an alias. `wrapInRequestContext` remains
for custom fetch pipelines unrelated to built-in request observability.

## Consequences

- Logging and request audit cannot disagree on request duration or trace id.
- There is no wrapper-order footgun for `createServer` or Node adapters.
- Payload-free request auditing pays no body-clone cost.
- Request and tool sinks can use different retention, filters and sanitisation;
  either can fail without affecting the response or the other sink.
- Consumers migrate mechanically from nested wrappers to one handler config
  field and from a shared sink to explicit surface sinks.
