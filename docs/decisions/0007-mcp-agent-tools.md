---
title: "ADR 0007 — MCP and agent tools from one shared pipeline"
type: decision
status: accepted
created: 2026-05-13
updated: 2026-05-20
---

# ADR 0007 — MCP and agent tools from one shared pipeline

- **Status:** Accepted
- **Date:** 2026-05-13 (pipeline, extend), 2026-05-20 (`createMcpHandler`)

## Context

The same contract endpoint must be exposed as an [MCP](https://modelcontextprotocol.io)
tool (for assistants) and as an AI-SDK tool (for agents). Two concerns appeared:

- The MCP path and the agent path each had their own validate → call → format
  logic — duplicated, free to drift.
- Multi-tenant tools need an extra schema field the model must supply (for
  example a tenant id), which the contract itself does not carry.
- Every project re-implemented the MCP server lifecycle by hand — an SSE event
  store, a session map, the Streamable-HTTP transport.

## Decision

- **One execution pipeline.** `executeToolMethod()` does validate params + input
  → run handler → `normalizeError` → `ToolResult`. The MCP mount and the agent
  mount are ~20 lines each on top of it. `ToolCallHooks` (`beforeToolCall` /
  `afterToolCall`) give observability, fired even on validation failure.
- **One extension object.** `ToolExtend { schema, resolve, filter }` — the same
  shape for MCP and agent. `schema` adds fields the model sees, `resolve` turns
  those args into context before the handler, and the extra keys are stripped
  from the args that get validated. (Rejected: a per-tool `wrapTool` callback as
  the primary API — all boilerplate, kept only as an escape hatch; a separate
  group-config object — a second, divergent API shape.)
- **`createMcpHandler()`** owns the entire MCP Streamable-HTTP lifecycle — an
  SSE event store for stream resumability, per-session transports, the
  `McpServer` instances. The consuming app never imports
  `@modelcontextprotocol/sdk`; it declares only how to authenticate and which
  contract services to expose.

## Consequences

- Every MCP and agent tool comes from a contract — there are no hand-built
  native tools to keep in sync.
- The MCP path and the agent path share one validated, observable pipeline.
- An `AppError` may carry a `hint`; the pipeline forwards it into the tool
  result, so a model receives a recovery suggestion next to the error code.
- A consuming app's MCP server shrinks to a small block of configuration.
