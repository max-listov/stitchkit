# Architecture Decisions

This directory records the **why** behind stitchkit — the decisions that shaped
the framework, including the ones that were tried and reversed.

Each entry is an ADR (Architecture Decision Record): one decision, its context,
the alternatives weighed against it, and the consequences. ADRs are immutable —
when a decision changes, a new ADR supersedes the old one; the old one stays,
marked `Superseded`, so the reasoning is never lost.

These records were consolidated from the project's internal design notes on
2026-05-20; the dates on each ADR are when the decision was effectively made.

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-bun-serve-no-framework.md) | Build on `Bun.serve()`, no HTTP framework | Accepted |
| [0002](0002-generic-core.md) | A generic core — the framework carries no domain model | Accepted |
| [0003](0003-two-context-types.md) | Two context types: `RuntimeContext` and `HandlerContext` | Accepted |
| [0004](0004-lifecycle-hooks.md) | Four lifecycle hooks instead of a middleware chain | Accepted |
| [0005](0005-typed-client.md) | The typed client is inferred from the contract | Accepted |
| [0006](0006-route-groups-query-params.md) | Route groups and GET/DELETE query params | Accepted |
| [0007](0007-mcp-agent-tools.md) | MCP and agent tools from one shared pipeline | Accepted |
| [0008](0008-thin-wrappers.md) | Thin wrappers over the stack you already use | Accepted |
| [0009](0009-hand-rolled-websocket.md) | A hand-rolled WebSocket transport | Superseded by 0008 |
| [0010](0010-fullstack-rejected.md) | Grow stitchkit into a fullstack framework | Rejected |
| [0011](0011-bun-only-one-package.md) | Bun-only, published as one small package | Accepted |
| [0012](0012-observability-module.md) | A built-in observability module | Accepted |
| [0013](0013-runtime-agnostic-core.md) | Runtime-agnostic core, Bun as first-class adapter | Accepted — supersedes Bun-only clause of 0011 |
| [0014](0014-tool-http-parity.md) | The tool surface carries the same contract guarantees as HTTP | Accepted — refines 0007 |
| [0015](0015-oauth-resource-server.md) | OAuth 2.1 resource-server toolkit for MCP | Accepted |
| [0016](0016-cli-transport.md) | CLI as the fourth transport | Accepted — extends 0007 |
| [0017](0017-typed-tool-context.md) | Typed tool-path context via `createToolkit` | Accepted — extends 0003 |
| [0018](0018-openapi-generation.md) | OpenAPI generated from the contract | Accepted |
| [0019](0019-generic-native-tools.md) | Generic native MCP tools (wait / download / upload) | Accepted — extends 0007 |
| [0020](0020-raw-websocket-lane.md) | A raw WebSocket lane composed beside Socket.IO | Accepted — upholds 0008 |
| [0021](0021-endpoint-meta-passthrough.md) | Endpoint meta passthrough (opaque per-endpoint metadata) | Accepted — extends 0002 |
| [0022](0022-endpoint-identity.md) | Stable (service, action) identity on MethodDef | Accepted — extends 0002, 0021 |
| [0023](0023-range-file-serving.md) | Range-capable file serving (`serveFile`) | Accepted — extends 0013 |
| [0024](0024-scope-driven-mounting.md) | Scope-driven mounting (`scopePrefixes`) | Accepted — extends 0002 |
| [0025](0025-typed-scoped-client.md) | Typed scoped client (consumed keys as args) | Accepted — extends 0005 |
| [0026](0026-stitch-error-code-registry.md) | Published stitch error-code registry | Accepted — extends 0002 |

**Statuses:** _Accepted_ — in effect · _Superseded_ — replaced by a later ADR,
kept for history · _Rejected_ — considered, deliberately not done.
