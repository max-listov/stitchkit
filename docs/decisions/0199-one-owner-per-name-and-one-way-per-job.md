# 0199 — One owner per name, one way per job: the 0.94 consolidation

**Status:** Accepted
**Date:** 2026-09-23

Applies [PRINCIPLES](../PRINCIPLES.md) I8 (one mechanism per job, no parallel
path, alias or shim) to the surface as it stood at 0.93, and is the ADR that
[ADR 0198](0198-stable-is-earned-and-kept-on-a-budget.md) requires for breaking
a stable entrypoint. Read with [0196](0196-a-tool-answer-is-a-declared-view.md)
and [0197](0197-the-agent-runtime-is-a-product-behind-a-one-way-boundary.md).

## Context

A review of the package at 0.93 found the same thing in several places: one
idea with two or more homes. The public surface had grown from 592 names on 9
entrypoints to 2 285 on 38 in five weeks, and 329 names were exported from more
than one entrypoint — some deliberately (a browser-safe subset, a runtime
mirror), others because a name had simply been exported where it was first
needed and again where it belonged. Inside the source the same pattern showed
as duplicated machinery: one MCP tool registration written twice, four canonical
JSON serialisers, four names for the tool-transport type, an eleven-parameter
positional executor whose optional tail was passed as `undefined` placeholders.

Each duplicate is a promise the next reader has to check twice, and two copies
drift: the two MCP registrations had already diverged in how a failure thrown
outside the handler was answered.

## Decision

Every public name has one owner; every job has one implementation. For 0.94:

**Public names, each moved to its owner (breaking):**

| Name(s) | Was also on | Owner |
|---|---|---|
| `createCli`, `defineCliCommand`, `CliConfig` and the other CLI types | `stitchkit/tools` | `stitchkit/cli` |
| `parseSSE`, `ParseSSEOptions` | `stitchkit/server` | `stitchkit` |
| `createLocalStepDurability`, `LocalStepDurability`, `LocalStepDurabilityOptions`, `StepDurabilityLedger` | `stitchkit/agent-runtime` | `stitchkit/tools` (ADR 0187) |
| the race driver and `runAgentStoreConformance` | `stitchkit/testing` | `stitchkit/agent-runtime/testing` (ADR 0197) |
| `RuntimeToolTransport`, `ToolSurfaceTransport`, `ToolInvokerTransport` | three entrypoints | one `ToolTransport` (+ `TOOL_TRANSPORTS`) in `stitchkit/contract` |

Names shared on purpose stay shared, each with its reason in
`packages/core/tests/fixtures/public-surface-budget.json`, which also caps every
entrypoint at its current count. A new shared name or a higher ceiling is a
reviewed edit to that file.

**Machinery, each reduced to one implementation (no public change):**

- one canonical JSON serialisation (`serializeCanonicalJson`) behind every
  digest; its order is UTF-16 code units, as every stored digest already was,
  and a test pins it;
- one MCP tool registration for contract endpoints and runtime tools;
- one tool executor signature: `executeToolMethod(method, call, options)`;
- `src/` laid out by part (`tools/cli`, `tools/mcp`, `tools/operations`,
  `tools/transfer`, `tools/schema`, `json-schema`, `durability`,
  `server/oauth`), with the directions between parts declared and checked by
  `tests/import-graph.test.ts`: no runtime cycle between parts, `internal` a
  leaf;
- functions over 200 lines and files over 500 lines are declared exceptions
  with a reason (`tests/fixtures/code-size-exceptions.json`), so the list only
  shrinks.

The tool options of an endpoint became one `tool` group in the same release —
the reasoning is ADR 0196's.

## Consequences

- One breaking minor carries all of it, with one migration section and a
  codemod for the mechanical part.
- These are the stable entrypoints this ADR breaks: `stitchkit`,
  `stitchkit/contract`, `stitchkit/server`, `stitchkit/tools`,
  `stitchkit/tools/invoker`, `stitchkit/testing`. Under ADR 0198 that is one
  stable-breaking minor, spent once.
- The gates keep the result: the budget and the snapshot for names, the import
  graph for directions, the size list for closures.
