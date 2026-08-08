---
title: "ADR 0064 — Runtime-tool factories validate context at execution"
description: Shared runtime-tool identity is bound at authoring time while application context is parsed independently inside every canonical tool execution.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0064 — Runtime-tool factories validate context at execution

- **Status:** Accepted — extends the neutral runtime-tool operation in
  [ADR 0055](0055-runtime-tools-share-one-neutral-operation.md) without adding a
  second runner or mount surface.
- **Date:** 2026-08-08

## Context

Pathless runtime tools often share an application context schema and stable
identity fields. Standalone `defineRuntimeTool` deliberately receives the loose
framework `RuntimeContext`, so consumers previously repeated the same schema
parse, `serviceName` and `scope` in every handler.

Typing only the mount boundary is insufficient: it proves that the context
provider is intended to return a shape, but it does not validate the value seen
by a particular call.

## Decision

`createRuntimeToolFactory` binds `serviceName`, optional `scope`, optional
identity metadata and a Zod context schema. Each `define` call supplies the
operation-specific action, semantic method, schemas and handler.

The factory still returns an ordinary `RuntimeToolDefinition`. Its adapter runs
inside the canonical execution pipeline and parses the current call's context
exactly once before invoking the authored handler. The handler receives parsed
application context plus the already parsed tool input and `params: undefined`.

Context is never cached or shared between calls. A validation failure is an
ordinary runner failure, so lifecycle, error normalization, hooks and audit keep
the same ordering and semantics as standalone runtime tools.

## Consequences

- Shared identity cannot drift across a related runtime-tool group.
- Handler context is both statically inferred and runtime-validated.
- Parallel calls retain independent context and validation.
- MCP, Agent, prepared surfaces, manifests and in-process invokers require no
  factory-specific code because they receive the existing definition shape.
- Standalone `defineRuntimeTool` remains the direct API for unrelated tools.
