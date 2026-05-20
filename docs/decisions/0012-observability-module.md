---
title: "ADR 0012 — A built-in observability module"
type: decision
status: accepted
created: 2026-05-20
updated: 2026-05-20
---

# ADR 0012 — A built-in observability module

- **Status:** Accepted
- **Date:** 2026-05-20

## Context

stitchkit shipped only the low-level hooks — `LifecycleHooks` and
`ToolCallHooks` (ADR 0004, ADR 0007). Every consuming project then re-built the
*same* audit layer on top of them: a request-context, a trace id, a payload
sanitiser, a transport-source tag, an HTTP audit wrapper, a sink. Across three
sibling projects this layer was duplicated, divergent, or missing entirely —
the framework had ended the duplicated transport layer but not the duplicated
observability layer above it.

The hooks are the right primitive. The question was whether the audit layer
*above* them belongs in the framework too — and if so, how much of it.

## Decision

**Ship an observability module — `stitchkit/observability`, a new entrypoint.**
It owns the reusable audit machinery; a consuming project supplies only an audit
table and a `write(event)` function.

The module owns four things:

1. **W3C Trace Context** — `traceparent` parsing, formatting and span chaining.
   A trace spans the front-end call, the HTTP handler and every tool call
   beneath it.
2. **A request context** over `AsyncLocalStorage` — trace ids, transport
   source, identity and timing, reachable without threading a parameter.
3. **`RequestEvent`** — one normalised audit shape produced by both surfaces, so
   a single audit table stays queryable across HTTP, MCP and agent calls.
4. **`createAuditHook`** — wires both surfaces into one sink, plus the
   sanitisation that makes a payload safe to store.

**The HTTP audit is a fetch-handler wrapper, not a lifecycle hook.**
`LifecycleHooks` has a single `onError` (ADR 0004) — an audit built on it would
compete with the application's own error handler for that one slot. The wrapper
sees the final `Response` instead — success and error alike, one uniform place,
no contention. The tool-call audit *is* a hook (`afterToolCall`), which has no
such conflict.

**The module owns the machinery, not the policy.** It does not own the audit
table (a project's database model), the logger backend (`pino` vs console — the
`StitchLogger` interface stays the only contract), project-domain transport
sources, or any live-stream / admin-UI concern. Those stay with the project.
The split is the same as ADR 0002: a generic core, no domain model.

A separate entrypoint — not folded into `stitchkit/server` — keeps the audit
machinery tree-shakeable and the concern distinct: a project that does not audit
never imports it.

## Consequences

- A consuming project's request logging collapses to a table plus a `write`
  function; trace ids, the context, sanitisation and wiring come from the
  framework.
- One normalised `RequestEvent` means one queryable audit store across every
  surface, instead of three disconnected logs.
- The raw hooks remain fully available for anything that is not a full audit
  row — a one-off metric, a custom log line.
- The module depends on `node:async_hooks`. Bun implements it; consistent with
  ADR 0011.
