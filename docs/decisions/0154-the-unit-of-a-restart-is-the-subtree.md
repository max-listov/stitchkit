---
title: The unit of a restart is the subtree, not the resource
description: Replacing one managed resource takes down every resource that transitively depends on it, in reverse dependency order, because a dependant left running holds a handle to a closed generation.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0154 — The unit of a restart is the subtree, not the resource

## Decision

`ApplicationHandle.restart({ resourceId })` replaces the named resource **and
every resource that transitively depends on it**, leaving the rest of the graph
running and the process epoch unchanged.

The affected set is closed top-down through `stopAdmission` → `drain` → `close`,
then started bottom-up and activated, using the same `startEach` / `activateEach`
the full startup uses — not a second copy of them.

## Why the subtree and not the resource

A resource publishes a value; its dependants receive that value through
`context.use(...)` and keep it. Replacing the database alone leaves the
repository holding a pool that has been closed — a handle that still typechecks,
still has methods, and fails at the first call, at whatever time the first call
happens to be.

There is no representation of "the handle you hold is stale" that a dependant
would have to notice, and adding one would put the burden on every consumer of
every resource. Taking the dependants down with it is the only version where
nobody holds a dead handle, and it is cheap in the case that matters: a leaf
restart affects one resource.

An independent neighbour is not touched. That is the half the tests assert hardest,
because a restart that quietly took the whole graph down would satisfy every
assertion about the target coming back.

## Erasing the generation, including what it published

Closing is not enough. The old generation's published value is deleted from the
graph, so a restarted dependant is handed the **new** handle.

This matters in exactly one case, and it is the dangerous one. When the new
generation publishes a value, the `set` overwrites the old entry and the delete
changes nothing. When it publishes **nothing** — a resource that publishes
conditionally, or one whose restart fails — there is no overwrite, and without
the delete a dependant would silently receive the value of a resource that has
been closed. So the test that holds this is not the one where the value changes;
it is the one where the new generation publishes nothing and the dependant is
refused loudly instead.

The record returns to *registered, never started*, not to *closed*. A record
left marked closed comes back up and is then skipped on the way down — a live
generation the shutdown believes it has already dealt with.

`failures` and `everHealthy` deliberately survive a restart: they are the
process's history rather than this generation's state, and the shutdown report is
the one place a failure that was later restarted away is still visible.

## Serialised, and refused rather than raced

Two restarts of overlapping subtrees, or a restart racing a shutdown, are the two
ways to end up with two live generations of one resource. So restarts queue
behind each other rather than being refused — two callers asking for overlapping
subtrees is ordinary, and what must never happen is their phases interleaving —
and a restart during shutdown, before readiness, or of an unknown id is
**refused**, which is not a failure and touches nothing.

## What a failure looks like

A resource that will not start again produces `outcome: 'failed'` with the
reason, and the application snapshot says the same thing, because `startEach`
records a failure the way it does during startup. Nothing is rolled forward: the
old generation is closed and the new one did not come up, which is exactly what
the snapshot reports.

The failed attempt is still closed on the way down, the same convention a
resource that fails during ordinary startup gets — `start` may have leaked
before it threw.

## The epoch does not move

The process did not restart, so `epoch` is unchanged. An observer that treats an
epoch change as "everything I knew is stale" is right to keep its state; the
resources that were replaced are named in `affected`.

## Consequences

- A restart is not a substitute for a process restart. It replaces resources; it
  does not re-read configuration the kernel captured at construction.
- The affected set can be the whole graph, if the named resource is at the root
  of it. That is honest rather than surprising: it is what depending on something
  means.
