---
title: Compose existing bounded channels with realtime network delivery
description: Preserve the standalone network-delivery proposal while bounded composition remains part of the synchronization proof.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
pipeline: live-state-synchronization
order: 93
depends-on: —
defrost: Two maintained integrations contain duplicated pressure-to-channel bridge code with the same observable outcomes and ownership boundary.
---

## Зачем

Progress snapshots can replace pending older state; ordered records cannot silently lose
intermediate values. A network adapter also has its own buffers and send outcomes, so a
bounded application queue alone is not a total memory or delivery guarantee.

Stitchkit already ships `createBoundedChannel`, `createCreditWindow` and a latest snapshot sink.
The requested outcome is supported composition at network boundaries, not those primitives
again. See [the completed channel task](../done/2026-08-28-bounded-delivery-channels.md) and
`packages/core/src/application/channel.ts`.

## Current review disposition

Frozen as a standalone layer. The active synchronization task must reuse the existing channels,
credit windows and latest sink wherever it owns buffering, and its recipes must state the exact
local observation boundary. Socket.IO buffering remains Socket.IO-specific; a hypothetical Bun
send result does not justify a cross-transport vocabulary or imply peer delivery.

Defrost only if two maintained adapters need the same pressure bridge after the synchronization
composition exists. Until then, transport-specific send/close behavior stays in its adapter and
known loss or resync stays explicit in synchronization state.

## Результат

After architecture review, publish the smallest adapter hooks or recipes that connect existing
queue policies to transport pressure and close semantics. Normalize validation failure,
locally accepted/queued, pressure, refused/dropped and closed states where actually observable.
Unobservable transport information remains unknown, not invented.

Ordered delivery preserves sequence or emits an explicit loss/resync outcome. Latest mode
coalesces only declared replaceable pending state and exposes that fact. Commands are not
silently queued for replay; side-effect idempotency remains application-owned.

## План

- [ ] Inventory application queue, adapter buffer and engine buffer ownership on both transports.
- [ ] Define count/byte/per-item bounds and exact queue/transport handoff accounting; browser
      bufferedAmount is not a peer acknowledgement and cannot create remote credit.
- [ ] Reuse existing channels/credit leases and preserve their public semantics.
- [ ] Normalize Bun send outcomes, including queued-with-pressure versus dropped; do not infer
      peer delivery from return-value sign or bytes handed to the local engine.
- [ ] Respect Socket.IO buffering/volatile semantics without adding a hidden second retry queue.
- [ ] Define per-observer overflow and close/drain deadlines for ordered/latest policies.
- [ ] Report known dropped counts separately from an unknown-size gap. A slow consumer must
      still learn it needs resync, through an out-of-band close/reconnect outcome if necessary.
- [ ] Decide whether recipes suffice or a new export is supported by more than one use case.

## Acceptance

- [ ] Fast producer/absent reader and permanently pressured transport cannot grow owned memory
      or pending work beyond documented bounds.
- [ ] Ordered values are never silently overwritten; latest replacement is observable.
- [ ] One slow observer does not block others or the producer indefinitely.
- [ ] Abort/close settles pending work and releases retained values/credit exactly once.
- [ ] Native and Socket.IO pressure behavior is verified against real adapters, including the
      limits of what their APIs expose.
- [ ] No durable delivery claim, automatic command retry or duplicate queue implementation ships.
