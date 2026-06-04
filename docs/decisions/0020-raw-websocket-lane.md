---
title: "ADR 0020 — A raw WebSocket lane composed beside Socket.IO"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0020 — A raw WebSocket lane composed beside Socket.IO

- **Status:** Accepted — upholds [ADR 0008](0008-thin-wrappers.md), Bun-only per [ADR 0013](0013-runtime-agnostic-core.md)
- **Date:** 2026-06-05

## Context

stitchkit's realtime layer is Socket.IO (ADR 0008) — it carries binary fine, and
for most streams a binary event is enough. But a *truly* high-throughput binary
channel (video, large transfers) may want a raw WebSocket with no Socket.IO
framing, on the **same** port as the rest of the API.

On Bun this is awkward. `Bun.serve` exposes a **single** `websocket` handler, and
`@socket.io/bun-engine` (via `createSocketIOServer().websocket`) claims it. A
project that also wants a raw lane has to hand-compose that one handler:
discriminate each socket and route it to the engine or to its own handlers.

The fragile part is the discriminator. Routing *to* Socket.IO means asking "is
this an engine socket?", which forces inspecting the engine's **opaque**
`ws.data` (`{ transport }`) — a brittle guard, hard to keep cast-free. This was
the recurring pain when projects tried it by hand.

## Decision

Ship the composition as a small, typed, **cast-free primitive** in
`stitchkit/server`, and invert the discriminator so the engine's data is never
inspected.

- **`composeWebSocketHandlers(lanes, config?)`** builds one
  `WebSocketHandler<unknown>` from an ordered list of lanes. On each callback
  (`open`/`message`/`close`/`drain`/`ping`/`pong`) the **first** lane whose
  `match` claims the socket handles it; `config` carries the server-wide tuning.
- **`webSocketLane({ match, handlers })`** is the typed lane builder. `match` is a
  **type-predicate** that narrows `ServerWebSocket<unknown>` to the lane's data
  type, so the typed handlers are called without a single `as`. This is the one
  bridge from Bun's untyped single handler to per-lane typed handlers.
- **`socketIoLane(socket.websocket)`** wraps the engine handler as the
  **catch-all** lane (matched last). It claims every socket no raw lane matched —
  so the engine owns whatever a raw marker did not, and the opaque engine
  `ws.data` is never read.
- **Inversion is the key.** A raw lane stamps **its own** marker onto `ws.data`
  at upgrade and is matched positively; Socket.IO is the fallback. The brittle
  "is this an engine socket?" check disappears.
- **The upgrade stays a plain `RawRoute`.** The app's upgrade route calls
  `ctx.server.upgrade(req, { data })` with its marker and returns
  `new Response(null)` — symmetric with the ready-made `socket.route`. No new
  `createServer` config field.

## Alternatives considered

- **`rawWebSocket` field on `createServer`** (auto-register the upgrade route and
  compose internally). Rejected: it grows `createServer` beyond its thin
  `Bun.serve` wrapper and hides the upgrade. The composition primitive plus a
  normal `RawRoute` is enough and stays explicit.
- **Inspecting the engine `ws.data` to route to Socket.IO.** Rejected: brittle
  and cast-prone — the exact problem this ADR removes.

## Consequences

- **Not a competing engine (upholds ADR 0008).** stitchkit does not ship a
  WebSocket transport — the raw lane is the *app's own* `Bun.serve` WebSocket.
  The framework only composes the single handler, type-safely.
- **Cast-free.** No new `as`; the design was verified against `tsc`. The one
  allowed Socket.IO emitter cast (per `AGENTS.md`) is untouched.
- **Bun-only.** On Node, Socket.IO drives sockets through the `node:http.Server`
  `upgrade` event (`serveNode({ socket })`); a raw lane there is a separate
  upgrade handler, not this composition. Consistent with ADR 0013 (Bun-first
  server, Socket.IO engine Bun-only).
- **Tuning is server-wide.** `maxPayloadLength`/`idleTimeout`/… apply to every
  socket (Bun cannot scope them per-lane); set them to the most permissive lane.
