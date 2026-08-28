---
title: Bounded delivery channels with explicit queue policies
description: Bounded delivery channels with explicit queue policies with explicit ownership, bounds and published conformance evidence.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
pipeline: transport-primitives
order: 4
depends-on: —
---

## Зачем

createEventBus is an in-process callback bus, not a bounded queue for asynchronous readers. createApplicationSnapshotSink already implements one active write plus one replaceable pending revision. Applications need reusable byte/count accounting and cancellation without confusing ordered delivery, replaceable state and durable history.

## Результат

A small process-local channel surface with explicit ordered/latest policies and a composable credit-window mechanism where justified. Reuse the existing snapshot sink's semantics rather than ship two conflicting latest-wins engines. Adapters map overflow to their protocol; the channel never manufactures domain gaps or snapshots.

## Состояния

Channel: open → closing/draining → closed, or failed. Pending readers/writers are settled on close/abort.
Ordered values are not silently overwritten. Latest mode may coalesce only pending replaceable values and reports coalescing. Credit is bounded permission to transfer bytes, not a durable delivery acknowledgement.

## План

- [x] Audit event bus, snapshot sink and streaming-route backpressure; identify the smallest shared mechanics before choosing exports.
- [x] Define count/byte caps with an explicit size function and rejection of one item larger than the entire budget.
- [x] Specify offered/queued/delivered/coalesced/refused outcomes and drain-versus-discard close behavior.
- [x] Make slow-consumer policy explicit; no implicit loss, retry, polling or unbounded waiter queue.
- [x] Provide finite credit accounting with overflow/underflow checks and exactly one replenishment boundary.
- [x] Preserve snapshot revision filtering and existing sink behavior when sharing implementation.

## Acceptance

- [x] Slow/absent readers, fast writers and many keys keep memory/waiter counts within declared limits.
- [x] Ordered mode preserves order; latest mode exposes replaced-value counts and does not claim initial retained state.
- [x] Close/abort settles parked next()/write operations and frees retained values; duplicate close is safe.
- [x] Credit cannot exceed the window, go negative or replenish twice for one consumed item.
- [x] Independent progress-state and ordered-output examples prove reusable semantics; existing snapshot-sink tests remain green.
- [x] No broker, persistence, boot-epoch policy, distributed acknowledgement or automatic resync enters core.
- [ ] Publish exact exports/defaults, migration and packed Bun/Node conformance evidence through the canonical release flow.

## Выполнено до публикации

- `createBoundedChannel()` is exported by `stitchkit/application` with explicit
  `ordered` and `latest` policies, exact caller-supplied byte accounting,
  finite retained items and a single pending reader.
- Offers report `delivered`, `queued`, `coalesced` or `refused`; ordered data is
  never overwritten. Drain and discard close paths, abort and failure settle
  parked readers and release retained references.
- `createCreditWindow()` provides finite byte credit with idempotent leases.
  `createApplicationSnapshotSink()` now shares the latest-channel mechanism
  while preserving revision filtering and status counters.

## Регрессия

`packages/core/tests/bounded-channel.test.ts`:

- `ordered mode preserves order and refuses count/byte overflow explicitly`
- `ordered byte capacity is independent of item capacity`
- `latest mode retains exactly one pending replaceable value and reports coalescing`
- `one parked reader is delivered directly and a second waiter is refused`
- `discard close and abort settle readers and free retained values`
- `failure rejects a parked reader and every later read, including undefined causes`
- `many distinct keys cannot exceed the declared retained item bound`
- `credits never overdraw and one lease replenishes exactly once`

`packages/core/tests/application-activity.test.ts` preserves these exact sink
cases: `delivers a blocked revision 1 followed by only the latest revision 100`,
`isolates a write failure and still delivers the final accepted latest value`,
and `rejects duplicate and backwards revisions without disturbing delivery order`.
Packed Bun examples exercise independent latest progress and ordered output;
the Node fixture compiles and runs the public channel and credit exports.
