---
title: A revision signal broadcasts a fact, not an item
description: A finite process-local signal closes the snapshot-to-wait race and wakes every observer without becoming a queue.
type: decision
status: accepted
created: 2026-09-04 14:11 +07:00
updated: 2026-09-04 14:11 +07:00
---

# 0163 — A revision signal broadcasts a fact, not an item

## Context

Several operations may need to wait until the same process-local fact changes.
An event bus broadcasts callbacks but owns no await, timeout, cancellation or
close lifecycle. A bounded channel retains items for one reader, so using one
turns a broadcast into competition. A credit window waits for ownership of a
finite resource, not for evidence that a fact is newer.

The dangerous interval is between reading the fact and registering the wait. If
the fact changes there, a future-only notification parks the operation until an
unrelated second change.

## Decision

`createRevisionSignal` owns one monotonic safe-integer revision and a required
`maxWaiters`. `advance()` increments the revision and settles every waiter whose
cursor is older. `wait(after)` first compares the cursor with the current
revision: an older cursor resolves immediately, the current cursor may park and
a future cursor is rejected as a caller error.

Every terminal result carries the revision observed at settlement. Change,
timeout, abort, close and capacity are distinct outcomes. Every parked wait has
one settlement path that removes its abort listener, cancels its timer and
releases its waiter slot before resolving.

`close()` is idempotent and settles all retained waits. The signal is a
synchronous handle owned by the resource whose fact it announces; that resource
calls `close()` during its own teardown. A second managed-resource wrapper would
duplicate lifecycle identity without owning another lifecycle.

## Consequences

- One change wakes every observer and is never consumed by the first one.
- Snapshot-then-wait cannot miss an intervening advance.
- Retained memory has an explicit finite count bound and pressure is observable.
- No payload queue, replay history, transport policy or domain vocabulary enters
  the application core.
