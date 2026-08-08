---
title: Prepared finite MCP surface registry
description: Precompile a bounded set of identity-selected contract and runtime tool surfaces while keeping all request state per call
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 01:54 +00:00
---

# Prepared finite MCP surface registry

## Problem

`createMcpHandler` prepares a static `services: ServiceDef[]` once. A dynamic
`services(auth)` factory is necessarily prepared again for every fresh MCP
server. This is correct for arbitrary identity-dependent surfaces, but wasteful
when an application has a small, immutable set such as `admin` and `member`.

For a large surface, every stateless request currently repeats collection,
union presentation shaping, Zod → JSON Schema conversion, portability checks
and collision validation. Protected runtime tools registered through
`nativeTools` repeat their presentation/schema preparation as well, even when
their definitions are process-static.

The cache must never retain auth, request context, lifecycle state or tool-call
context. Only immutable descriptors may be shared.

## Design direction

Expose a finite, eagerly known registry selected by a typed key, for example:

```ts
createMcpHandler({
  surfaces: {
    admin: { services: allServices, runtimeTools: [viewFile] },
    member: { services: memberServices, runtimeTools: [viewFile] },
  },
  selectSurface: auth => auth.isAdmin ? 'admin' : 'member',
  auth,
  context,
  lifecycle,
  hooks,
})
```

The exact public shape must be settled during implementation, but it must remain
one coherent registration model. Do not add a generic unbounded `Map` keyed by
arbitrary identities, and do not add a second runtime-tool runner.

## Plan

- [x] Benchmark current static and dynamic preparation separately with a small
  surface and a large representative surface; record build/request cost in the
  task before choosing optimizations.
- [x] Define a typed finite registry whose selector can return only declared
  keys and whose entries contain the complete immutable MCP surface.
- [x] Prepare every unique contract surface exactly once at handler/server
  construction using the canonical `prepareMcpSurface` pipeline.
- [x] Prepare Stitchkit-owned runtime tool descriptors exactly once per unique
  surface, including schema validation, presentation metadata and name
  collision checks.
- [x] On every request/session, create only the fresh SDK server/transport and
  bind current auth/context/lifecycle/hooks to prepared descriptors.
- [x] Keep `inToolCallContext` isolated per invocation, including parallel calls
  against the same prepared surface.
- [x] Detect duplicate names across contract and runtime tools at preparation
  time.
- [x] Fail first when `selectSurface` returns an unknown key.
- [x] Decide the clean relationship with the current `services(auth)` and
  `nativeTools` callbacks. If one public path is replaced, make the breaking
  change explicitly in a pre-1.0 minor; do not leave compatibility aliases or
  overlapping registration APIs.
- [x] Cover both stateless and stateful HTTP MCP handlers and the shared
  transport-neutral server builder where applicable.
- [x] Update MCP guide, API reference, ADR/index if the ownership model changes,
  generated LLM docs and `[Unreleased]` changelog with migration snippets.

## Tests

- [x] Each declared surface is prepared once regardless of request count.
- [x] Two identities selecting the same key share descriptors but receive
  different auth/context.
- [x] Different keys expose exactly their declared tool sets.
- [x] Parallel tool calls have isolated request/tool contexts and hooks.
- [x] Runtime multimodal presentation and validated structured output are
  unchanged.
- [x] Schema policy, `extend`, union flattening, output stripping, lifecycle and
  error normalization match ordinary contract/runtime tools.
- [x] Unknown keys and cross-surface duplicate names fail before serving calls.
- [x] Benchmarks show the optimization removes measurable repeated preparation;
  no speculative global cache is introduced.

## Acceptance

- [x] A bounded role/plan surface registry compiles immutable descriptors once.
- [x] No auth or request-scoped value is retained by the prepared registry.
- [x] Contract tools and protected runtime tools use the same canonical runner
  and validation semantics as before.
- [x] The public API has one clear path with no compatibility wrappers.
- [x] `bun run verify` is green (907 tests, 1932 assertions).

## Non-goals

- Caching an arbitrary `services(auth)` result per user/token.
- Reusing an MCP SDK server or transport across stateless requests.
- Application-specific roles, plans or authorization policy.
- Release, commit, push or downstream migration.

## Benchmark record

Measured locally with Bun 1.3.14 before the registry implementation:

- direct `prepareMcpSurface` repeated 200 times for one representative tool:
  **0.174 ms/request** average; prepared once: **0.074 ms**;
- repeated preparation of 160 representative tools: **11.036 ms/request**
  average; prepared once: **8.046 ms**;
- the request-path benchmark (`30` stateless initialize requests) measured 12
  tools at **25.49 ms cached vs 45.71 ms dynamic**, and 159 tools at
  **88.34 ms cached vs 485.99 ms dynamic** total.

After implementation, the same request benchmark measured the finite registry
at **17.09 ms vs 45.22 ms dynamic** for 12 tools and **90.54 ms vs 461.38 ms
dynamic** for 159 tools over 30 requests. The large surface removes roughly
12 ms of repeated preparation per request on this machine. Wall-clock numbers
are diagnostic rather than a test assertion; regression tests prove the
preparation count and isolation deterministically.

## Settled public model

- Static or genuinely unbounded definitions use `services` and `runtimeTools`,
  each as an array or an identity factory. Dynamic factories remain uncached.
- Bounded definitions use `surfaces` plus typed `selectSurface`; all unique
  entries are prepared eagerly and object-identical aliases share descriptors.
- The protected registrar is removed. Managed pathless operations have one
  declarative `runtimeTools` path on MCP and Agent surfaces.
- Raw SDK registration is isolated under `rawTools`; it remains intentionally
  outside framework lifecycle, validation and hooks.

## What was done

- [x] **Core:** `/packages/core/src/tools/mcp.ts` now prepares complete contract
  and runtime surfaces; `/packages/core/src/tools/mcp-handler.ts` eagerly
  compiles finite registries and binds fresh request state.
- [x] **Runtime mounting:** `/packages/core/src/tools/native-mcp.ts` mounts
  prepared runtime descriptors through the canonical runner; `nativeTools` was
  replaced by managed `runtimeTools` and explicit raw `rawTools`.
- [x] **Tests:** `/packages/core/tests/mcp-preparation-cache.test.ts` covers
  eager preparation, typed/unknown selection, direct/stateful/stateless parity,
  descriptor sharing, context isolation and collisions. Existing runtime and
  multimodal suites were migrated and remain green.
- [x] **Benchmark:** `/packages/core/scripts/benchmark-mcp-preparation.ts`
  compares static, finite-registry and uncached dynamic request paths; the
  recorded large-surface run removes roughly 12 ms/request of repeated work.
- [x] **Documentation:** ADR 0057, the decisions index, MCP/upgrading guides,
  API reference, changelog and generated LLM docs describe the new ownership
  model and breaking migration.
- [x] **Validation:** `bun run verify` passed lint, typecheck, 907 tests, build,
  public declaration checks, Node smoke and packed-consumer lanes.
- [x] **Not done:** no release, commit, push or downstream migration was
  performed.
