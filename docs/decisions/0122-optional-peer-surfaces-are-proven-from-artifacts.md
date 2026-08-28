---
title: "ADR 0122: Optional-peer surfaces are proven from artifacts"
description: "Peer-neutral invocation has a dedicated entrypoint, and optional Socket.IO loading is checked by real packed runtime and Webpack consumers."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0122 — Optional-peer surfaces are proven from artifacts

## Context

A source module can be independent of an SDK while its public barrel is not.
`createToolInvoker` uses the canonical contract runner without MCP or AI, but
`stitchkit/tools` also mounts those adapters and resolves their peers at import
time. Conversely, the root Socket.IO client keeps its optional peer behind a
runtime-selected import, but Webpack warns about that expression even when the
consumer supplies the documented literal loader.

Tree-shaking and optional peer metadata do not prove either experience. The
published artifact and the consuming bundler decide them.

## Decision

- `stitchkit/tools/invoker` is the peer-free public surface for canonical
  in-process tool dispatch. `stitchkit/tools` remains the full adapter barrel.
- The root keeps Socket.IO lazy and optional. Its emitted browser artifact
  preserves Webpack's ignore directive on only the runtime-selected fallback;
  a consumer-provided literal `peers.client` import remains visible to Webpack.
- A packed minimal consumer invokes a validated contract tool on Bun and Node.
- A packed Next/Webpack client compiles the documented Socket.IO loader and
  treats the expression-dependency warning as a failure.

## Consequences

- Consumers install peers for the adapters they import, not for unrelated
  mechanics beside them in a barrel.
- There is still one tool runner and one Socket.IO client; entrypoints describe
  dependency budgets rather than fork behavior.
- Artifact rewrites are count-checked and fail if the emitted shape changes.
- Runtime missing-peer errors and injected-loader behavior remain unchanged.
