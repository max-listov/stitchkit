---
title: Framework-owned native MCP tool registration
description: Add a native MCP registration path that preserves multimodal results while running through stitchkit identity, lifecycle, validation, per-call context and observability.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 07:12 +00:00
related: docs/decisions/0045-a-tool-call-runs-in-its-own-context.md
---

# Framework-owned native MCP tool registration

> **Target release:** 0.37.0. Reported by a consuming project blocked on three
> entity operations that require native MCP results and complete audit parity.

## Verified gap

`buildMcpServer` mounts contract tools through `mountMcp`, then hands the raw
SDK `McpServer` to `nativeTools`. A raw `server.registerTool` callback receives
the resolved build identity, but it does not enter stitchkit's per-call context
and does not run `ToolLifecycle` or `ToolCallHooks`. This is intentional and
documented today, but it leaves no supported path for a multimodal MCP tool that
also needs lifecycle/RBAC and `RequestEvent` audit parity.

The call order is not the cause: moving `nativeTools` before `mountMcp` would
not connect raw SDK callbacks to the runner. The missing piece is a
framework-owned registration/execution path.

## Model and decision to record

Add a native operation definition with one source of truth for:

- MCP name, description, advertised Zod input and optional structured output;
- operation identity: `serviceName`, `action`, `scope` and semantic HTTP method;
- optional annotations, UI metadata and opaque endpoint metadata;
- a typed handler that receives the same runtime context as contract tools and
  returns an MCP-native result (`content`, optional `structuredContent`,
  `isError`, `_meta`) without JSON/text coercion.

The preferred public shape is a framework-owned registrar supplied to
`nativeTools`, closed over the build's context, lifecycle and hooks. Keep raw
SDK access explicit for primitives that intentionally opt out; do not make raw
registration look lifecycle-protected. Decide the exact registry shape in a new
ADR before implementation, including whether a standalone mount helper is also
public. Do not manufacture an HTTP path for a tool that has none.

## Implementation plan

1. [x] Write the ADR and index it. Compare: a registrar passed to `nativeTools`, a
   standalone `mountNativeTool`, and forcing multimodal operations into normal
   contracts. Select one canonical framework-owned path plus an explicit raw
   escape hatch, without aliases or compatibility wrappers.
2. [x] Extract the common execution envelope from the contract runner: per-call
   `inToolCallContext`, `beforeToolCall`, input parsing, lifecycle before/after,
   thrown-error observation, output validation and `afterToolCall`.
3. [x] Keep result adaptation separate. Contract tools continue producing the
   existing JSON/text envelope; native tools return the MCP SDK result unchanged
   so image/audio/resource/text blocks, `structuredContent` and `_meta` survive.
4. [x] Define output validation precisely: validate the declared structured payload
   against its Zod schema while preserving non-structured multimodal blocks.
   Reject an invalid declared output as `INTERNAL_SERVER_ERROR` through the same
   failure/audit path as contract tools.
5. [x] Build the hook endpoint identity from the native definition so lifecycle and
   audit read `serviceName`, `action`, `scope`, semantic method and metadata from
   one object. The request context must expose the same identity and isolate
   writable dimensions/error state for every parallel call.
6. [x] Thread the registrar through every MCP server construction path: stateful
   HTTP sessions, stateless HTTP and stdio. Resolve build identity once according
   to each transport's existing rules; never cache per-call context.
7. [x] Migrate stitchkit's native helpers where lifecycle parity is meaningful;
   leave intentionally raw helpers explicitly documented. Update the three
   owner-controlled entity operations in their consumer during the same release
   pass, without naming that project in committed stitchkit files.
   leave intentionally raw helpers explicitly documented. The three controlled
   consumer operations are transferred to the release umbrella's consumer lane;
   repository policy forbids naming that project here.
8. [x] Update the MCP guide, observability guide, API reference, generated LLM docs
   source and the 0.37.0 changelog. Include a migration example from raw
   `server.registerTool` to framework registration.

## Dependencies and order

Implement this API only after the final
[`ToolCallHooks` options-object shape](./2026-08-06-tool-hooks-take-one-options-object.md)
and the shared
[`MCP schema validation profile`](./2026-08-07-mcp-schema-validation-profile.md)
are settled. The registrar must be born on the final runner and prepared-schema
abstractions, not migrated from an intermediate positional or separately
validated implementation. Portable-format policy applies identically to native
and contract tools.

## E2E acceptance

- [x] A native text+image result is preserved byte-for-byte through MCP
- [x] Declared input and structured output are validated with the canonical Zod schemas
- [x] `beforeHandle` enforces scope/RBAC using the native operation identity
- [x] `afterHandle`, `beforeToolCall`, `onToolError` and `afterToolCall` run with the documented ordering
- [x] Two parallel native calls keep dimensions, errors and audit rows isolated
- [x] `RequestEvent` names the configured service/action and shares the parent request trace correctly
- [x] HTTP stateful, HTTP stateless and stdio MCP paths register equivalent tools
- [x] Raw SDK registration remains visibly outside lifecycle/hooks; no false security promise
- [x] SDK-level `InvalidParams` behaviour is documented honestly: rejection before the callback cannot produce stitchkit hooks/audit
- [x] The consuming project's three entity tools pass their real E2E audit scenario after migration → transferred to `2026-08-07-release-0.37.0-hardening.md` final consumer gate; no cross-project mutation was made from this repository task

## Not doing

- Serializing multimodal content into JSON text to reuse the existing formatter.
- Pretending registration order alone connects native callbacks to lifecycle.
- Inventing a domain model or entity-specific API in stitchkit.
- Adding a compatibility alias or maintaining two framework-owned native paths.

## Что сделано

- [x] **Identity:** `packages/core/src/server/types.ts` adds path-free
  `OperationIdentity`; contract `MethodDef` extends it and native tools no longer
  pretend to own an HTTP route.
- [x] **Runner:** `packages/core/src/tools/execute.ts` accepts a shared
  `ToolOperation`, preserving the existing input/output/lifecycle/hook ordering
  and per-call `AsyncLocalStorage` fork.
- [x] **Registrar:** `packages/core/src/tools/native-mcp.ts` provides typed
  `NativeMcpRegistrar.registerTool`, validates definitions through the canonical
  prepared-schema profile, and retains `rawServer` as an explicit opt-out.
- [x] **Server paths:** `packages/core/src/tools/mcp.ts` creates the registrar in
  the transport-neutral server builder used by stateful HTTP, stateless HTTP
  and stdio.
- [x] **Multimodal output:** text/image/audio/resource content and `_meta` pass
  through unchanged; a declared Zod output parses only `structuredContent`.
- [x] **Raw helpers:** `packages/core/src/tools/view-file.ts` and the MCP guide
  state that SDK-server helpers bypass lifecycle/hooks and show the protected
  `resolveMedia` alternative.
- [x] **Tests:** `packages/core/tests/native-mcp-registration.test.ts` covers
  multimodal preservation, schema policy, RBAC, ordering, failure normalization,
  parallel audit isolation, parent trace, transport parity, SDK rejection and
  the raw escape hatch.
- [x] **Published package:** the full packed consumer fixture compiles and
  registers a typed native definition through public exports; declaration
  closure and minimal/full consumer lanes pass.
- [x] **Docs:** ADR 0048, MCP/observability/upgrading guides, API reference,
  changelog and generated LLM docs describe the final model and migration.
