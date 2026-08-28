---
title: "ADR 0119: Delivery policy is ordered or replaceable"
description: "A bounded process-local channel makes ordered retention, latest-value coalescing and byte credit explicit instead of treating every event bus as a queue."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0119 — Delivery policy is ordered or replaceable

## Context

An event bus invokes callbacks; it is not a queue. The application snapshot sink
already has a different and useful rule: one write plus one replaceable pending
revision. Applications otherwise copy count limits, byte accounting and close
semantics while calling both behaviours “events”.

## Decision

`createBoundedChannel` offers values without a hidden writer queue. `ordered`
retains every accepted value in order and refuses count/byte overflow. `latest`
retains exactly one pending replaceable value and reports each coalescing event.
The caller supplies `sizeOf`; the channel accounts the exact retained byte value
it returns.

Only one `next()` may be parked. Close either drains accepted values or discards
them explicitly; abort uses discard semantics; failure rejects the reader and
all later reads. Every offer reports `delivered`, `queued`, `coalesced` or a
reasoned `refused` result.

`createCreditWindow` is a separate exact byte-permission primitive. Its leases
cannot overdraw the window and replenish once. Credit is not a durable
acknowledgement.

The application snapshot sink reuses the same latest-value channel mechanics
while retaining its revision filter and public status contract.

## Consequences

- Slow-reader policy is visible at construction and at every offer.
- Memory and waiter counts are finite; there is no implicit loss in ordered
  mode and no false history claim in latest mode.
- Protocol adapters decide how refusal, gaps and resynchronisation appear on
  their wire.
- No broker, persistence, distributed acknowledgement or boot-epoch policy
  enters the application core.
