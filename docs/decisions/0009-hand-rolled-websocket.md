---
title: "ADR 0009 — A hand-rolled WebSocket transport"
type: decision
status: superseded
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0009 — A hand-rolled WebSocket transport

- **Status:** Superseded by [0008](0008-thin-wrappers.md)
- **Date:** 2025-05 (decided), 2026-05-20 (reverted)

## Context

stitchkit originally planned to own its real-time layer: a WebSocket transport
built directly on `Bun.serve()`'s native WebSocket, with no Socket.IO.

The rationale at the time:

- Zero dependencies — consistent with ADR 0001.
- Bun's native WebSocket (uWebSockets underneath) is faster than Socket.IO.
- Socket.IO's main job is a polling fallback, assumed unnecessary in 2026.
- Rooms are about 30 lines to implement.

## Decision (original)

Build a native WebSocket stack: `defineEvents` for a typed event registry,
`createWebSocketHandlers` for the server, `createSocketClient` for the client,
an entity emitter, a `useSocketEvent` React hook, and cookie-based handshake
auth via an `onAuth` callback.

## Why it was reverted

Every project consuming stitchkit already runs on Socket.IO — for the polling
fallback, the heartbeat, acknowledgements and a mature reconnection client that
a hand-rolled transport would have to re-earn. The native stack was never wired
into a single consumer. It was about 700 lines of dead code.

ADR 0008 replaced it with thin Socket.IO wrappers (`createSocketIOClient` /
`createSocketIOServer`). The entire native stack was deleted.

## Consequences

- A real transport was built, shipped, and never adopted — a cost paid in full.
- The lesson, recorded in ADR 0008: do not build a transport the consumers will
  not use. Wrap the one they already run on.
