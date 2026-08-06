---
title: "A type named in a public signature is exported"
description: ToolCallContext was not a one-off — three more types are named in public signatures and exported from nowhere, so a consumer writing a standalone function has to recover them with Parameters<...> gymnastics.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 14:35 +07:00
related: docs/backlog/planned/2026-08-06-the-published-package-is-tested-as-a-consumer-uses-it.md
---

# A type named in a public signature is exported

## The evidence

A consuming project reported that `ToolCallContext` — the third parameter of the
`onToolError` hook shipped in 0.30.0 — was not exported, and recovered it with:

```ts
type ToolCallContext = Parameters<NonNullable<ToolCallHooks['afterToolCall']>>[4]
```

That was fixed in 0.31.0. The fix was one line, which is exactly why it is worth
asking whether it was the only one. It was not — swept the public surface and
found three more of the same shape:

| Public API | Type it names | Exported |
|---|---|---|
| `mountViewFile(server, options)` | `ViewFileOptions` | no |
| `parseMultipart(…)` → | `MultipartResult` | no |
| `wrapInRequestContext(handler, options)` | `WrapRequestContextOptions` | no |
| `McpMediaContent` (exported) contains | `McpAnnotations` | no |

So the consumer hit one instance out of four. Everything else on the sweep was
either internal (`RouteMatch`, `NormalizedGroup`, `ToolRunnerConfig`, `SweptMap`)
or correctly exported from its own entrypoint (`NodeServerConfig` from
`stitchkit/node`, `EmitOptions` from `stitchkit/cli`) — so the gap is narrow and
real, not a rewrite.

The rule this violates is not written down anywhere, which is why it drifts:
**if a consumer can be required to name a type, that type is public.** A
parameter type, a return type, a member of an exported union.

## Decision

Two parts, and the guard matters more than the four fixes — without it this note
gets written again in six months.

**1. Export the four.** `ViewFileOptions`, `MultipartResult` and `McpAnnotations`
from `stitchkit/tools`; `WrapRequestContextOptions` from
`stitchkit/observability`. Rows in `docs/api/reference.md` for each. Additive.

**2. A guard that fails when a reachable type is not exported.** For every
entrypoint in the `exports` map, walk its exported declarations, collect the type
names they reference, and assert each is itself exported from that same
entrypoint. The TypeScript compiler API over the emitted `.d.ts` is the honest
tool for this — the emitted declarations are exactly what the consumer sees.

Be realistic about the guard: full reachability analysis has edges (structural
literals, generics, types from peer dependencies such as `McpServer` or `ToolSet`
which must be excluded because the consumer gets them from the peer). Ship it
with an explicit allowlist for peer-owned names rather than a clever heuristic —
an allowlist is legible and its entries can be argued with.

**Cheaper interim if the analyzer proves fiddly:** the consumer fixture from the
sibling task annotates every options / return type it touches, which catches the
same class through compilation instead of analysis. Slower to notice (it only
covers what the fixture exercises) but it is a fraction of the work. Do not do
both; pick one and say which in the ADR.

## What the analyzer changed about the plan

Built it, ran it, and the **rule as written was wrong** — twice, both times
visible only against the real package.

1. **"exported from the same entrypoint" over-reports.** The first run flagged 45
   names, and most were `stitchkit/tools` naming `ServiceDef` from
   `stitchkit/server` — which is how a multi-entry package is *supposed* to work.
   The rule is "exported from **some** entrypoint": what must never happen is a
   type a consumer has to write down that no import can reach.
2. **"named in a public signature" over-reports too.** Even corrected, it flagged
   inference machinery — `ArgsWith`, `EndpointArgs`, `ScopedKeys` — which appears
   in signatures but which nobody writes; the compiler computes it. Narrowed to
   skip references inside conditional / mapped / indexed / `infer` constructs.
   45 → 22, and the list became legible.

## What the guard then found

Beyond the four from the sweep, two more of exactly the same shape — an options
type in a parameter position, exported nowhere:

- `VerifyJwtOptions` (options of `verifyJwt`)
- `EventBusOptions` / `EventHandler` / `DefaultEventMap` (`createEventBus`)
- `CollectToolsConfig` (options of `collectTools`)

`EventHandler` was not even exported from its own module — the guard found a type
that was private twice over.

## Acceptance

- [x] `ViewFileOptions`, `MultipartResult`, `McpAnnotations` exported from
      `stitchkit/tools` / `stitchkit/server`; `WrapRequestContextOptions` from
      `stitchkit/observability` — plus the four the guard itself turned up
- [x] Each has a row in `docs/api/reference.md`
- [x] `packages/core/scripts/check-public-types.mjs` — the TypeScript compiler
      API over the emitted declarations. Peer-owned names need **no** allowlist
      entry: they are not declared inside `dist`, so the check never asks about
      them. The allowlist carries only types this package owns and keeps
      internal, each with its reason
- [x] Retro-check: `ToolCallContext` removed from `tools.ts` → guard fails with
      `stitchkit/tools → ToolCallContext (via ToolCallHooks)`. Restored
- [x] Wired into `build`, so it runs everywhere the artifact is produced
- [x] `CHANGELOG.md` — additive
- [x] The rule is the guard's header comment, first line

## Что сделано

**Экспорты** — `ViewFileOptions`, `McpAnnotations`, `CollectToolsConfig`
(`stitchkit/tools`) · `MultipartResult`, `VerifyJwtOptions`, `EventBusOptions`,
`EventHandler`, `DefaultEventMap` (`stitchkit/server`) ·
`WrapRequestContextOptions` (`stitchkit/observability`). `EventHandler` also had
to be exported from `event-bus.ts` itself.

**Гвард** — `check-public-types.mjs`, in `build`. Two passes: collect everything
reachable from any entrypoint, then walk each entrypoint's exported declarations
for type references that are ours, unreachable, and not accepted. Reports the
entrypoint, the name, the export it was reached through and the declaring file.

**Allowlist that cannot rot** — accepted names are recorded *as seen*, so an
entry that stops being referenced is reported for removal. The first version
computed this from `findings`, which accepted names never enter — it told me to
delete the entire working allowlist. Fixed before it could disarm the guard.

## Не делалось

- [x] The fixture-annotation alternative — the analyzer is systematic where a
      fixture only covers what it exercises, and it earned the choice by finding
      four types no fixture would have touched. The lane's annotations stay as
      the second net
- [x] Closing off deep imports in the `exports` map — still open, still the
      reason a determined consumer can reach an unexported type by path. Its own
      decision; noted below

## Open questions

- Whether deep imports (`stitchkit/dist/tools/execute`) should be closed off
  entirely in the `exports` map. Today the emitted declarations keep the module
  structure, so a determined consumer can reach an unexported type by path — and
  will, if that is easier than asking for an export. Closing the door makes the
  guard meaningful; it is also the kind of change that breaks someone quietly.
