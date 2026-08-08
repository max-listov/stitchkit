---
title: Unified contract and runtime tool surface introspection
description: Make manifests, name snapshots and transport summaries reflect the same mixed contract/runtime surface that Stitchkit mounts
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 02:20 +00:00
---

# Unified contract and runtime tool surface introspection

## Problem

Framework-managed runtime tools are first-class on MCP and Agent mounts, but
the public introspection helpers still understand only contract tools:

- `buildToolManifest` requires already-resolved `MountableTool[]`;
- `collectTools` accepts one contract service and cannot resolve runtime tools;
- `listToolNames` and `summarizeTransports` omit runtime tools entirely;
- the internal `runtimeToolMountable` conversion is deliberately not public.

A consumer that builds deferred/searchable Agent tools must therefore copy the
framework's Zod-to-presentation-schema conversion and merge the two surfaces
itself. That can drift from transport filtering, naming, collision handling and
the exact schema Stitchkit advertises.

## Decision

Introduce one framework-owned mixed-surface collector and make the public
introspection APIs accept an object-shaped surface definition. Do not export
`runtimeToolMountable`, add a parallel `buildRuntimeToolManifest`, or retain
compatibility overloads.

## Plan

- [x] Define a shared object-shaped tool-surface input containing contract
  services, optional runtime definitions and the target tool transport.
- [x] Collect contract and runtime operations in actual mount order through the
  canonical presentation-schema builders.
- [x] Honour runtime `transports` and contract `expose` filters.
- [x] Fail first on duplicate names across contract and runtime operations.
- [x] Redesign `buildToolManifest` around the mixed surface.
- [x] Redesign `listToolNames` and `summarizeTransports` so runtime operations
  cannot disappear from snapshots and boot diagnostics.
- [x] Reuse the common collector in mounting paths where doing so removes
  duplicated collection/collision logic without weakening presenter handling.
- [x] Update public exports, API reference, guide, upgrading guide, changelog
  and generated agent-facing documentation.

## Tests

- [x] Runtime-only Agent manifest uses the exact canonical presentation schema.
- [x] Mixed contract/runtime manifest preserves mount order and stable identity.
- [x] MCP-only runtime tools are absent from an Agent manifest and vice versa.
- [x] Contract/runtime and runtime/runtime name collisions fail first.
- [x] Schema collection does not parse input or execute transforms/refinements.
- [x] Name snapshots include runtime identities and transports.
- [x] Transport summaries count runtime tools only on supported transports.
- [x] Compile-time fixtures reject HTTP/CLI as mixed runtime-tool collection
  targets and preserve object-shaped configuration.

## Acceptance

- [x] A consumer can build a complete manifest from services plus
  `RuntimeToolDefinition[]` without a local schema walker.
- [x] Manifest, names, summaries and actual mounts cannot disagree about the
  mixed surface.
- [x] No internal mount adapter is exposed publicly.
- [x] No compatibility overload or parallel runtime-only helper exists.
- [x] `bun run verify` is green (919 tests, 1969 assertions).

## Non-goals

- Mounting runtime tools on CLI.
- Expanding in-process invocation to runtime definitions.
- Changing manifest entries beyond the existing name/description/input schema.
- Release, commit, push or downstream migration.

## What was done

- [x] **Shared surface:** `/packages/core/src/tools/surface.ts` resolves contract
  and runtime operations in mount order with canonical exposure, naming,
  presentation schemas and cross-origin collision checks.
- [x] **Mount parity:** `/packages/core/src/tools/agent.ts` and
  `/packages/core/src/tools/mcp.ts` consume the same collector while preserving
  runtime presenters and MCP preparation.
- [x] **Manifest:** `/packages/core/src/tools/manifest.ts` accepts
  `{ services?, runtimeTools?, transport }`; no mountable conversion leaks into
  the public API.
- [x] **Diagnostics:** `/packages/core/src/tools/list-names.ts` includes origin
  and runtime identity; `/packages/core/src/tools/transports.ts` returns explicit
  contract/runtime counts and a per-source breakdown.
- [x] **Regression coverage:**
  `/packages/core/tests/tool-surface-introspection.test.ts` covers runtime-only
  and mixed manifests, exact schemas, ordering, filters, collisions, parsing
  effects, names, counts and compile-time transport restrictions.
- [x] **Packed consumer:**
  `/packages/core/scripts/consumer-lane/fixtures/full/src/app.ts` exercises all
  three object-shaped introspection APIs from the published package.
- [x] **Documentation:** ADR 0059, decision index, MCP/Agent guide, API
  reference, upgrading guide, changelog and generated LLM docs describe the
  unified surface and mechanical migration.
- [x] **Validation:** `bun run verify` passed lint, typecheck, 919 tests, build,
  public declarations, Node smoke and all packed-consumer lanes.
- [x] **Not done:** no release, commit, push or downstream migration was
  performed.
