---
title: "ADR 0236: One runtime-tool declaration"
description: "A runtime tool is declared by one peer-free generic definition whose presenters are the adapter's typed extension, registered through one type that types an inline handler; the parallel execution, MCP and SDK families and the empty surface alias are removed."
type: decision
status: accepted
created: 2026-10-05
updated: 2026-10-05
---

# ADR 0236 — One runtime-tool declaration

**Invariants:** I1, I3, I7, I8, I14. Builds on ADR 0227, 0231 and 0238.

## Context

A runtime tool (a pathless operation with identity, schemas and a handler) was declared by three
families of types, one per import path:

- `RuntimeToolExecution*` on `stitchkit/cli`;
- `RuntimeMcpToolDefinition*` on `stitchkit/tools/mcp`;
- `RuntimeToolDefinition*` on `stitchkit/tools`, carrying MCP and Agent presenters.

The split protected declaration-peer isolation (I7): the CLI binary and the MCP-only leaf must not
import `ai` or the other adapter's SDK. The price was paid at the call site. Registration erased the
handler to `handler(context: never)`, so `runtimeTools: [{ input, handler: ({ input }) => … }]`
failed with TS2339 on `never`, and a consumer had to pick a `satisfies` type by entrypoint before
registering. `ToolSurfaceDefinition` was an empty extension of `ToolSurfaceProjection` exported
beside it. The generic runner (`tools/execute-result.ts`), bundled by `cli`, `tools` and `mcp`,
also imported the connection error projection, an optional sub-export.

## Decision

1. **One declaration, in a module with no SDK declaration.** `RuntimeToolDefinitionWithOutput` and
   `RuntimeToolDefinitionWithoutOutput` (with `RuntimeToolDefinitionBase`, the handler context and
   identity types) live in `tools/runtime-tool-declaration.ts` and are exported under the same
   names from `stitchkit/cli`, `stitchkit/tools` and `stitchkit/tools/mcp`. A handler is typed from
   the schemas; a callback that needs a field the schema omits is refused at construction.
2. **Presenters are the adapter's extension.** The fourth type argument of
   `RuntimeToolDefinitionWithOutput` names the `present` shape; the neutral default admits none.
   `stitchkit/tools/mcp` supplies `RuntimeMcpToolPresenters`, `stitchkit/tools` supplies
   `RuntimeToolPresenters` (MCP and Agent) and its `defineRuntimeTool` and tool factory fix that
   argument, so presenters keep their exact output type without a peer in the neutral module.
   Presenters are declared as methods: a presenter written for one tool's output registers beside
   the others, and the canonical runner validates the output before calling it.
3. **One registration type.** `RuntimeToolDefinition` accepts any definition and declares its
   handler as a method. A method parameter is compared bivariantly, so a definition built against
   its own schema registers unchanged, and an inline handler is contextually typed by the parsed
   object instead of erased. The mount that reads `present` (Agent, MCP) narrows it with a type
   predicate: each presenter was typed when its tool was declared.
4. **One surface container.** `ToolSurfaceDefinition` is deleted; `ToolSurfaceProjection` is the
   single `{ services?, runtimeTools? }` container, and the introspection helpers take
   `ToolSurfaceProjection<RuntimeToolDefinition>`.
5. **The generic runner knows no connection class.** An error class chooses its own projection to a
   safe `AppError` through the `TOOL_ERROR_PROJECTION` protocol (`tools/internal`); the runner calls
   it and keeps the thrown value as the raw cause. The connection errors implement it, and
   `connections/error-projection.ts` is deleted.

Removed names: `RuntimeToolExecution`, `RuntimeToolExecutionWithOutput`, `RuntimeMcpToolDefinition`,
`RuntimeMcpToolDefinitionWithOutput`, `ToolSurfaceDefinition`. The new entrypoint names are
`RuntimeToolDefinition`, `RuntimeToolDefinitionWithOutput` and `RuntimeToolDefinitionWithoutOutput`
on `cli` and `tools/mcp`, and `RuntimeToolDefinitionWithOutput` gained its fourth type argument.

## Reason and verification

One concept has one name and one way to declare it (I1, I8); the call site reads the same
whichever adapter registers the tool, and an inline handler type-checks (I3). Isolation (I7) is kept
by what the neutral module imports, not by splitting the declaration. `stitchkit/cli` and
`stitchkit/tools` are stable, so the break is a minor that cites this ADR with a migration in
`docs/guide/upgrading.md` (ADR 0198, 0238).

`tests/runtime-tool-declaration.type-test.ts` checks, through `tsc`, that an inline handler in each
registration list is typed, that construction stays strict, that a neutral definition carries no
presenter, and that a registered handler is not callable without the runner's context. The packed
consumer lanes (`cli-types`, `mcp-leaf-types`, `runtime-tool-types`) keep the same assertions against
the installed artifact. `tests/connections-error-projection.test.ts` pins the projection and the
raw cause, and `rg "connections/" packages/core/src/tools/execute-result.ts` is empty.
