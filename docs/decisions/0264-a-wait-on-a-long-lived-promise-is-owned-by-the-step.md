---
title: "ADR 0264: A wait on a long-lived promise is owned by the step"
description: "A step of a loop that must stop on an abort waits through a listener it removes itself; a promise or signal that lives as long as the loop is never raced against once per step."
type: decision
status: accepted
created: 2026-10-17 13:37 +07:00
updated: 2026-10-17 13:37 +07:00
---

# ADR 0264 — A wait on a long-lived promise is owned by the step

**Invariants:** I10.

## Context

`Promise.race([step, longLived])` leaves a reaction on `longLived` until it settles, and the
promise the race returns keeps the step's result alive through that reaction. In a loop
that runs for the life of a stream, a queue or a handler, that is one promise, one
reaction and one retained result per iteration. A contract stream that sent a frame a
second grew by about 1.6 MB a minute, and a source that never had to wait was never
stopped at its `lifetimeMs`, because an already-settled step wins the race.
The same shape sat in the speech queue (one wait per sentence on a promise of the
queue), in the MCP handler (one per request on a promise of the handler) and in the
grammY update gate (one listener per poll on the polling signal).

## Decision

A step that must give way to an abort waits through `untilAborted(pending, signal)`
(`internal/until-aborted.ts`): the step owns its listener, removes it when `pending`
settles, and an abort is observed before the settled result. A promise or a signal that
lives as long as the loop is never an argument of `Promise.race` in that loop. A signal
that is followed rather than waited on is followed once, keyed on the signal.

A wait that is made once per call of a short-lived object stays as it is: the restart,
rollback and shutdown deadlines of the application kernel (`untilDeadline`), the
generation retirement of live state, and the per-call abort of admission and credential
refresh end with the object they wait on, so nothing outlives them.

## Consequences

A long stream, queue or handler holds a constant number of objects, whatever it has
carried. `tests/long-lived-waits.test.ts` opens each of them, runs a small and a large
number of steps and requires that what is retained does not follow the count.
