---
title: "ADR 0183: A watched value may cross as a difference to a revision the subscriber holds"
description: "A watch frame is one of three shapes — the value, a structural difference to a named base revision, or nothing-changed — chosen per subscriber and never sent when it is not smaller."
type: decision
status: accepted
created: 2026-09-15
updated: 2026-09-15T08:44+07:00
---

# ADR 0183 — A watched value may cross as a difference

## Decision

`stitchkit.watch.value` is a discriminated union on `kind`:

- `full` — the whole value, as before.
- `delta` — a structural difference (`stitchkit/live`'s `WatchDelta`) against
  `base`, a revision the subscriber is known to hold.
- `unchanged` — the answer the subscriber already has is still the answer.

Every frame carries `fingerprint`, the order-independent digest
(`argumentsDigest({ value })`) of the value the receiver holds after applying
it. `stitchkit.watch.open` may carry `have: { revision, fingerprint }`.

The hub chooses the shape **per subscriber**, from the revision it last
delivered to that subscriber without the delivery throwing. It keeps superseded
values per key under a byte ceiling — `deltaMemoryBytes`, default 256 KiB, and
`0` disables differences entirely. A difference is sent only when its encoded
length is strictly shorter than the value's.

The client rebuilds the value, checks the result against `fingerprint`, and on
any failure — a base it does not hold, a difference that will not apply, a
fingerprint that disagrees — resynchronises **that key alone**: it drops the
value, publishes `resync-required`, closes and re-opens.

## Why

A watched read publishes the whole answer on every change. Measured by a
consumer: a ~75 KB list answer in which two timestamps move, republished every
fifteen seconds, is a megabyte per subscriber per minute to carry a hundred
bytes of news. After a socket drop the same subscriber is sent every value
again, including the ones that did not change while it was away.

## Alternatives rejected

**JSON Patch / RFC 7386 merge patch.** Merge patch cannot remove an array
element or distinguish `null` from "delete", and a watched read's value is
arbitrary application JSON where both are ordinary. Both formats cost one
operation per element for an array that merely slid by one — the shape every
paged and tailing list has, and the case this exists for.

**Acknowledging each frame.** A baseline confirmed by the subscriber would be
exact, and would put a round trip in front of every frame. The socket is ordered
and reliable while it is up; when it is not, the subscriber re-declares what it
holds in `open`. Delivery that throws does not advance the baseline.

**A revision alone as the resume token.** Revisions restart at zero when a key
is released and re-acquired, so a bare revision lets a value from a previous life
of the source pass for the current one. The fingerprint decides; the revision
only says where to look.

**Tolerant reassembly.** A difference applied to the wrong base produces a
plausible value that nobody holds. `applyWatchDelta` throws instead, and the
client resynchronises.

## Limits

Resuming needs the key to still exist on the hub. With `holdMs: 0` and no other
subscriber, the last detach releases the source and a reconnecting page pays the
whole value once; an application that wants cheap reconnections sets `holdMs`
past its reconnect delay. Differences are per process — two hub processes behind
a balancer keep separate baselines, as they already keep separate reads.

The frame shape changed, so both ends must come from the same major: a client
older than this release reads a `delta` frame as a value of `undefined`.
