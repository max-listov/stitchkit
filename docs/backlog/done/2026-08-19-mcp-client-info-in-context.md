---
title: Typed MCP call metadata in application context
description: Make the already-propagated MCP era, method and self-reported clientInfo a documented typed field for handlers, lifecycle and tool hooks.
type: task
status: done
created: 2026-08-19
updated: 2026-08-20
completed: 2026-08-20 08:53 +00:00
---

# Typed MCP call metadata in application context

## Зачем

A consuming project records where an operation was started: UI, CLI, an MCP
host or an agent. Modern MCP already carries the host's self-description as
`clientInfo: { name, version }`, but Stitchkit does not expose the surrounding
MCP call metadata as a public typed application contract.

The original inbox report described the runtime gap too broadly. In 0.53.2
`packages/core/src/tools/mcp-round.ts::transportContext` already places the
validated envelope data in `context.mcp`, and the managed contract/runtime
runners merge it into handlers, lifecycle and hooks. `RequestEvent.mcp` is not
the only runtime destination. The actual defect is that `RuntimeContext`,
`HandlerContext`, `ToolCallContext` and runtime-tool factory context leave
`mcp` behind an `unknown` index signature, while the guide documents only the
observability projection.

`clientInfo` is caller-controlled self-description. It is useful for labels and
analytics, but is never authentication, authorization, tenant identity or a
rate-limit key.

## Результат

- One public nested MCP call-context type describes the exact object Stitchkit
  already builds: era, method, tool name, optional protocol/client information
  and optional multi-round outcome/round.
- Managed contract handlers, runtime-tool handlers/factories, lifecycle hooks
  and tool-call hooks see the same typed optional `context.mcp` field.
- `context(auth)` remains the build-identity/application-context factory. It is
  not turned into a second per-call transport resolver.
- Modern HTTP and stdio calls expose validated `clientInfo` synchronously during
  execution; a call without validated client information leaves it absent.

## План

- [x] Define and export one browser-safe `McpCallContext` type beside the shared
      runtime context; reuse the existing `McpRoundOutcome` union rather than
      duplicating transport metadata types.
- [x] Type `mcp?: McpCallContext` on `RuntimeContext`, `HandlerContext`,
      `ToolCallContext` and `RuntimeToolFactoryHandlerContext` without changing
      runtime merge order or the `context(auth)` callback.
- [x] Make `transportContext` return the canonical type and keep all envelope
      validation at the existing SDK/adapter boundary.
- [x] Add compile-time and real MCP regressions for contract/runtime handlers,
      lifecycle and hooks on HTTP and stdio; retain observability parity.
- [x] Update the MCP guide, architecture/ADR record, API reference, generated
      agent-facing docs source and changelog.

## Acceptance

- [x] A modern managed contract handler reads
      `ctx.mcp?.clientInfo?.name` as `string | undefined` without a cast or local
      parser.
- [x] Managed runtime-tool handlers/factories, lifecycle and hooks receive the
      identical typed metadata for the current invocation, including parallel
      and multi-round calls.
- [x] HTTP and stdio regressions prove the real SDK path; observability still
      reports the same `RequestEvent.mcp` projection.
- [x] Missing or unvalidated client information stays absent and no MCP metadata
      is accepted as auth/RBAC/tenant identity.
- [x] The public `context(auth)` signature and auth-selected surface preparation
      semantics are unchanged.
- [x] `bun run verify` is green.

## Конвейер 0/0

- [x] Plan validators: intentionally none by owner request.
- [x] Implementation and authorized gates completed by the primary agent.
- [x] Implementation validators: intentionally none by owner request.

## Границы

- No new wire fields, SDK accessor or ambient/global client state.
- No consumer-project edits, release, commit, tag or publish in this task.

## Что сделано

- [x] `McpCallContext`, `McpClientInfo` and `McpRoundOutcome` are exported from
      the browser-safe contract entry and reused by runtime/handler/tool-hook,
      runtime-tool factory and `RequestEvent.mcp` types.
- [x] The existing validated MCP transport context remains the only producer;
      application context and tool extensions cannot shadow its metadata.
- [x] ADR 0080, MCP architecture/guide, API reference, changelog and exact
      public-surface snapshot describe the same attribution-only semantics.
- [x] Регрессия: packages/core/tests/mcp-v2-modern.test.ts::exposes one typed MCP call context to handlers, lifecycle and hooks; packages/core/tests/mcp-v2-modern.test.ts::emits validated modern client attribution on the tool event; packages/core/tests/mcp-stdio-v2.test.ts::serves a modern list and real tool call through the official client transport; packages/core/tests/mcp-stdio-v2.test.ts::keeps the official legacy stdio lane stateless and functional.
- [x] Compile-time factory coverage lives in
      `packages/core/tests/runtime-tool-factory.test.ts` (`typed_mcp_context`).
- [x] `bun run verify` completed with exit 0 on 2026-08-20; no release, commit,
      tag or push was performed.
