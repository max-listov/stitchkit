---
title: "ADR 0080: MCP call metadata is typed context"
description: Validated protocol-era and client self-description metadata is exposed on the existing per-call context, never through auth or ambient state.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0080 — MCP call metadata is typed context

## Context

The modern MCP adapter already validates request metadata and projects it into
the per-call context used by contract tools, runtime tools, lifecycle and hooks.
Only `RequestEvent.mcp` documented that fact. On the application side the same
`mcp` value was reachable solely through `RuntimeContext`'s `unknown` index
signature, forcing consumers to parse or cast framework-owned data.

The MCP host's `clientInfo` is useful attribution, but it is self-reported and
must not be confused with the identity returned by the application `auth`
callback.

## Decision

- `McpCallContext` is the one browser-safe public shape for the active managed
  MCP call: era, method, tool name, optional protocol version/client info and
  optional multi-round outcome/round.
- `RuntimeContext`, `HandlerContext`, `ToolCallContext` and runtime-tool factory
  handler context expose the same optional `mcp` property. The existing MCP
  transport adapter remains its only producer; non-MCP calls leave it absent.
- HTTP and stdio use the validated metadata from the official SDK path. Legacy
  calls expose the era but cannot invent modern client information.
- `clientInfo` is display/analytics attribution only. Authentication,
  authorization, tenant selection and rate limiting continue to use verified
  application identity.
- `context(auth)` remains the build/application-context factory. It is not
  expanded with a second transport argument, and no ambient SDK accessor or
  global client state is introduced.

This supersedes only the earlier implementation note that client information
should stop at observability; it does not change MCP wire semantics or the
`RequestEvent.mcp` projection.

## Consequences

- Handlers and policy code can read `context.mcp?.clientInfo?.name` without a
  local parser or cast.
- One invocation carries one metadata value through handler, lifecycle, hooks
  and observability, preserving the existing per-call isolation.
- Application context construction remains independent of protocol details,
  and a spoofed MCP client name cannot become an authorization credential.
