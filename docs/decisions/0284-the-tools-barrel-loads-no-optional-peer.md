---
title: "ADR 0284: The tools barrel loads no optional peer"
description: stitchkit/tools exports only the transport-neutral tool layer; the MCP server, the AI SDK agent mount and the toolkit that composes both live on their own subpaths.
type: decision
status: accepted
created: 2026-11-05 08:49 +07:00
updated: 2026-11-05 08:58 +07:00
---

# ADR 0284 — The tools barrel loads no optional peer

Amends [ADR 0231](0231-mcp-server-leaf-has-no-ai-peer.md): its first paragraph kept
`stitchkit/tools` as the full barrel serving both MCP and AI adapters. That clause is replaced;
the MCP-only leaf, its peer budget and its typed presenters stand. Serves **I7**, **I8**, **I14**.

## Context

An application that exposes its operations over HTTP and CLI only, with neither
`@modelcontextprotocol/server` nor `ai` installed, imports `stitchkit/tools` for
`listToolNames` — to pin its CLI surface in a test. The import failed:

```
error: Cannot find module '@modelcontextprotocol/server' from '…/stitchkit/dist/index-….js'
```

Both packages are declared optional peers, and the MCP server already had a leaf of its own
(`stitchkit/tools/mcp` since ADR 0231). The barrel still re-exported the MCP server factories,
`mountAgent` and `createToolkit`, so ESM resolution of the whole entry needed both peers, and
41 MCP names were exported from two places. Type imports erase, so no source test could
see it: only the built chunk graph did.

## Decision

`stitchkit/tools` is the transport-neutral tool layer: the registry, tool names and manifest,
runtime and native tool definitions, the invoker, the OAuth provider and the durability engine.
Its built graph imports no optional peer.

- The MCP server — HTTP and stdio factories, mounts, schema validation, catalog stamp and MCP
  Apps resources — is exported by `stitchkit/tools/mcp` alone.
- `mountAgent`, `AgentMountConfig` and `AgentContext` move to the new `stitchkit/tools/agent`
  (Zod and `ai`).
- `createToolkit` and `Toolkit` move to the new `stitchkit/tools/toolkit`, which needs both
  peers because it composes both adapters. It is not put in `stitchkit/tools/agent`: ESM
  loads an entry's whole graph, so `mountAgent` alone would then require the MCP server.

Raw MCP adapters that only take an `McpServer` type (`mountViewFile`, `mountDownload`,
`mountUpload`, `mountWait`) stay in `stitchkit/tools`: they import no MCP value.

Declarations of the barrel may still name MCP and AI SDK types through the runtime-tool
presenters, as `stitchkit/tools/connections` already does; the promise is the runtime graph.

## Proof

- `packages/core/scripts/check-tools-neutral.mjs` runs in `build` and walks the built chunk
  graph of `entrypoints/tools.js`; a static import of any optional peer fails the build and
  names the chunk. Negative controls: re-exporting `createMcpHandler` or `mountAgent` from the
  barrel turns it red with `@modelcontextprotocol/server` and `ai` respectively.
- The installed optional-peer matrix bundles and runs `listToolNames` from `stitchkit/tools`
  in the fixture without optional peers (`tools-neutral`), and proves that `stitchkit/tools/agent`
  and `stitchkit/tools/toolkit` name their missing peer when it is absent.

## Consequences

A breaking change to a stable entrypoint with a mechanical migration: import the moved names
from their subpath. The two new subpaths start evolving.
