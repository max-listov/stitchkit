---
title: A replacement says so, and a teardown is announced
description: A snapshot taken mid-restart used to be indistinguishable from a resource that failed on its own, and a closing watch hub dropped its subscribers in silence; both now say what is happening, and neither says it through a lifecycle state.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0159 — A replacement says so, and a teardown is announced

## Decision

`ApplicationSnapshot` carries `restarting: readonly string[]` — the subtree a
restart is replacing at this instant, empty between restarts — and
`ApplicationStatusProjection` carries `restarting: number`.

`WatchHub.close()` announces `phase: 'unavailable'`, `reason: 'source-unavailable'`
to every subscriber before it drops its sources.

## Why the snapshot and not the lifecycle

The obvious shape was a `restarting` member of `ApplicationLifecycle`, and it is
wrong for a mechanical reason rather than a stylistic one: `acquire()` refuses a
lease unless `isReady()` holds, and `isReady()` requires `lifecycle === 'ready'`.
A `restarting` lifecycle would therefore close admission for the **whole graph**
while one leaf is replaced — contradicting the single promise a subtree restart
exists to make, and doing it in the one place ADR 0154 argues hardest.

A `ManagedResourceState` member fails differently and more quietly: the start
loop overwrites the record with `starting`, so the marker would describe the
closing half of the window and vanish for the rest. It would also be invisible
where it is needed, because `projectApplicationStatus` counts `ready`,
`degraded` and `state === 'failed'` and would not count a new member at all.

A field costs one write, covers close, start and activate, widens no enum, and
breaks no reader of either enum.

### And the same defect arrived through the other door anyway

The first implementation of this ADR also marked the affected records `stopping`
before the close sweep, so the closing half of the window would be visible per
resource. That reintroduced the exact failure the paragraph above rejects the
lifecycle member for — because `isReady()` has **two** gates, not one: the
lifecycle, and every record's state. Measured on a two-resource graph, restarting
one leaf:

| | before | with the marking |
|---|---|---|
| `admission.acquire()` | lease granted | **null** |
| `snapshot.ready` | `true` | **false** |
| `snapshot.health` | `healthy` | **unhealthy** |

The marking is gone. `restarting` is the signal; nothing about a restart changes
what the rest of the graph may accept.

The lesson is not "check `isReady()`". It is that this ADR wrote down a
mechanism, correctly, and then the implementation walked into it through the
other of its two doors — and the test did not catch it because it used a
single-resource graph, where "the application went unready" and "the resource
being replaced went unready" are the same observation.

## Why a probe gets a count and a snapshot gets the ids

`getSnapshot()` already names every resource and its `dependsOn` edges — it is
the application's dependency graph, and it is not published. The status
projection is meant to be mounted publicly, so it gets the number. Zero versus
non-zero is the whole question a probe has: is this resource missing because it
broke, or because we are replacing it right now.

## Why the hub says something

`close()` used to clear its sources without a word. Every subscriber kept the
last value it was sent, at phase `live`, forever — a stale value standing as
current, which is the state ADR 0153 spends most of its length arguing against.

It survived because the hub used to close when the process did: the socket died
with it and the client recovered through `onConnectionChange`. A subtree restart
closes the hub while the connections are still up, which turns the impossible
case into the ordinary one.

`unavailable` / `source-unavailable` is the pair the client already publishes on
a dropped connection, so the browser needs no new branch. `closed` would need
one, and would tell a live page to stop retrying.

## A subscriber's failure is its own

Every call into a subscriber — the replay a late `open` gets, the value
broadcast, every state announcement — goes through one isolating helper. They
were direct calls, and a subscriber that threw took out whatever the hub was in
the middle of: the rest of a broadcast never heard it, and on the teardown path
their `unsubscribes` never ran either. The kernel already isolates its own
snapshot listeners for exactly this reason.

## Rejected: telling a dependant its dependency was replaced

The tempting follow-on is a hook letting a resource survive a dependency's
replacement instead of being restarted with it. It does not work, and the reason
is worth writing down.

A watch hub's `read`, `invalidatedBy` and `subscribe` are closures the
application supplies. If `read` captured the old handle, *telling* the hub
changes nothing — the closure still points at the dead thing. An application
that writes `read` as a late lookup already survives, today, with no framework
change at all.

And it would break what ADR 0154 rests on: `context.use()` reads the published
value at call time, and there is no channel to push a new handle into a resource
that is not itself being restarted. Adding one means a new `ManagedResource`
method — precisely the per-consumer burden ADR 0154 refused.

What already exists is the topic bus: the restarted resource announces, and
every source whose `invalidatedBy` names that topic re-reads.
