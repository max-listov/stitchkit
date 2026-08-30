---
title: Bind realtime request phases to the invoking caller without temporal inference
description: Provide supported per-request correlation for metadata-only diagnostics while retaining framework-owned native ACK identity.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 09:25 +0000
---

## Why

Published 0.68.11 exposes a client-wide `onRequestPhase`. Its event contains only framework-owned
requestId, event name, phase and elapsedMs; `request()` takes timeoutMs and returns only the typed
ACK promise. The application cannot associate an opaque diagnostic identity with its own request
context through the public API. Matching handoff order or inspecting native Socket.IO fields is
not a reliable composition contract, especially under concurrency, reentrancy and disconnection.

## Reproduction

Against the published package, a real Socket.IO server receives two concurrent `inspect({key})`
requests, replies second-first with identical `{ok:true}` bodies. Observations correctly retain
two distinct IDs and reverse ACK order. Every observation has exactly
`elapsedMs,event,phase,requestId`; neither caller key appears and neither returned Promise exposes
a request identity. Both requests complete successfully: this is a missing composition seam,
not broken ACK routing. Public request options contain only `timeoutMs`.

The missing guarantee must be fixed at the public API, not by prescribing an ambient mutable
current-request variable, ordering assumption, payload echo or transport-wrapper workaround.

## Result

A supported request-scoped observer or bounded caller correlation handle joins diagnostic phases
to a particular invocation. Keep the native requestId framework-owned; caller correlation must
not alter wire IDs, be transmitted to the peer or retain arbitrary payloads.

## Plan

- [x] Verify the latest released API and reproduction; no existing public seam associates an
      invocation with the framework-owned request identity.
- [x] Add a request-scoped `RealtimeRequestOptions.onPhase` hook. The caller keeps correlation in
      its closure; Stitchkit neither accepts nor stores a caller key. The client-wide hook receives
      all phases, the request hook receives only its invocation, and one function used for both is
      invoked once.
- [x] Retain engine handoff, decoder ACK receipt, settlement, timeout and disconnect distinctions.
      Request-scoped observation must work without an unrelated client-wide dummy observer.
- [x] Preserve no-hook allocation/listener behavior and observer exception/rejection isolation.
- [x] Prove concurrent same-event requests with identical ACK values, reordering, reentrant calls,
      disconnected-before-send, invalid ACK, timeout and late ACK; no stale association after cleanup.
- [x] Prove no payload/auth bytes or correlation data are added to outgoing frames. Document that
      decoder receipt is not physical network receive/RTT or remote transaction durability.
- [x] Prepare the exact `0.69.0` API/docs/types and execute the packed Node/Bun consumer proof;
      publication belongs to the repository release conveyor rather than this task lifecycle.

## Acceptance

- [x] Each caller invocation can identify all its own reported phases without native internals,
      temporal matching, payload parsing or mutating application request IDs.
- [x] Correlation is bounded and released on terminal paths; observation cannot change request truth.
- [x] Existing non-observing request semantics, timeout behavior and supported compositions remain intact.
- [x] The exact `0.69.0` candidate, generated public reference and executable packed recipe are ready
      for the repository release conveyor.

## Что сделано

- [x] Public contract: [`packages/core/src/realtime/request.ts`](../../../packages/core/src/realtime/request.ts)
      exposes invocation-scoped `RealtimeRequestOptions.onPhase`; the caller correlation remains in
      the observer closure and never enters the event or wire.
- [x] Runtime: [`packages/core/src/browser/socket-io.ts`](../../../packages/core/src/browser/socket-io.ts)
      composes global and request observers without duplicate calls, installs Engine.IO listeners
      lazily and releases native correlation on every terminal path.
- [x] Regression coverage: [`packages/core/tests/socket-io.test.ts`](../../../packages/core/tests/socket-io.test.ts)
      cases `request-scoped phase hooks correlate reordered identical acknowledgements locally` and
      `request-scoped hooks survive reentrancy and close every terminal path once` cover reordered
      identical ACKs, reentrancy, disconnected-before-send, invalid ACK, timeout and late ACK.
- [x] Packed proof: [`packages/core/scripts/consumer-lane/self-contained-socket-client.mjs`](../../../packages/core/scripts/consumer-lane/self-contained-socket-client.mjs)
      executes the request-scoped public API from isolated Node and Bun bundles; `bun run consumer-lane`
      completed successfully.
- [x] Documentation: [`docs/guide/realtime.md`](../../guide/realtime.md),
      [`docs/api/reference.md`](../../api/reference.md) and [`CHANGELOG.md`](../../../CHANGELOG.md)
      define the local-only correlation contract and exact phase semantics.
