---
title: "ADR 0074 — Server-owned managed shutdown"
description: Make admission, HTTP drain, realtime closure and runtime stop one bounded Bun/Node lifecycle.
type: decision
status: accepted
created: 2026-08-14
updated: 2026-08-14
---

# ADR 0074 — Server-owned managed shutdown

- **Status:** Accepted — extends [ADR 0008](0008-thin-wrappers.md),
  [ADR 0013](0013-runtime-agnostic-core.md) and
  [ADR 0020](0020-raw-websocket-lane.md).
- **Date:** 2026-08-14

## Context

Stitchkit created HTTP and Socket.IO transports but returned unrelated runtime
handles. Applications guessed an order between `server.stop()`/`close()` and
`socket.io.close()`. On Bun, bun-engine starts a WebSocket close handshake but
has no completion Promise; graceful `Bun.Server.stop(false)` can therefore wait
past the supervisor deadline. On Node, Socket.IO itself closes its attached
`http.Server`, while srvx had its own signal/close lifecycle. Two close owners
could race, and upgraded sockets survive `closeAllConnections()`.

A Fetch wrapper alone is not a complete lifecycle boundary. Bun native `routes`
run before `fetch`; Node Engine.IO polling and upgrades are attached directly to
the HTTP server. Handler completion also does not prove that a streaming response
has physically finished.

## Decision

`createServer()` and `serveNode()` return one
`ManagedServerHandle<TRuntime>`: `{ url, port, runtime, status, shutdown() }`.
The first `shutdown()` closes admission and fixes one monotonic grace budget plus
an optional caller `AbortSignal`. Later calls return the same Promise object and
cannot replace its options.

The state chain is `running → draining-http → closing-realtime →
stopping-runtime → clean | forced`:

1. ordinary HTTP admitted after the boundary receives `503`, `Retry-After` and
   `Connection: close` outside application `wrapFetch`;
2. accepted application work drains;
3. Socket.IO transport stays outside application counters, stops new handshakes
   through its composed policy, then closes namespaces, adapters and clients;
4. Bun starts a normal close for every tracked WebSocket and waits for the
   server-side `close` callback; only the forced path calls `terminate()`. Node
   uses Socket.IO as the sole graceful close owner when attached;
5. the runtime stops. At deadline or external abort, Bun forces runtime stop;
   Node destroys every tracked TCP socket, including upgraded WebSockets.

`acceptedRequests` and `completedRequests` describe application admission.
Transport pending counts describe physical state. A forced result preserves
`pending*AtForce` and aborted counters while final pending counts describe the
post-close state.

Socket.IO is passed as the full `socket` handle. Bun mounts its route and default
WebSocket handler automatically. A custom composed handler remains explicit and
must include `socketIoLane`; the managed server observes every lane's open/close
and owns shutdown. Node keeps a Bun-free structural socket lifecycle.

Bun native `routes` are removed from managed config because they bypass the
admission boundary; use `rawRoutes`. srvx is imported from `srvx/node` and runs
with `gracefulShutdown: false`, so core never registers process signals. Apps
wire signals explicitly and close non-server resources after server drain.

## Alternatives rejected

- A standalone `shutdown(server, socket)` helper: preserves split ownership and
  lets callsites keep the wrong order.
- `stop(true)` immediately on every signal: aborts accepted HTTP work and cannot
  report whether the shutdown was clean.
- Parallel `io.close()` and srvx close on Node: both own the same listener.
- Gating only Fetch: misses Bun native routes and Engine.IO's attached lanes.
- Framework-owned Prisma/MCP/queue orchestration: those resources are outside
  the HTTP/realtime transport boundary.

## Consequences

- The server return shapes and Bun native `routes` config are breaking changes.
- Bun and Node share semantics and result schemas but retain typed runtime escape
  hatches.
- Raw Bun WebSocket lanes remain the application's protocol, but their physical
  sockets participate in the managed lifecycle. Bun 1.3.14 reports server-side
  physical completion immediately after `ServerWebSocket.close()`, even when a
  raw peer never reads or acknowledges the close frame; that proven runtime
  boundary is clean, while any socket still tracked at the shared deadline is
  terminated and retained in the forced snapshot.
- Signal policy stays explicit in the application; the framework owns no global
  process listeners.
