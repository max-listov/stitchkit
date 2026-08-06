---
title: "ADR 0045 — A tool call runs in its own request context"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0045 — A tool call runs in its own request context

- **Status:** Accepted — scopes the `AsyncLocalStorage` context of
  [ADR 0012](0012-observability-module.md); makes the `dimensions` contract of
  [ADR 0029](0029-audit-endpoint-identity-and-dimensions.md) hold under
  concurrency
- **Date:** 2026-08-06

## Context

A consuming project found two `broadcast_delete` audit rows from one agent step
carrying the **same** `entityId` while their argument previews differed. Call A's
row said it acted on B. Reproduced here in a dozen lines through the real mount
and the real audit hook.

`executeToolMethod` opened no scope of its own, so `lifecycle.beforeHandle`, the
handler and the hooks all ran in whatever store the caller was in — for
MCP-over-HTTP, the single store for the whole request. The AI SDK runs a step's
tool calls with `Promise.all`, so the last `setRequestDimensions` won for every
row. Not AI-SDK-specific either: a JSON-RPC batch produces the same shape over
plain MCP.

The defect survived from the first commit because **every existing tool-audit
test calls `afterToolCall` directly**, bypassing the executor. Nothing had ever
exercised the context interaction on the tool path.

## Decision

`executeToolMethod` runs each call inside a fork of the ambient context.

**`trace` is copied verbatim.** The audit hook treats a context's trace as the
**parent** and derives the tool's span from it (`childSpan`). Minting a child at
fork time — the natural thing to write — would make every tool row point at a
`parentSpanId` no row ever carries, and no test would have caught it. The
consuming project stitches request → loop → tool by exactly this id and said
plainly that losing it would be worse than the bug.

**The fork wraps the whole call, `afterToolCall` included.** The audit row is
built there and reads the context at that moment; a fork around the handler alone
still reproduces the original bug.

**Each call gets its own `dimensions` and `error`, and inherits everything else**
— user, client info, timing, trace. A fork must not blank what the request
already knew.

**The forked context describes the call**: `source`, `path`, `serviceName` and
`action` are overwritten from the tool being run. The enclosing request says
`http` and `/mcp`, which is true of the request and misleading about the call.

The consequence to know: the forked context is then a **mixture** — it names the
call while still carrying the request's `trace` and `startedAt`, because both are
what the audit hook needs as the parent. So `getRequestContext()?.trace.spanId`
read from inside a tool handler is the *request's* span, not the call's, and a
duration computed from `ctx.startedAt` measures the request. Anyone hand-rolling
a row from inside a tool must take the span from `createAuditHook`'s event rather
than from the context. Minting the call's own span here instead would mean
teaching the audit hook not to re-child it — a bigger change, deliberately not
taken.

**No fork where there is no parent.** With no ambient context — stdio MCP,
`createCli`, an agent loop outside a request — there is no shared store, so
nothing can be corrupted. Inventing a root there would stamp every one of those
rows with a phantom `parentSpanId`, and a `--wait` CLI command would mint an
unrelated trace per poll tick. Giving those transports a real root context is a
separate, opt-in decision, and its home is the transport, not the executor.

## Consequences

- **A tool's writes no longer reach the enclosing HTTP row or its access-log
  line.** For a single-call request that is a real loss and not only a tidy-up:
  the entity genuinely was the request's. The value is not destroyed — it is on
  the tool row, and both rows carry the same `traceId`, so recovering it is one
  join. Say it that way; a reader who greps the request row will otherwise
  conclude the field vanished.
- **Sequential calls change too.** Dimensions used to *accumulate* through the
  shared store, so the second row carried the first call's keys. Now each row is
  what that call would have produced alone. "Unchanged for sequential calls" was
  never true — it only looked true when every call stamped the same key.
- **It removes a race, not only a swap.** Under the default stateful/SSE mode the
  HTTP response returns before the tools finish, so whether their writes reached
  the request row depended on stream timing. The request row is now
  deterministic.
- **The context is now a second per-call handle**, alongside the `ToolCallContext`
  object every mount already builds fresh per call and hands to both hooks
  (→ ADR 0042, where that object is the documented key for correlating
  `onToolError` with `afterToolCall`). Correlation was possible; it now has an
  ambient route as well as an explicit one.
- **Native tools still leak.** `mountWait`, `mountViewFile`, `mountUpload` and
  `mountDownload` register directly on the MCP server and never enter
  `executeToolMethod`, so a native tool's `setRequestDimensions` still writes
  outward. An asymmetry inside one mount,
  named here rather than discovered later.
- **Nesting depth is still not modelled.** A tool that calls another tool
  produces a sibling, not a child, because the fork copies the trace and the
  audit hook derives the child at emit time. Unchanged by this ADR; changing it
  means changing the fork and the audit hook together.

## What this does not fix

A **stateful** MCP session resolves its mount `context` once, at session
creation, and every later request's auth is computed and discarded. The tool
row's `userId` / `clientId` / `ipAddress` come from that object, so they describe
the session's opening request forever. That is the same "one store serving many
calls" shape one layer up, it is out of reach of this fork, and it deserves its
own task.
