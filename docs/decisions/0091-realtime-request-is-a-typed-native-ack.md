---
title: Realtime request is a typed native acknowledgement
description: Promise request-response stays a thin validated wrapper over Socket.IO acknowledgements with explicit timeout and disconnect errors.
type: decision
status: active
created: 2026-08-20
updated: 2026-08-20
---

# 0091 — Realtime request is a typed native acknowledgement

## Context and evidence

The realtime contract already models and validates acknowledgement callbacks.
Consumers still had to build the Promise lifecycle themselves: native timeout,
disconnect, exactly-once settlement and invalid-ack rejection.

Socket.IO's official emitting guide documents both Promise acknowledgements and
`socket.timeout(ms).emitWithAck(...)`:
<https://socket.io/docs/v4/emitting-events/#acknowledgements>. Promise acks are
registered as error-aware callbacks. Since socket.io-client 4.7.5, its official
client source clears sent pending acknowledgements on disconnection and rejects
them; packets still in the send buffer are deliberately excluded:
<https://github.com/socketio/socket.io-client/commit/34cbfbb532ae333f4dd034138e8f87cb80a8e382>.

Relying on the vendor error message to distinguish those states would be
unstable. Allowing a call while disconnected would also enter Socket.IO's send
buffer, contradicting Stitchkit's established honest-emit semantics.

## Decision

- `RealtimeClient.request(event, ...args, { timeoutMs })` exists only for
  contract events with an `ack` schema. Inputs use the event args schema; the
  Promise output uses the ack schema.
- The low-level client delegates to native `timeout().emitWithAck()`; Stitchkit
  does not create an acknowledgement protocol or another WebSocket engine.
- A call made while disconnected rejects before emit. An in-flight disconnect
  is observed explicitly and rejects with `RealtimeRequestDisconnectedError`;
  a native rejection while the same socket is still connected is a
  `RealtimeRequestTimeoutError`. Wrapper-owned pending callbacks are also
  rejected before an explicit `disconnect()` removes Socket.IO listeners.
- Every path removes its disconnect listener and settles once. Late native
  resolution/rejection is ignored by that settlement gate.
- Ack schema failure uses the existing `acknowledgement` rejection phase and
  `onRejected`, then rejects the Promise with
  `RealtimeRequestInvalidAcknowledgementError`.
- The server callback surface remains unchanged. Long-running jobs, resumable
  work and streams remain application-correlated events or async operations.

## Consequences

Callers can branch by stable framework class/code rather than vendor text.
Immediate disconnect rejection means no request is buffered for a future
reconnect. This intentionally provides bounded request-response, not delivery
durability or RPC semantics.
