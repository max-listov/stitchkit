---
title: createSocketIOServer — pass through socket.io ServerOptions (maxHttpBufferSize, …)
description: SocketIOServerConfig exposes only cors/path/transports/ping*. A consumer migrating off a hand-built Socket.IO server had to DROP maxHttpBufferSize (5MB, for large preview payloads) — the wrapper doesn't forward it, so large emits now silently truncate. Forward the remaining socket.io server options.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0008-thin-wrappers.md
---

# createSocketIOServer ServerOptions passthrough

**Type: DO (code, thin).** Surfaced migrating a consumer's Socket.IO server to
`createSocketIOServer`. A real behavioural regression, not cosmetics.

## Problem

`SocketIOServerConfig` forwards only `cors`, `path`, `transports`, `pingTimeout`,
`pingInterval`. The consumer's hand-built server set
`maxHttpBufferSize: 5 * 1024 * 1024` (preview HTML bundles exceed the 1MB
default). The wrapper has no way to pass it, so on migration the option was
**dropped** — large emits now hit the 1MB default and silently fail. The wrapper
is "thin over Socket.IO" (ADR 0008), but thin shouldn't mean *lossy*: a
first-class Socket.IO option became unreachable.

## Proposal

Forward the rest of socket.io's `ServerOptions` — either explicitly for the
common ones, or via a passthrough:

```ts
createSocketIOServer({
  cors,
  maxHttpBufferSize: 5 * 1024 * 1024,
  connectionStateRecovery: { /* … */ },
  // or: serverOptions: Partial<ServerOptions>  — a typed passthrough
})
```

Mirrors how `createServer` already exposes a `bun` passthrough for `Bun.serve`
options — the wrapper owns the integration, the consumer keeps access to the
underlying knobs.

## Scope — generic only

- ✅ Take: forward `maxHttpBufferSize` + the remaining `ServerOptions`
  (`connectionStateRecovery`, `perMessageDeflate`, `maxHttpBufferSize`,
  `connectTimeout`, …) — typed from socket.io's own `ServerOptions`.
- ✂️ Leave out: nothing domain here; it's pure transport tuning.

## Acceptance

- [x] `maxHttpBufferSize` (and the other `ServerOptions`) reachable through
      `createSocketIOServer` config; default behaviour unchanged when omitted —
      `serverOptions?: Partial<ServerOptions>` passthrough, wrapper-owned fields win.
- [x] Test: a value over 1MB is accepted when configured — `socket-io.test.ts`
      asserts `websocket.maxPayloadLength` (the engine's `maxHttpBufferSize`).
      `realtime.md` note + reference. No `as` casts.
- [x] `bun run verify` green — 414 tests.

## Что сделано (2026-06-05)

- [x] **`SocketIOServerConfig.serverOptions`** (`server/socket-io.ts`) — typed
  `Partial<ServerOptions>` passthrough; spread first, wrapper-owned `cors`/`path`/
  `transports`/`ping*` override.
- [x] **Root cause on Bun fixed** — the hand-built `@socket.io/bun-engine` got only
  `{ path }`, so engine-level opts (`maxHttpBufferSize`, ping heartbeat,
  `upgradeTimeout`) were dropped → >1 MB emits truncated. Now forwarded to
  `new Engine(...)` (only defined keys, to not clobber the engine's `Object.assign`
  defaults); `cors`/`ping*` forwarded too for correct cross-origin handshake + heartbeat.
- [x] **Test** — `tests/socket-io.test.ts`: configured 5 MB → `websocket.maxPayloadLength`
  is 5 MB; default → 1 MB.
- [x] **Docs** — `guide/realtime.md` + `CHANGELOG`. No new ADR (thin-wrapper passthrough, ADR 0008 upheld).

Ships in the **0.6.0** batch.
