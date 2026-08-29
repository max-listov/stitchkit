---
title: Metadata-only phases for acknowledged realtime requests
description: Expose the Engine.IO acknowledgement boundary separately from validated Promise settlement so deadline diagnosis can distinguish transport receipt from callback scheduling.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
priority: P1
---

## Зачем

`createRealtimeClient().request()` currently exposes one Promise around Socket.IO acknowledgement.
When a request settles after its caller deadline, an application cannot distinguish these cases:

- the outbound event had not reached the Engine.IO write boundary;
- the acknowledgement packet had not reached the local Engine.IO decoder;
- the packet was already received but JavaScript acknowledgement parsing/callback scheduling ran late.

This distinction cannot be reconstructed from broker timestamps or cross-host clock subtraction.
Socket.IO 4.8.3 exposes `engine.packetCreate` and `engine.packet` before the Promise callback. A real
local positive control joined the same native acknowledgement id through
`packet-created → ack-received → promise-settled`; the missing piece is a supported bounded
Stitchkit surface rather than consumer access to Socket.IO internals.

## Результат

An opt-in metadata-only request-phase hook reports a per-request opaque identity, event name,
monotonic elapsed time and a closed phase union sufficient to distinguish local transport receipt
from later validation/settlement. It exposes no arguments, acknowledgement value, packet bytes,
credentials, URL query or domain payload.

## План

- [x] Define one optional hook on the canonical Socket.IO realtime client composition. Keep the
      identity Kit-owned and opaque; Socket.IO acknowledgement ids are implementation details.
- [x] Emit bounded phases for outbound engine handoff, inbound engine acknowledgement receipt,
      acknowledgement callback/validation settlement, timeout and disconnect.
- [x] State exact semantics: Engine.IO receipt is a local decoder boundary, not proof of remote
      physical send time or network RTT; Promise settlement includes callback/validation scheduling.
- [x] Preserve the current request API, timeout/disconnect errors and zero-cost behavior when the
      hook is absent. Do not add polling, a sampler, payload logging or a second request timer.
- [x] Add real Socket.IO positive controls and packed Bun/Node consumer coverage.

## Acceptance

- [x] One acknowledged request reports ordered, same-identity engine-handoff, engine-ack-received
      and settled phases; the ack-received hook runs before the user-visible Promise settles.
- [x] Timeout before acknowledgement and disconnect in flight each report one terminal phase and
      release existing listeners/timers exactly once; a late packet cannot resurrect the request.
- [x] Concurrent acknowledgements remain correctly correlated through reordering and mixed success,
      timeout and disconnect outcomes.
- [x] Hook records contain no request arguments, ack body or raw packet data and have a finite
      schema. A throwing observer cannot change request correctness or lifecycle.
- [x] Existing consumers compile and behave unchanged; packed Bun and Node tests use the published
      surface rather than private Socket.IO fields.

## Что сделано

- `RealtimeClientOptions.onRequestPhase` reports the strict public
  `RealtimeRequestPhaseEventSchema`: Kit-owned opaque identity, contract event, closed phase and
  monotonic elapsed time only. Sync and async observer failures are contained.
- The canonical client joins outbound `engine.packetCreate` and inbound `engine.packet` by the
  internal namespace/native-ack envelope prefix. Payload JSON is never parsed, and the native id
  is discarded before the public observation.
- Successful acknowledgement stays open through Zod acknowledgement validation before `settled`;
  timeout and disconnect close the identity once and remove correlation state.
- Exact regression coverage lives in `packages/core/tests/socket-io.test.ts`:
  `request phases distinguish Engine.IO receipt from validated settlement`,
  `concurrent reordered and timed-out requests retain exact phase identities`,
  `disconnect reports one terminal request phase and late work cannot revive it`, and
  `concurrent success and disconnect outcomes keep independent identities`.
- `packages/core/scripts/consumer-lane/self-contained-socket-client.mjs` executes the published
  `createRealtimeClient`, schema and hook from isolated packed artifacts on Bun and Node.
- `bun run verify` passed for tree `d2fdfa8c2679`.
