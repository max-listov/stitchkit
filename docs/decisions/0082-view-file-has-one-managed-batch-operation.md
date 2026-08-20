---
title: "ADR 0082: View-file has one managed batch operation"
description: Protected multimodal inspection is a managed runtime-tool definition and the raw MCP mount is a presentation adapter over the same bounded batch core.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0082 — `view_file` has one managed batch operation

## Context

ADR 0081 moved wait, download and upload onto managed runtime-tool definitions,
but deliberately left `mountViewFile` as a raw MCP boundary. That exception
made a protected MCP/Agent surface repeat framework-owned media policy: input
and output schemas, mixed-batch behavior, one total byte budget, cancellation
and multimodal presentation.

Calling the public single-item `resolveMedia` in a consumer loop is not
equivalent. It grants every item a fresh 20 MB budget and cannot report partial
failures as structured output.

## Decision

- `defineViewFileTool` returns an ordinary `RuntimeToolDefinition` with fixed
  Zod input/output schemas, stable operation identity and default MCP/Agent
  multimodal presenters.
- One transport-neutral batch operation owns URL and local-path resolution,
  per-item failure capture, cancellation and one shared 20 MB read/inline
  budget. Valid media remains usable when another item fails; the neutral
  output records both `content` and structured `errors`.
- URL access remains SSRF-guarded. Local files remain disabled unless the
  application supplies a sandbox `baseDir`; realpath containment, known-media
  extension checks and size limits remain unchanged.
- `mountViewFile` remains a deliberate raw MCP adapter and preserves its
  content-only result envelope, but now calls the same batch operation.

This supersedes only ADR 0081's statement that `mountViewFile` remains a
separate raw-only media boundary. Its raw registration remains supported; the
operation is no longer raw-only.

## Consequences

- One definition can serve remote MCP, local stdio MCP and Agent surfaces with
  the canonical lifecycle, hooks, context, cancellation and introspection.
- Batch policy cannot drift between managed and raw registrations.
- Structured partial failures are visible to managed hooks and callers while
  the MCP/Agent presenters can still deliver successful media to the model.
- The framework still owns no storage provider, domain media object or access
  policy beyond the explicit generic sandbox/network boundaries.
