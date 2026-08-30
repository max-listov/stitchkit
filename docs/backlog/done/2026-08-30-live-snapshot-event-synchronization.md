---
title: Extract optional snapshot and event synchronization mechanics
description: Keep application state current across duplicate events, gaps, source loss and explicit resync without owning transport recovery or durable history.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 15:08 +0000
pipeline: live-state-synchronization
order: 1
depends-on: —
---

## Зачем

An open socket proves transport connectivity, not that a client has current application
state. Independent snapshot fetches and event subscriptions can miss a change between them;
reconnection alone does not restore events missed while offline.

Applications repeat snapshot/event state machines for progress views, ordered output and
other live resources. The mechanism can be generic while schemas, reducers and storage stay
with the application. This proposal does not claim that Socket.IO recovery is broken.

## Existing foundation and review gate

Review `packages/core/src/agent-runtime/control-schema.ts`,
`packages/core/src/agent-runtime/harness-control.ts` and the completed
[agent control/view task](../done/2026-08-30-agent-control-client-and-view.md).
Agent snapshot/cursor/reducer behavior already exists. Extract only semantics that genuinely
generalize; preserve agent-specific ownership and do not ship a competing reducer for it.

Typed SSE/NDJSON parsing already exists in `browser/contract-stream.ts`. A shared receiver
may compose with those streams without pretending that a one-way stream is a bidirectional socket.
Implementation begins only after approval of the program review.

## Current review disposition

This is the only provisional new runtime primitive in the program. Its first phase builds two
test-local real-boundary proofs and proceeds to a public controller only if they identify the same
state machine. The public boundary is a synchronization source supplied by the host, not a
universal network adapter.

The semantic source operation is intentionally narrow:

```ts
open({ signal, onEvent }): Promise<{ snapshot: TSnapshot; close(): void }>
```

The controller registers `onEvent` before invoking `open()` and buffers early events within an
explicit finite limit. When `open()` resolves, the source guarantees that every event after the
returned snapshot's consistency point has already been or will be passed to that callback. A
typed HTTP-stream binding may provide the equivalent guarantee by making a validated snapshot the
first frame and all later frames events from the same generation. A separate uncoordinated GET
followed by stream attachment is an explicit negative fixture, not a supported recipe.

Transport connection, retry, request/ack, rooms, capability negotiation and framing stay outside this primitive. The
source must explicitly provide the atomic subscription/snapshot ordering or watermark needed to
close the race; the controller cannot manufacture this guarantee. Provider cursors remain opaque
and are compared or classified only through provider callbacks.

The controller accepts already typed snapshot/events. Schema walking stays in existing Socket.IO
and HTTP-stream bindings; adding schemas here would create a second validation boundary. The
browser-safe public export belongs to the root `stitchkit` entrypoint. It may reuse the internal
browser-clean bounded channel implementation without exporting or importing the server-oriented
`stitchkit/application` surface. The numeric latest snapshot sink is reused only by sources whose
revision semantics actually satisfy it; it is not the basis for opaque cursors.

## Результат

An optional renderer-neutral synchronization controller with the states proven by the fixtures:
idle, opening, live, resync-required, unavailable and closed. A host supplies an already typed
source, reducer and provider-owned cursor/revision policy.

Only a verified snapshot plus a continuous event boundary can produce live state.
Connection recovery, snapshot freshness and application durability are separate facts.

## План

- [x] Derive states/transitions from both proof scenarios; specify cancellation and terminal
      source failures without taking ownership of transport reconnect policy.
- [x] Before public API design, reproduce the snapshot/attach race with a Socket.IO binding and
      the unsafe separate-GET HTTP binding; then prove the supported source boundary for both.
- [x] Define an atomic snapshot/stream boundary or a provider-supplied revision/watermark with
      bounded buffering; reject the unsafe uncoordinated GET-then-subscribe recipe.
- [x] Define duplicate and gap decisions while keeping snapshot freshness, restart epochs and
      cursor compatibility inside the provider source. No universal numeric ordering is assumed.
- [x] Specify controller outcomes for source loss, source failure, bounded controller capacity and
      resync-required. Resume acceptance, expired history and incompatible cursors determine
      whether the provider returns a consistent snapshot or rejects `open()`; they are not a
      second controller taxonomy.
- [x] Fence events and snapshot responses by subscription generation so a late old request
      cannot overwrite a newer view or cross a scope change.
- [x] Keep retry at one layer: consume Socket.IO recovery signals without competing with its
      connection retry; application-state resync remains independently necessary.
- [x] Expose a small subscribe/getSnapshot boundary usable without React Query or Zustand.
- [x] Reuse existing bounded channels or latest sink for finite buffering; do not introduce a
      second queue or claim remote delivery from local admission.
- [x] Add deterministic internal conformance for controller-owned states, buffer bounds, fencing,
      resync and cleanup; transport ACK/protocol cases stay in existing transport suites.
- [x] Write and index a new additive ADR if the proof supports a public controller; do not rewrite
      ADR 0008, 0020 or 0069.

## Acceptance

- [x] A change occurring exactly between snapshot acquisition and stream attachment is not
      silently missed in both real source fixtures; the unsupported separate-GET shape fails the
      negative fixture.
- [x] Duplicate, gap, source loss, buffer overflow, bounded controller capacity and explicit
      post-reconnect resync produce deterministic state; provider cursor/restart policy stays
      outside the controller.
- [x] Stale in-flight work after dispose or scope change cannot mutate current state.
- [x] Controller-owned memory, buffers, listeners and pending settlement are bounded during
      prolonged synchronization failure; non-cooperative caller-owned work is fenced, not claimed
      to be forcibly cancelled.
- [x] Independent progress-state and ordered-record examples reuse the same mechanics.
- [x] The current agent snapshot-before-attach race is reproduced or disproved. Agent-specific
      reducers remain unchanged unless they are deliberately migrated to the proven source boundary.
- [x] Packed root imports remain browser-clean and no consumer imports `stitchkit/application` to
      use synchronization.
- [x] No event database, generic RPC layer, exactly-once delivery or automatic command replay
      is introduced.

## Что сделано

- Published `createLiveStateController` from the browser-safe root with finite early-event
  buffering, provider-owned reduction, explicit gap/resync, generation fencing, synchronous
  external-store subscription and a combined bound of two unsettled source operations.
- `packages/core/tests/live-state-boundaries.test.ts` — `Socket.IO buffers an event sent after the
  snapshot point but before its acknowledgement`, `one NDJSON generation validates a snapshot
  first and cannot miss its following event`, `a separate HTTP snapshot followed by attachment
  can silently miss the intervening change`.
- `packages/core/tests/live-state.test.ts` — `honors another synchronous resync when a replacement
  snapshot is still rejected`, `keeps the combined source operation bound while late opens become
  cleanup`, `transfers a settled open to cleanup before queued resync can consume its slot`.
- `packages/core/tests/agent-harness-public.test.ts` — `attaches before snapshot settlement so a
  concurrent Agent event is not missed`.
- ADR 0137, the realtime guide, API reference, changelog and generated consumer documentation now
  describe the same source consistency and ownership boundary.

## References

[Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/) and
[connection state recovery](https://socket.io/docs/v4/connection-state-recovery/).
