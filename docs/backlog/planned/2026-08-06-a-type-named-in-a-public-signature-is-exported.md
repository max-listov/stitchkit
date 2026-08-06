---
title: "A type named in a public signature is exported"
description: ToolCallContext was not a one-off — three more types are named in public signatures and exported from nowhere, so a consumer writing a standalone function has to recover them with Parameters<...> gymnastics.
type: task
status: planned
created: 2026-08-06
updated: 2026-08-06
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

## Acceptance

- [ ] `ViewFileOptions`, `MultipartResult`, `McpAnnotations` exported from
      `stitchkit/tools`; `WrapRequestContextOptions` from
      `stitchkit/observability`
- [ ] Each has a row in `docs/api/reference.md`
- [ ] A guard that fails on a type reachable from a public signature but not
      exported from that entrypoint, with a peer-owned allowlist
- [ ] Retro-check: remove `ToolCallContext` from `tools.ts` and confirm the guard
      fails — a guard nobody has watched fail is a guess
- [ ] Wired into `verify`
- [ ] `CHANGELOG.md` — additive
- [ ] The rule stated where it is enforced (the guard's own header comment), in
      one sentence: a type a consumer can be required to name is public

## Open questions

- Whether deep imports (`stitchkit/dist/tools/execute`) should be closed off
  entirely in the `exports` map. Today the emitted declarations keep the module
  structure, so a determined consumer can reach an unexported type by path — and
  will, if that is easier than asking for an export. Closing the door makes the
  guard meaningful; it is also the kind of change that breaks someone quietly.
