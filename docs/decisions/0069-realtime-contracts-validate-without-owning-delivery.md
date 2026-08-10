---
title: "ADR 0069 — Realtime contracts validate without owning delivery"
description: Keep realtime as a separate Zod contract over Socket.IO with asymmetric, owner-aware rejection semantics.
type: decision
status: accepted
created: 2026-08-10
updated: 2026-08-10
---

# ADR 0069 — Realtime contracts validate without owning delivery

- **Status:** Accepted — extends [ADR 0008](0008-thin-wrappers.md); the raw
  binary lane in [ADR 0020](0020-raw-websocket-lane.md) remains orthogonal.
- **Date:** 2026-08-10

## Context

HTTP operations and Socket.IO events have different identities. HTTP has method,
path, scope and exposure; realtime has two directional registries, variadic tuple
arguments and acknowledgements travelling against the event direction. Folding
both into `defineContract` would either weaken those distinctions or turn the
HTTP contract into a transport union.

Runtime validation also has two owners. An inbound peer payload is untrusted and
must be dropped without crashing the listener. An invalid outbound payload is a
local programming error and must fail at the call site. Rooms add an emit-only
target, while connected sockets support both subscription and emission.

## Decision

Realtime uses the separate `defineRealtimeContract` primitive. It derives both
event maps from Zod tuple schemas and validates inbound arguments, outbound
arguments and acknowledgement values. The registry is closed at runtime:
unknown event names are contract violations, not best-effort emissions.

Inbound rejection is reported through `onRejected` and the message is dropped.
Outbound rejection throws `REALTIME_CONTRACT_VIOLATION` because the application
owns that defect. A bad local acknowledgement is reported and dropped rather
than thrown into a peer-controlled listener frame. Every rejection names event,
direction, phase and local/peer fault; hook failures cannot break transport.

Targets are capability-based. Server and connected-socket targets may subscribe
and emit; room/broadcast targets are valid emit-only targets and resolve `on`
only when subscription is actually requested. The server exposes the raw socket
for Socket.IO-owned policy such as auth and room membership; the browser client
keeps its durable subscription abstraction and does not expose a competing raw
transport.

The contract layer validates delivery calls but does not own presence,
guaranteed delivery, replay, RPC, room authorization or transport selection.

## Alternatives rejected

- Put events inside `defineContract`: HTTP-only fields become meaningless and
  tuple/ack semantics become an awkward special case.
- Replace Socket.IO: duplicates reconnection, heartbeat and delivery machinery
  forbidden by ADR 0008.
- Throw for malformed inbound peer data: one hostile packet can crash an
  application listener.
- Silently drop invalid outbound data: hides a local programming error at its
  cheapest diagnostic boundary.
- Require subscription capability from every target: room broadcast operators
  are emit-only and fail during construction despite supporting the requested
  operation.
- Expose a raw browser socket: bypasses validated durable subscriptions and
  creates two client APIs for the same connection.

## Consequences

- Shared Zod schemas are the single source of event and acknowledgement types.
- All supported target capabilities require direct runtime tests.
- Applications retain Socket.IO policy and lifecycle ownership.
- Rejection telemetry is structured and deterministic without turning peer
  input into process failure.
