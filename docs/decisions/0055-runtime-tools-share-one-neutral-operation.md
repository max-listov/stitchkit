---
title: "ADR 0055 — Runtime tools share one neutral operation"
description: Pathless MCP and Agent tools use one framework runner and transport-specific presentation callbacks.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0055 — Runtime tools share one neutral operation

- **Status:** Accepted — extends the shared runner in ADR 0014, protected native
  registration in [ADR 0048](0048-framework-owned-native-mcp-registration.md)
  and per-call isolation in
  [ADR 0045](0045-a-tool-call-runs-in-its-own-context.md)
- **Date:** 2026-08-07

## Context

Some framework-managed operations have no HTTP path and return model-facing
media. Protected MCP registration already supplied validation, lifecycle and
hooks, but its handler returned an MCP envelope. The equivalent AI SDK tool had
to be defined separately with raw `tool()`, bypassing those guarantees and
duplicating identity, schemas and execution.

MCP and the AI SDK also represent rich results differently. Making either SDK
envelope the domain result would couple the shared handler to one transport or
force a lossy lowest-common-denominator content model.

## Decision

`defineRuntimeTool` describes one pathless operation: name, description,
`OperationIdentity`, input/output Zod schemas, neutral handler and an explicit
MCP/Agent exposure set. Both adapters turn that definition into the existing
`MountableTool` and execute it through the canonical runner.

The optional `present.mcp` and `present.agent` callbacks run only after a
successful, output-validated call. MCP presentation may provide content and
metadata, but Stitchkit owns `structuredContent` and `isError`. Agent
presentation is wired to the AI SDK's `toModelOutput`, preserving the neutral
execute/UI result while giving the model text or file content.

Presentation requires an output schema, so its input is always the validated
value. `transports` defaults to both surfaces. Duplicate and invalid names fail
at mount, including collisions with contract tools.

The MCP `rawServer` and direct AI SDK `tool()` remain explicit low-level
boundaries. Calls defined there make no claim to Stitchkit lifecycle, hooks,
validation or request-context guarantees.

## Alternatives rejected

- **Keep separate MCP and Agent definitions.** Identity and policy drift remain
  possible, and the Agent operation still bypasses framework audit.
- **Use MCP content as the shared result.** Application and Agent code would
  depend on MCP wire types; output validation would target the wrong value.
- **Invent one framework media union.** It would lag both SDKs and discard
  transport-specific metadata. Typed presentation callbacks are smaller and
  lossless.
- **Model pathless operations as fake contracts.** A fabricated HTTP method/path
  would leak into routing, OpenAPI and audit semantics.

## Consequences

- One definition safely mounts on MCP, Agent or both.
- Handler behavior and audit identity cannot drift between tool transports.
- Multimodal transport details remain at the adapter edge.
- Existing protected MCP handlers migrate from an MCP envelope to neutral
  output; there is one clean public type family and no compatibility aliases.
