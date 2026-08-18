---
title: "ADR 0079: Typed handshake identity gate"
description: The Socket.IO handshake gets a Zod-first identity gate whose result lands typed in socket.data, and the client surfaces terminal handshake rejections with an explicit recovery path.
type: decision
status: accepted
created: 2026-08-18
updated: 2026-08-18
---

# ADR 0079 — Typed handshake identity gate

## Context

The realtime contract types every event but not the identity of the peer that
sends them. The guide's answer was "write `socket.io.use()` yourself", which
left `socket.data` untyped — a real consumer accumulated `String(raw.data.x)`
coercions across its codebase. For a framework whose thesis is "types flow
from one declaration", the connection identity was the visible seam.

Two probed Socket.IO facts shaped the design:

1. **An `io.use` middleware rejection is terminal for the client.** Unlike an
   engine-level (`allowRequest`) denial, which socket.io-client retries
   forever, a middleware rejection destroys the client's retry path
   (`socket.active === false`). Our wrapper did not even listen to
   `connect_error`, so a rejected client hung silently and a later `connect()`
   was swallowed by the idempotence guard.
2. **socket.io does not catch a rejected promise from an async middleware** —
   it leaks as an `unhandledRejection` (a process crash under Node defaults)
   and the handshake hangs until the client timeout.

## Decision

- `createSocketIOServer({ handshake: { schema, verify? } })`: `schema`
  Zod-validates `socket.handshake.auth` (the structured channel — `query` is
  strings on the wire); `verify` (sync or async) turns the parsed payload into
  the identity, rejecting via `throw` or `null`. Without `verify` the schema
  output is the identity. The result is assigned to `socket.data` and the type
  flows `SocketIOServerConfig<TParsed, TData>` →
  `SocketIOServerHandle<…, TData>` → `RealtimeServerHandle<TData>` →
  `RealtimeServerConnection.raw.data` — cast-free, with one documented
  loose→typed bridge for the no-`verify` fallback in the Socket.IO adapter.
- The gate registers as the **first** middleware, before the runtime branch —
  Bun and Node share it, and app `io.use` middlewares see typed data.
- `verify` always runs inside a settled promise chain routing every outcome
  through `next(...)` — a raw async middleware is never handed to socket.io
  (fact 2). Rejections carry `err.data = { code: 'handshake_rejected' }`, and
  a thrown error's raw message never crosses to the unauthenticated peer
  (same policy as the HTTP error normalizer) — the wire sees the generic
  `handshake rejected`, the real error is logged server-side.
- The client config gains `onConnectError({ message, data, terminal })`.
  `terminal: true` (`!socket.active`) additionally resets the connection
  intent, so an explicit `connect()` starts fresh and re-reads a function-form
  `auth` — the recovery path after rotating a rejected token (fact 1).
- Engine-level `allowRequest` stays the transport gate; `handshake` is the
  identity gate. Two gates, two layers, documented as such.

## Consequences

- Identity is typed end-to-end on the `bindRealtimeServer` lane with zero
  annotations. TypeScript has no partial type-argument inference, so call
  sites with explicit event generics must pass the identity types explicitly
  (`createSocketIOServer<S, C, Parsed, Data>`) — documented limitation.
- All new generics default (`TData = any`) — existing annotations compile
  unchanged; the feature is additive.
- The guide's previous claim that a rejected handshake "keeps retrying" was
  wrong for the middleware path and is corrected; the empty-auth fallback now
  documents that a server-gate rejection is terminal and visible, not retried.
