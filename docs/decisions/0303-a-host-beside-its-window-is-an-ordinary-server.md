---
title: "ADR 0303: A host beside its window is an ordinary server, and a call repeats only when the endpoint allows it"
description: A desktop app's host is a Stitchkit server on loopback with a guard for Host, Origin and a secret, using plain HTTP and the realtime socket; the typed client repeats a call that got no answer only for idempotent endpoints and unflagged GET/HEAD.
type: decision
status: accepted
created: 2026-11-22 08:44 +08:00
updated: 2026-11-22 08:44 +08:00
---

# ADR 0303 — A host beside its window is an ordinary server, and a call repeats only when the endpoint allows it

Serves **I5**, **I8**, **I9** and **I12**. Builds on [ADR 0008](0008-thin-wrappers.md), [ADR 0009](0009-hand-rolled-websocket.md), [ADR 0020](0020-raw-websocket-lane.md) and [ADR 0028](0028-revert-contract-dispatcher.md).

## Context

Offline-first desktop apps put a host process beside their window: it holds the local database,
the outbox and synchronisation, and the window calls it instead of the cloud. A consuming project
runs that window ↔ host link as a hand-written WebSocket protocol — a method map with
`replay: 'safe' | 'never'`, a server dispatcher, a client with its own reconnect, replay and retained
events, about 980 lines around the methods — and a second project was about to write the same.

The first plan was a new transport: frames over a WebSocket, a channel for each runtime. Validation
of that plan against this repository and against the consumer rejected it. Stitchkit does not ship a
competing WebSocket engine (ADR 0008, 0009); the raw lane belongs to the application (ADR 0020); a
contract dispatcher for exactly this webview ↔ sidecar link was built once and reverted because its
consumer did not adopt it (ADR 0028); push events with a last value already exist as
`defineEvents` → `toRealtimeContract` → the Socket.IO socket with `retain` (ADR 0150). What was
actually missing was smaller.

## Decision

The host is an ordinary Stitchkit server bound to loopback. Calls are plain HTTP through the typed
client; events travel the realtime socket with `retain` per topic. Two things are added.

**`createLocalHostGuard`.** Loopback keeps other machines out but not a page in a browser on the
same machine, which can call the port and open a WebSocket there (a WebSocket obeys no CORS), nor a
DNS-rebinding page that names the host by its own domain. The guard requires a loopback `Host`, an
allowed `Origin` when one is sent, and the host's secret as a Bearer token, compared in constant time
with its length folded into the result. It is one value with three faces — `onRequest` for every
route, `allowRequest` and `handshake` for the socket — so requests and events admit the same windows.
The constant-time comparison moved from the Telegram module to `internal`, one implementation for
both.

**A call that got no answer repeats only when the endpoint allows it.** A dropped connection leaves
the caller not knowing whether the call ran. `EndpointDef.idempotent` was declared for a retrying
transport to read and no client read it. Now both client paths read it from the endpoint they
already hold, with no second router: `idempotent: true` repeats whatever the method, an unflagged
`GET`/`HEAD` repeats, `idempotent: false` and an unflagged write never repeat. A response of any
status is an answer and is never repeated. On Bun the Ky transport now recognises a connection closed
after the request left (`ECONNRESET`), which it never did, so the promised retry of a `GET` did not
happen when a host restarted mid-call.

## Consequences

- The consumer's ~980 lines of transport become the existing server, client and socket; each method
  stays about the size of an endpoint. The consumer lane carries a fixture with three of its methods
  behind the guard, through a front that drops connections as a restarting host does.
- A host inside a React Native process cannot use this: `createHandler` needs Node built-ins. That is
  a separate piece of work, not a reason to grow a second transport here.
- Discovering where the host listens and handing the window its secret stay with the app's shell.
- A local CLI or agent channel on the same machine does not add a second host abstraction or RPC protocol: the host mounts a second `createServer({ unix: { path, mode: 0o600 } })` sharing the same `services` array (or a narrowed subset) beside the guarded loopback TCP server, with owner identity on the socket listener and composite shutdown through `bindProcessSignals`.
- A write that is safe twice should say `idempotent: true`; one that says nothing fails on a dropped
  connection with its outcome unknown, as it always did.
