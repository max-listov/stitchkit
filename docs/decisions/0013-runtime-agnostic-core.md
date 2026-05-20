---
title: "ADR 0013 — Runtime-agnostic core, Bun as first-class adapter"
type: decision
status: accepted
created: 2026-05-20
updated: 2026-05-20
---

# ADR 0013 — Runtime-agnostic core, Bun as first-class adapter

- **Status:** Accepted — supersedes the Bun-only clause of ADR 0011
- **Date:** 2026-05-20

## Context

stitchkit's wedge is **MCP/agent tools from one contract** (ADR 0007). The
audience for that feature is predominantly on Node. ADR 0011 declared the
framework Bun-only — a clean constraint, but one that closes the door on the
primary market for the framework's strongest feature.

An audit of the codebase (C1–C11 inventory) showed that the core —
`/contract`, `/tools`, `/react`, `/observability`, and `createHandler` from
`/server` — is already runtime-agnostic in practice. The Bun coupling is
confined to `createServer` (`Bun.serve`), `staticRoute` (`Bun.file`),
`createSocketIOServer` (`@socket.io/bun-engine`), and a handful of type
aliases that leak `Bun` into `ServerConfig`.

The cost of opening is near-zero; the cost of staying closed is losing the
Node audience entirely.

## Decision

**The core is Web Fetch-clean.** `createHandler` accepts `HandlerConfig` — a
runtime-neutral type with no Bun globals or Bun types. The handler is a pure
`(req: Request) => Promise<Response>` — the portability seam.

**`createServer` stays Bun-first.** It accepts `BunServerConfig` (extends
`HandlerConfig` with Bun-specific fields: `routes`, `websocket`,
`development`, `bun`). No change in behaviour for Bun users.

**`serveNode` is the Node adapter.** A new subpath `stitchkit/node` exports
`serveNode(config)` — a thin wrapper over `srvx` (the unjs/h3 micro-adapter)
that bridges `node:http` to the Fetch handler. `srvx` is an optional peer
dependency.

**`srvx` over hand-roll.** Consistent with ADR 0008 (wrap what the ecosystem
solved) and the lesson of ADR 0009 (a hand-rolled transport is 700 lines of
dead code). The `node:http ↔ Request/Response` bridge has non-trivial edge
cases — `set-cookie` splitting, streaming backpressure, `AbortSignal`, the
`req.url` relative-path bug (C8) — that `srvx` already handles. A hand-rolled
bridge would be ~80–120 lines of infrastructure code with no business value.

**One package, subpath exports.** The "one package" clause of ADR 0011 stays.
`stitchkit/node` is a subpath, not a separate `@stitchkit/node` package.
Tree-shaking is handled by the `exports` map.

**Node floor: 22.** `ky@2` declares `engines.node: ">=22"`. stitchkit inherits
this constraint. `engines` in `package.json` declares both
`bun: ">=1.2.0"` and `node: ">=22"`.

**`new URL(req.url)` fallback.** `createHandler` now passes a base
(`http://localhost`) to `new URL` — Bun/Deno give an absolute URL, but
Node adapters may pass just the pathname.

## What this does NOT change

- `createServer` stays `Bun.serve()`. No runtime-detect magic.
- `staticRoute` stays Bun-only (`Bun.file`). Document as Bun-only.
- `createSocketIOServer` stays Bun-only (`@socket.io/bun-engine`). The
  Node Socket.IO engine adapter is a separate future task (P3).
- Test suite stays `bun:test`. Node CI runs a smoke test, not a full port.

## Consequences

- Node users can use `stitchkit/node` + `stitchkit/tools` + `stitchkit/contract`
  with zero Bun dependency.
- Bun users see no change — `createServer` is the same API.
- The type split (`HandlerConfig` vs `BunServerConfig`) makes the portability
  boundary explicit in the type system.
- `srvx` is a new optional peer dependency — only needed by Node consumers.
- Deno/workerd support opens for free through `srvx` if ever needed, but is
  not in scope today.
