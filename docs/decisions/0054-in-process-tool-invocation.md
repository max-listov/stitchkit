---
title: "ADR 0054 — In-process tool calls use the canonical runner"
description: Expose a compiled, exposure-aware invoker instead of using an SDK mount as an internal dispatcher.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0054 — In-process tool calls use the canonical runner

- **Status:** Accepted — extends the shared execution path in ADR 0014 and the
  per-call isolation rule in [ADR 0045](0045-a-tool-call-runs-in-its-own-context.md)
- **Date:** 2026-08-07

## Context

An application tool may dispatch to a more specific contract tool. Mounting a
Vercel AI SDK `ToolSet` merely to call its `execute` callback preserves behavior
but makes a transport adapter the application API, recompiles the whole surface
and leaks an SDK presentation envelope into internal code.

The framework already owns one executable path: `collectTools` resolves the
surface, `createToolRunner` prepares shared options, and `executeToolMethod`
performs validation, extension resolution, lifecycle, hooks, isolation and
output validation.

## Decision

Expose `createToolInvoker`. It collects an immutable name→operation map once
and invokes each operation through `createToolRunner`. It returns the canonical
discriminated `ToolResult`, with no MCP or AI SDK formatting.

The caller must choose `transport: 'MCP' | 'AGENT' | 'CLI'`. This is an exposure
policy, not the audit source: `source` defaults to `internal`. There is no mode
that collects every endpoint regardless of `expose`.

Unknown names throw a `NOT_FOUND` `AppError` before execution because no
operation identity exists for lifecycle or hooks. Duplicate or invalid names
fail during compilation using the same name ratchet as mounted surfaces.

Each invocation calls the existing runner, so extension context and request
context are fresh per call. Recursive and parallel invocations inherit and fork
the ambient observability context under ADR 0045; the invoker owns no mutable
per-call global state.

## Alternatives rejected

- **Mount and call an AI SDK tool.** It recompiles presentation schemas and
  couples internal code to SDK execution options and error formatting.
- **Expose `executeToolMethod` plus a name map recipe.** Every consumer would
  rebuild exposure, collision and extension behavior differently.
- **Internal bypass surface.** It would make `expose` advisory and allow a
  nested call to escape a deliberate transport restriction.
- **Throw every tool failure.** Mounted surfaces use `ToolResult`; retaining it
  keeps validation and handler failures mechanically comparable.

## Consequences

- Internal dispatch has no SDK dependency and no presentation-envelope parsing.
- The compiled invoker is intentionally untyped by runtime tool name; schemas
  still validate every boundary and the result is discriminated.
- A caller that wants thrown domain behavior translates a failed `ToolResult`
  explicitly at its own service boundary.
