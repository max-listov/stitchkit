---
title: "ADR 0083: CLI composes managed and native commands"
description: Explicit runtime tools join the canonical CLI runner while binary-owned commands use a smaller CLI-only definition and lazy startup boundary.
type: decision
status: accepted
created: 2026-08-20
updated: 2026-08-20
---

# ADR 0083 — CLI composes managed and native commands

## Context

ADR 0016 made contract operations a first-class CLI transport. Later,
`defineRuntimeTool` introduced managed pathless operations, but ADR 0059 kept
them unavailable on CLI. A consumer therefore had to invent an HTTP contract or
an argv pre-router for a local application operation already used on MCP/Agent.

The same pre-router also accumulated commands about the executable itself —
login, update, diagnostics and integration setup. Those are not application
tools: giving them a service/action/scope/method identity would falsely publish
binary management as an MCP/Agent operation.

## Decision

`createCli` composes three explicit command sources:

1. contract methods exposed to `CLI`;
2. `RuntimeToolDefinition` values explicitly exposed to `CLI`;
3. `defineCliCommand` values that exist only in the local executable.

Contract and runtime commands use the canonical tool runner, identity,
application context, lifecycle, hooks, output validation and introspection.
Runtime tools still default to MCP+Agent only; `CLI` is never added implicitly.
This supersedes ADR 0059's CLI exclusion while preserving its one mixed-surface
collector.

Native commands are intentionally smaller Zod-first data definitions: name,
description, input, optional output and handler. They reuse argv/stdin parsing,
reserved-option checks, help, dry-run, writers, `ToolResult` normalization and
exit mapping, but have no fake tool identity, lifecycle or tool hooks. They
never enter MCP/Agent manifests.

Identity and managed surfaces may be lazy. `resolveAuth` is called at most once
and only when a managed command or an auth-dependent surface needs it.
`--version`, a selected native command and its help dispatch before auth,
services, context and runtime-tool factories. Top-level help stays credential
free for static surfaces; a dynamic surface must resolve identity because its
command names do not exist until the factory runs.

Static command names are collision-checked across all three sources before
managed execution. A dynamic managed factory is checked when it resolves. A
selected native command deliberately does not resolve that factory merely to
discover a possible collision: doing so would violate the credential-free
startup guarantee. Applications that need eager global collision proof must
use static surfaces; dynamic names are validated on their managed path.

## Consequences

- Pathless application operations can reuse one managed definition on MCP,
  Agent and CLI without a synthetic HTTP route.
- Binary-management commands join the same router and help tree without
  contaminating tool manifests or policy identity.
- A CLI can contain only runtime definitions or only native commands; the light
  `stitchkit/cli` entrypoint still imports neither MCP nor AI peers.
- Credential stores, updater protocols, diagnostics and integration installers
  remain application code. Stitchkit owns only their generic command boundary.
- Multipart contract endpoints remain CLI-invisible. A consumer may implement
  file-oriented behavior as a native or managed pathless command instead.
