---
title: "ADR 0059 — Unified tool-surface introspection"
description: Manifests, name snapshots and transport summaries resolve contracts and runtime tools through one canonical collector.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0059 — Unified tool-surface introspection

- **Status:** Accepted — extends the shared runner of
  [ADR 0014](0014-tool-context-and-mcp-native-output.md), the name guarantees of
  [ADR 0035](0035-tool-name-derivation-and-validation.md), the presentation
  document of [ADR 0050](0050-presentation-schema-is-not-a-parser.md), and the
  pathless operations of [ADR 0055](0055-runtime-tools-share-one-neutral-operation.md)
- **Date:** 2026-08-08

## Context

`defineRuntimeTool` made pathless operations first-class on MCP and Agent, but
the public introspection helpers still accepted only contract services or
already-resolved internal mountables. A deferred-tool manifest therefore had to
convert runtime Zod schemas locally, while name snapshots and transport counts
silently omitted the same operations.

That split can make diagnostics disagree with the mounted surface on schema
projection, exposure filters, ordering and duplicate names.

## Decision

One internal mixed-surface collector resolves `{ services, runtimeTools }` for a
chosen tool transport. It uses the existing contract and runtime adapters, then
owns cross-origin collision checks and mount order.

Public introspection accepts object-shaped surface definitions:

- `buildToolManifest({ services, runtimeTools, transport })`;
- `listToolNames({ services, runtimeTools })`;
- `summarizeTransports({ services, runtimeTools })`.

Manifest targets are MCP or Agent only. Runtime definitions remain unavailable
on CLI and have no implicit HTTP operation. Read-only diagnostics retain
illegal and duplicate rows so they can expose a broken surface; executable
manifests and mounts fail first.

## Alternatives rejected

- **Export `runtimeToolMountable`.** That exposes execution internals and makes
  consumers responsible for filtering, collisions and future mount changes.
- **Add `buildRuntimeToolManifest`.** Separate contract/runtime manifests still
  require consumer-owned merging and collision policy.
- **Keep service-only diagnostics.** Their totals and snapshots would become
  less trustworthy as applications adopt runtime tools.
- **Mount runtime tools on CLI.** This task aligns introspection with existing
  semantics; it does not invent a new transport.

## Consequences

- A complete deferred-tool manifest needs no local Zod walker.
- Contract/runtime collisions fail before a model sees an ambiguous surface.
- Name entries identify their `contract` or `runtime` origin.
- Transport summaries report contract service count, runtime definition count
  and per-source counts without pretending runtime operations are HTTP routes.
- The object-shaped redesign is breaking and has no compatibility overload.
