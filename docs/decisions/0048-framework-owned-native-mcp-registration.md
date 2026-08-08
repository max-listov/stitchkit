---
title: "ADR 0048 — Framework-owned native MCP registration"
description: Native multimodal MCP tools use a stitchkit registrar; raw SDK access remains an explicit unprotected escape hatch.
type: decision
status: superseded
created: 2026-08-07
updated: 2026-08-08
---

# ADR 0048 — Framework-owned native MCP registration

- **Status:** Superseded by
  [ADR 0057](0057-finite-prepared-mcp-surfaces.md). It extends the transport parity of
  [ADR 0014](0014-tool-http-parity.md), the stable operation identity of
  [ADR 0022](0022-endpoint-identity.md), and per-call isolation from
  [ADR 0045](0045-a-tool-call-runs-in-its-own-context.md)
- **Date:** 2026-08-07

## Context

Contract tools run through stitchkit's input/output validation, lifecycle,
isolated request context and observability hooks. Native MCP tools exist because
some operations must return MCP content blocks directly, but the existing
`nativeTools(server, auth)` callback exposes only raw SDK registration. A raw
callback cannot acquire those framework guarantees, regardless of whether it is
invoked before or after contract mounting.

Forcing multimodal operations into JSON contracts would corrupt their result
model. A second standalone mount helper would create two framework-owned native
paths and make configuration parity optional.

## Decision

`nativeTools` receives one `NativeMcpRegistrar` and the resolved build identity.
The registrar exposes:

- `registerTool(definition)` — the canonical protected path;
- `rawServer` — the explicitly named SDK escape hatch, with no stitchkit
  lifecycle, validation, per-call context or tool hooks.

A native definition owns its MCP schema and one `OperationIdentity`
(`serviceName`, `action`, `scope`, semantic method and metadata). Contract
`MethodDef` extends the same path-free identity; only HTTP methods own `path`.
Tool lifecycle and observability consume `OperationIdentity`, so no fake HTTP
route is invented for a native operation.

Framework registration uses the same schema preparation profile as contract
tools and the same execution envelope. Successful native results remain MCP
results: text/image/audio/resource blocks and `_meta` pass through untouched.
When an output schema is declared, only `structuredContent` is parsed by it and
the parsed payload replaces that field; other MCP result fields are preserved.

The SDK still parses advertised input before invoking the callback. An SDK-level
`InvalidParams` rejection therefore cannot enter stitchkit hooks; this boundary
is documented rather than represented as audited.

## Consequences

- Native multimodal tools can receive the same RBAC, audit and per-call
  isolation guarantees as contract tools.
- Raw registration remains possible, but opting out is visible in code.
- `nativeTools` is a breaking callback-shape change in 0.37.0; there is no alias
  or server-like compatibility wrapper.
- `OperationIdentity` becomes the public endpoint type for tool hooks and
  `ToolLifecycle`. Existing contract callbacks still receive all prior fields at
  runtime; code that assumed every tool endpoint has an HTTP `path` must narrow
  to `MethodDef`.
- Stateful HTTP, stateless HTTP and stdio share the same server builder, so the
  registrar cannot drift by transport.
