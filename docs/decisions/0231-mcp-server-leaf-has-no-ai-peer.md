---
title: MCP server leaf has no AI SDK peer
description: A supported server entrypoint preserves the canonical MCP implementation while isolating runtime and declaration peers.
status: active
created: 2026-10-04 13:11 +07:00
updated: 2026-10-04 14:11 +07:00
type: decision
---

# MCP server leaf has no AI SDK peer

**Invariants:** I8, I9, I10, I13.

The full tools barrel deliberately serves both MCP and AI adapters. Importing it loads
mountAgent and its AI SDK runtime peer even when a server never invokes a model. Removing
that feature or silently rewriting the full barrel would change its established contract.

stitchkit/tools/mcp starts as an evolving server entrypoint over the existing MCP owners. It re-exports
HTTP and stdio factories, mounts, schemas, catalog and resources. The official MCP server
SDK and Zod are its only feature peers. No server, runner, lifecycle or security policy is
copied. Build metadata, export map, maturity table and installed peer matrix all name this
same entrypoint.

Promotion requires two independent consumers and an ADR under the repository's existing
maturity rule. Sharing established implementations does not promote the new import leaf.

Runtime isolation alone is insufficient. A full runtime-tool type carries an AI presenter,
so merely specializing a type in a module with that full default still leaks AI declarations.
MCP configs use the existing neutral surface projection specialized with MCP registration.
One MCP type owner defines the official CallToolResult presentation and typed construction;
the full SDK presenters extend it with their agent member. Full typed shared definitions
remain structurally accepted. Heterogeneous registration erases callable input only at the
canonical schema-validating runner boundary. MCP presenters cannot supply framework-owned
structuredContent or isError.

The presentation intersects the official SDK result with forbidden framework fields.
Applying Omit to an SDK result with an extension index erases its required content and
metadata types. Intersecting preserves those SDK checks and the extension index; installed
negative controls reject missing content, malformed content blocks and numeric metadata.

Construct schema-dependent MCP-only tools with
RuntimeMcpToolDefinitionWithOutput<typeof input, typeof output> before registration. Shared
MCP/AI applications keep defineRuntimeTool with their SDK peers. This construction migration
is stated alongside the CLI registration change; there are no ambient modules or broad
structural SDK substitutes.

Qualification uses an independent installed consumer with server SDK and Zod, an actually
absent AI peer, strict NodeNext with skipLibCheck false, and positive/negative presenter
controls. Bun and Node execute initialize/list/call, schemas, auth and safe errors through
the public HTTP face. A separate missing-server-peer control must name that exact package.
The full SDK and neutral CLI/HTTP consumers retain their independent qualification lanes.
