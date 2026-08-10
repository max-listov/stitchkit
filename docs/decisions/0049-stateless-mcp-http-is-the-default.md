---
title: "ADR 0049 — Stateless MCP HTTP is the default"
description: Synchronous MCP HTTP handlers are request-isolated by default; session continuity is explicit.
type: decision
status: superseded
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0049 — Stateless MCP HTTP is the default

- **Status:** Accepted — changes the HTTP transport default; builds on immutable
  surface preparation from ADR 0047
- **Date:** 2026-08-07

## Context

The HTTP handler defaulted to an in-memory MCP session store. That couples a
client to one process: replacement, restart or unpinned scale-out can turn a
valid `Mcp-Session-Id` into `404 Session not found`. Most stitchkit MCP tools are
synchronous request/response operations and receive no benefit from retained
transport state.

A boolean `stateless` also makes the exceptional mode hard to read: omission
means stateful and `false` means the same thing.

## Decision

Replace the boolean with:

```ts
sessionMode: 'stateless' | 'stateful' // default: 'stateless'
```

Stateless mode creates a fresh SDK server, transport, resolved auth/context and
runner for each HTTP request over one immutable prepared schema surface. It has
no session map, event store, sweep timer or `Mcp-Session-Id` lifecycle.

Stateful mode is explicit. It retains the existing server-issued session id,
bounded session/event stores, resumable SSE stream and idle cleanup for clients
that need cross-request progress or server-initiated messages.

No current stitchkit configuration field independently requests a stateful-only
capability, so there is no contradictory combination to reject. Adding such a
field later must fail at handler construction unless `sessionMode: 'stateful'`
is also explicit.

## Consequences

- Normal synchronous servers survive process replacement and distribute across
  instances without shared session infrastructure.
- Stateful consumers must opt in during the 0.37.0 migration.
- `stateless` is removed without an alias or overload.
- Deterministic schema work remains once per static handler, while all mutable
  request/server state stays fresh.
