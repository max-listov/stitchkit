---
title: "ADR 0092: Realtime contracts may bind an existing transport"
description: Validation and typed acknowledgements can wrap an application-owned Socket.IO transport without taking lifecycle ownership.
type: decision
status: accepted
created: 2026-08-21
updated: 2026-08-21
---

# ADR 0092 — Realtime contracts may bind an existing transport

## Context

Applications may already own one Socket.IO client for authentication,
reconnection and durable subscriptions. `createRealtimeClient` previously made
adopting Stitchkit validation require a second connection or a wholesale
lifecycle migration.

## Decision

`bindRealtimeClient(contract, transport)` accepts the smallest structural
transport used by the canonical validated client: connection state, event
subscription, emit, Promise acknowledgement and connection-change observation.
It returns `BoundRealtimeClient`, which exposes validated event and request
operations but no `connect` or `disconnect` methods.

`createRealtimeClient` constructs the official Socket.IO adapter, delegates all
validation and request behavior to the same binder, then adds lifecycle methods
because it owns that transport. Binding validates required capabilities
immediately. It neither imports Socket.IO eagerly nor creates, connects or
closes a socket.

## Consequences

- Existing subscriptions and reconnect policy remain application-owned.
- Created and bound clients cannot drift in payload, acknowledgement, timeout
  or disconnect semantics.
- Lifecycle ownership is visible in the return type rather than documentation
  alone.

