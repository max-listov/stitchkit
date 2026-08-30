---
title: Bound shutdown of non-cooperative WebSocket peers
description: Prevent an idle WebSocket that does not complete the close handshake from consuming the entire application grace period.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
priority: high
---

# Bound non-cooperative WebSocket shutdown

## Problem

The Bun server lifecycle enters `closing-realtime`, sends close frames and waits
for `openSockets` to reach zero. A peer that does not complete the close
handshake keeps `closeRealtime()` pending until the outer application grace
deadline. The application then enters force, terminates the socket and reports a
forced/incomplete shutdown even when there are no pending application requests.

This couples a persistent connection handshake to unrelated long application
grace periods such as durable-work drains. A supervisor restart or structural
reconciliation can therefore remain unavailable for the full application grace
budget solely because one idle realtime peer stays connected.

## Required contract

- [x] Give realtime close handshakes an explicit bounded lifecycle inside the
      server shutdown contract; do not reuse the entire application grace period
      as the implicit WebSocket close timeout.
- [x] After the bounded handshake interval, terminate only the remaining sockets
      and continue runtime shutdown without waiting for the outer grace deadline.
- [x] Preserve the existing grace budget for admitted HTTP/application work and
      keep external abort plus force deadlines authoritative.
- [x] Report cooperative closes, bounded terminations, pending sockets and final
      outcome truthfully; an intentionally bounded realtime termination must not
      masquerade as an unrelated application deadline failure.
- [x] Keep Bun and Node adapters aligned wherever both expose managed WebSocket
      shutdown.

## Regression proof

- [x] A real or faithful non-cooperative WebSocket peer ignores the close
      handshake while the outer application grace is deliberately long; shutdown
      completes near the realtime bound, not near the outer deadline.
- [x] A cooperative peer closes cleanly without termination.
- [x] Pending HTTP work still receives its declared grace and is not shortened by
      the realtime bound.
- [x] External abort and exhausted force budget remain bounded and accurately
      reported.
- [x] `managedServerResource` inside `createApplication` no longer returns
      `forced`/`cleanupComplete=false` solely because an idle socket ignored the
      close handshake.
- [x] Source tests, packed Bun/Node consumer tests, docs and changelog are green.
- [x] Publish a patch release with exact SHA, package version and CI evidence.

## Implementation evidence

- `packages/core/src/server/shutdown.ts` owns `realtimeCloseTimeoutMs`, the bounded handshake race,
  selective termination and truthful counters without changing the outer force state machine.
- `packages/core/src/server/bun.ts` terminates only tracked WebSockets; `server/node.ts` terminates
  only upgraded transport sockets. Both wait for physical close before continuing.
- `packages/core/tests/server-shutdown-lifecycle.test.ts` covers faithful non-cooperation,
  cooperative close and outer-deadline authority. `packages/core/tests/node.test.ts` drives a real
  upgraded Node socket whose lifecycle never settles `close()`. Existing Bun Socket.IO/raw close
  tests remain the cooperative adapter proof.
- `packages/core/tests/application-server-resource-start.test.ts` proves a bounded realtime
  termination remains a clean, complete application shutdown and that the resource policy reaches
  the managed server.
- Exact-SHA CI run `33310530601` completed successfully across the framework, Node, packed
  consumer, supervised and starter lanes before the release gate.
- Published as `stitchkit@0.70.1` from
  `c9a86d4962178debc017a821d7034aed18bd91da`; exact-SHA CI `33311317355` and release workflow
  `33311583783` are green. npm integrity is
  `sha512-UySE/DO1p7XZDmbISX3+U9RCYpepqsElovnL4IgUu0C9BpsFXGbYpoF0nL38vpY8SLV2frLiZXyy05gmmyrhrg==`.
