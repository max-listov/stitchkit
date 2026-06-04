---
title: "ADR 0017 — Typed tool-path context via createToolkit"
type: decision
status: accepted
created: 2026-05-29
updated: 2026-05-29
---

# ADR 0017 — Typed tool-path context via `createToolkit`

- **Status:** Accepted — extends [ADR 0003](0003-two-context-types.md)
- **Date:** 2026-05-29

## Context

ADR 0003 keeps the transport-level context **loose** (`RuntimeContext`) and
types it only at the handler boundary, where `createImplement<AppContext>()`
gives `ctx.user` its real type on every surface.

The handler is typed; the **wiring** into a tool transport was not. The context
a transport injects, and a `ToolExtend.resolve` result, were
`Record<string, unknown>`:

```ts
mountMcp({ context });                 // context?: Record<string, unknown>
buildMcpServer({ context: (a) => … }); // (auth) => Record<string, unknown>
```

So TypeScript could not catch a missing or wrong-typed `user` in the injected
context. There is no runtime hole — wire it right and it works — but the
fullstack-type-safety pitch leaks on the tool side. Adding the CLI transport
(ADR 0016) would have made it a fourth untyped wiring site.

## Decision

**Add a typed factory that mirrors `createImplement`, leave the loose path
intact.** `createToolkit<AppContext>()` fixes the context shape once and returns
context-pinned `mountMcp` / `mountAgent` / `buildMcpServer` / `createMcpHandler`
/ `createStdioMcpServer` / `createCli` — each with its injected `context` (and
`ToolExtend.resolve`) checked against `AppContext`:

```ts
const tools = createToolkit<{ user: User }>();
tools.createCli({ context: (auth) => ({ user: auth }) }); // type-checked
```

It is **pure typing sugar**: each method forwards verbatim to the underlying
function. The underlying functions stay `Record<string, unknown>`-typed for
callers who do not opt in — ADR 0003's loose-by-default rule is preserved. The
only structural change is that `ToolExtend` becomes generic
(`ToolExtend<TContext>`, default `Record<string, unknown>`), so the typed
boundary can flow a context shape into `resolve`.

## Why a factory, not generic configs

The alternative — making every config (`McpMountConfig`, `McpServerBuildConfig`,
`AgentMountConfig`, `McpHandlerConfig`, `StdioMcpServerConfig`) generic over
`<TContext>` — is maximally safe but threads a generic through the entire mount
stack. The factory achieves the same safety at the boundary the app actually
declares its context at, without that invasive threading, and reads exactly like
the `createImplement<TCtx>()` the framework already uses for handlers.

## Consequences

- The tool surface is born as type-safe as the handler — the CLI transport
  ships typed instead of adding a fourth untyped wiring site.
- `createImplement<AppContext>()` (handler) and `createToolkit<AppContext>()`
  (tool transports) are the two places an app fixes its context type — one
  pattern, two boundaries.
- No migration: existing `mountMcp({ context })` calls keep compiling against
  the loose form.
