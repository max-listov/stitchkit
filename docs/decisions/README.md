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

**Statuses:** _Accepted_ — in effect · _Superseded_ — replaced by a later ADR,
kept for history · _Rejected_ — considered, deliberately not done.
