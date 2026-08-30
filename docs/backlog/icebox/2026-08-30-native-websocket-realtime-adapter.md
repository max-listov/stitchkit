---
title: Add an optional typed native WebSocket adapter for browsers and Bun
description: Preserve the native WebSocket engine proposal and the measured evidence required to reconsider it.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
pipeline: live-state-synchronization
order: 91
depends-on: —
defrost: Two maintained consumers already repeat compatible framing, lifecycle, retry, auth and version-migration requirements, or measurements prove Socket.IO and the raw owned lane cannot satisfy a required supported use case.
---

## Зачем

Applications already using native browser WebSocket and Bun.serve otherwise hand-write event
framing, validation, reconnect cleanup and safe server dispatch. The existing raw lane
composer handles routing of callbacks, not a complete typed client/server protocol.
Socket.IO already runs on Bun; this proposal is about protocol choice, not runtime support.

Intake only. Implementation depends on approval of
[the contract/capability decision](2026-08-30-realtime-contract-capability-boundary.md).

## Current review disposition

Frozen. The proposal owns framing, wire versioning, heartbeat, reconnect, backpressure, browser
and Bun lifecycle, authentication hooks and long-term compatibility. That is a second realtime
engine, not a thin adapter, and current evidence contains no reproduced limitation or measurement
that justifies changing ADR 0008/0069. Applications can already compose an application-owned raw
WebSocket lane through ADR 0020 when they deliberately own a custom protocol.

The complete original design remains below so the work can be reconsidered without reconstructing
it. Defrost requires repeated compatible consumer demand or a measured blocker, not preference for
a smaller-looking protocol.

## Результат

An optional browser client and Bun server adapter apply the accepted realtime contract to a
small documented native WebSocket protocol. Server upgrades compose through the existing
raw route/lane and managed shutdown mechanisms. Existing Socket.IO remains supported.

A matching client/server pair is required. Existing arbitrary JSON or binary protocols and
Socket.IO peers do not become wire-compatible merely by sharing TypeScript event types.

## План

- [ ] Specify versioned framing, event identity/direction, schema validation, payload limits,
      unsupported-version rejection and supported text/binary scope.
- [ ] Reuse accepted common contract validation instead of copying Socket.IO wrapper internals.
- [ ] Specify idle, connecting, open, retrying, closing and closed states; explicit close/abort
      cancels retries and listeners, while stale connection callbacks cannot affect a new one.
- [ ] Give the native adapter one bounded reconnect/heartbeat owner; add no outer retry engine
      to the Socket.IO path. Authentication refusal and protocol mismatch must not retry forever.
- [ ] Provide host-owned auth/origin/admission hooks with generic peer errors and internal
      diagnostics. Do not require credentials in URLs or invent application authorization policy.
- [ ] Normalize native send and close outcomes, including Bun backpressure/drop distinctions;
      hand queue policy to the bounded-delivery task.
- [ ] Compose existing raw lanes and Socket.IO on one server without inspecting opaque engine data.
- [ ] Integrate bounded server shutdown and client dispose; do not stop a caller-owned server.
- [ ] Provide an explicit migration recipe for an application-owned event envelope; do not
      silently auto-detect legacy protocols or promise adapter-only migration.

## Acceptance

- [ ] A real browser client exchanges contract-validated events with Bun in both directions.
- [ ] Malformed/unknown/oversized frames cannot invoke a protected handler or crash the listener;
      invalid local outbound values fail at the call site.
- [ ] Disconnect, reconnect, repeated start/stop, timeout and explicit dispose release owned
      timers/listeners; no duplicate event after reconnect.
- [ ] Auth/protocol failures are distinct from transient disconnect and expose no secrets.
- [ ] Native and Socket.IO lanes coexist and shut down within configured bounds.
- [ ] Tests exercise wire-version mismatch, slow consumer, server restart and browser-safe
      packed imports. Supported runtimes are documented without implying untested Node parity.
- [ ] Latency or bundle-size claims, if made, are backed by comparable measurements; no claim
      about application loading speed is inferred from protocol choice alone.

## References

- Existing composition: `packages/core/src/server/websocket.ts`.
- [Bun WebSocket send/backpressure](https://bun.sh/docs/runtime/http/websockets).
- [Socket.IO protocol distinction](https://socket.io/docs/v4/).
