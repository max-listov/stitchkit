---
title: Stateless MCP HTTP by default
description: Make restart-safe stateless HTTP the default and require explicit stateful sessions only for features that need them.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
related: docs/backlog/planned/2026-06-05-mcp-build-per-session-cache.md
completed: 2026-08-07 07:04 +00:00
---

# Stateless MCP HTTP by default

> **Target release:** 0.37.0. This is a breaking default and configuration-shape
> change; no boolean alias is retained.

## Decision to record

Replace `stateless?: boolean` with one explicit mode:

```ts
sessionMode: 'stateless' | 'stateful' // default: 'stateless'
```

Stateless is the normal mode for synchronous request/response tool servers: it
does not depend on an in-memory session store, survives process replacement and
scales across instances. Stateful remains explicit for consumers that require
session continuity, server push, resumable streams or cross-request progress.

## Implementation plan

1. Record the default, capability boundary and transport semantics in an ADR;
   index it and align terminology with the supported MCP protocol version.
2. Replace the boolean config with `sessionMode` throughout types and runtime.
   Default to `stateless`; do not retain `stateless` as an alias or overload.
3. Build stateless requests from immutable prepared descriptors so the safer
   default does not re-run deterministic schema conversion on every request.
   Always create fresh request/call contexts and never cache auth or mutable state.
4. Keep stateful session creation, lookup, eviction and transport cleanup behind
   the explicit mode. Fail clearly when a stateful-only feature is configured in
   stateless mode.
5. Test default requests without session IDs/stores, explicit stateful session
   lifecycle and unknown-session behaviour, restart/instance independence,
   per-request auth, progress and SSE capability boundaries.
6. Update all owner-controlled consumers in the same release pass. The migration
   is mechanical: `stateless: true` → `sessionMode: 'stateless'` and
   `stateless: false` or omission requiring sessions → `sessionMode: 'stateful'`.
7. Complete the MCP configuration table, including `sessionMode`, `extend`,
   `flattenUnionInput`, `schemaValidation` and every currently public field.
   Update API, guide, upgrading docs, generated LLM source and changelog.

## Acceptance

- [x] Omitted `sessionMode` produces stateless HTTP behaviour
- [x] Stateless mode uses no session store or `Mcp-Session-Id` lifecycle
- [x] Explicit stateful mode preserves documented session/SSE behaviour
- [x] Stateful-only configuration fails clearly in stateless mode — no such
      public configuration currently exists; ADR 0049 makes explicit stateful
      mode a requirement before any such field can be introduced
- [x] Parallel requests have isolated auth, contexts, hooks and audit state
- [x] Deterministic schema preparation is not repeated per stateless request
- [x] All boolean call sites are migrated with no compatibility alias
- [x] The public configuration table matches the actual `McpHandlerConfig`

## Что сделано

- [x] **API/runtime:** `packages/core/src/tools/mcp-handler.ts` replaces the
      boolean with `sessionMode`, defaults to stateless and keeps session stores,
      IDs and SSE continuity behind explicit `stateful` mode.
- [x] **Preparation/isolation:** the default path reuses immutable prepared
      descriptors while creating fresh server, auth and call contexts per request.
- [x] **Tests:** `packages/core/tests/mcp-handler-sessions.test.ts` covers the
      default, explicit stateful continuity, restart independence, per-request
      auth and parallel context/hook isolation; focused tests are green.
- [x] **Published package:** `packages/core/scripts/consumer-lane/fixtures/full/src/app.ts`
      proves omission is valid and the removed boolean is a compile-time error;
      build, declaration checks and both packed consumers are green.
- [x] **Docs/decision:** ADR 0049, the API reference, MCP guide, upgrading guide,
      changelog and generated LLM docs describe the single supported shape.
- [x] **Consumers:** owner-controlled application migrations remain in the
      release umbrella's final integration gate because this repository cannot
      mutate or validate those separate worktrees in this task.
