---
title: "ADR 0081: Generic native operations use managed definitions"
description: Wait, download and upload are canonical runtime-tool definitions over shared neutral operations; direct MCP mounts remain raw adapters.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0081 — Generic native operations use managed definitions

## Context

ADR 0019 put generic wait, guarded-download and upload mechanics in Stitchkit,
but exposed them only as direct MCP SDK registrars. A consumer using those
helpers therefore had to place them under `rawTools`, deliberately bypassing
the lifecycle, application context, hooks, cancellation and unified surface
introspection that ADRs 0055 and 0057 established for managed pathless tools.

Copying those operations into application-owned `defineRuntimeTool` handlers
would recover policy at the cost of duplicating framework mechanics.

## Decision

- `defineWaitTool`, `defineDownloadTool` and `defineUploadTool` return ordinary
  `RuntimeToolDefinition` data. They use the canonical runner and can be mounted
  on MCP, Agent or an explicit subset of those transports.
- Each factory takes Zod input/output schemas, stable operation identity and
  typed callbacks. Success is neutral validated data; failures enter the
  canonical `AppError -> ToolResult` path.
- Wait polling/sleep, guarded fetch/write and upload invocation each have one
  transport-neutral operation implementation. Active-call cancellation reaches
  the wait and download boundaries; upload callbacks receive the typed context
  and its signal.
- `mountWait`, `mountDownload` and `mountUpload` remain deliberate low-level MCP
  adapters over the same operations. They preserve their text/`isError` wire
  contract and make no lifecycle or hook guarantees.
- `mountViewFile` remains a separate raw media boundary. This decision does not
  invent a second runtime-tool runner or a compatibility alias.

## Consequences

- Generic imperative tools participate in the same lifecycle/RBAC, hooks,
  request context, schema preparation, collision checks and introspection as
  every other managed runtime tool.
- MCP and Agent execute one definition, so identity and behavior cannot drift
  between transports.
- Existing raw-mount users are not silently migrated to managed semantics; they
  opt into the factories by placing their definitions in `runtimeTools`.
- Framework mechanics remain domain-free: consumers still provide poll/done,
  URL resolution and upload behavior.
