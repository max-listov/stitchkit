---
title: Remote implementation has a peer-free entrypoint
description: implementRemote belongs to stitchkit/remote so HTTP proxy consumers never import MCP or AI peers by accident.
type: decision
status: active
created: 2026-08-20
updated: 2026-08-20
---

# 0090 — Remote implementation has a peer-free entrypoint

## Context

`implementRemote` depends on contracts, the typed HTTP client and neutral
`ServiceDef` types. It does not depend on MCP or Agent SDKs. Its only public
owner was nevertheless `stitchkit/tools`, a broad barrel whose eager graph owns
both optional surfaces. A thin CLI importing one HTTP adapter therefore had to
resolve or bundle unrelated peers.

Lazy-loading every tools module would make module loading itself conditional and
would weaken ordinary ESM export semantics. Exporting the same symbol from both
`tools` and a lighter barrel would create two public paths and an indefinite
compatibility alias.

## Decision

- `stitchkit/remote` is the sole public owner of `implementRemote` and
  `ImplementRemoteOptions`.
- `stitchkit/tools` no longer exports them. This is an explicit pre-1.0 breaking
  import migration, recorded in the changelog.
- The implementation stays free of MCP, Agent and runtime-specific imports.
- The packed minimal-consumer lane bundles this entrypoint without installing
  optional peers and rejects any MCP SDK or `ai` module in the emitted graph.

## Consequences

A remote service may still be passed to MCP, Agent, CLI or HTTP infrastructure;
only construction ownership changes. Consumers opt into `stitchkit/tools` only
when they actually mount a tool transport.
