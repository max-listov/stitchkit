---
title: A resource that can be restarted is a resource that can begin a generation
description: Restart was built as a graph operation over resources that had never been told `start` could be called twice, so none of the three the framework ships survived it; `start` is now the beginning of a generation, and the result agrees with the snapshot.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0157 — A resource that can be restarted is a resource that can begin a generation

## The mistake this corrects

ADR 0154 defined a restart as an operation on the resource *graph*: close a
subtree, start it again, leave the rest running. Everything it says about the
graph is still true, and the tests that hold it all passed.

They passed because every one of them used a hand-written fixture. A fixture is
a resource that agrees with whatever the kernel does — it publishes what the test
wants and holds no state the test did not put there. Against the three resources
the framework actually ships, restart did not work at all:

- `createManagedSchedule` set an internal `stopped` in `close()` and threw
  `schedule "…" is stopped` on the next `start()`. Schedules are required by
  default, so a restart naming a schedule — or anything a schedule depends on —
  left the application permanently `unhealthy`.
- `keyspaceResource` never reset `admitting` and never cleared its records, so it
  came back `ready` and `healthy` with every write rejected as "shutting down".
- `managedServerResource` memoised its shutdown promise, so after a restart
  `close` returned an answer about a server that was already gone and never
  asked the new one to stop; given a server instance rather than a factory, it
  republished a handle it had itself shut down — the exact dead handle ADR 0154
  exists to prevent.

The common cause is not three bugs. It is that `ManagedResource` never said
`start` may be called again, so nothing that implements it was written to be.

## Decision

**`start` begins a generation.** A resource that holds state across its own
lifetime rebuilds that state in `start`, because the kernel may call it again.
The three shipped resources now do.

**Refusing a start after the application is finished stays the kernel's job.** A
resource cannot tell a restart from the way down — from inside, both are a
`close` — and the one that guessed produced the worse answer. The kernel knows,
and already refuses `restart` unless the application is `ready`.

**A resource that cannot begin a second generation says so, by name.** A managed
server given an instance rather than a factory cannot: the instance has been shut
down and there is no second one. It throws with the fix in the message. That is
strictly better than the two alternatives — republishing a dead handle, or
silently coming back broken.

**Per-generation state that cannot be rebuilt is constructed per generation.** A
keyspace backend may now be a factory, called once per generation. A plain value
still works where `close()` followed by `load()` is fine; where it is not, the
restart fails loudly in `load` rather than coming back as a keyspace that refuses
every write.

## The result must agree with the snapshot

`startEach` re-throws only for a **required** resource. An optional one that
would not start again was recorded, skipped, and reported as `restarted` — a
return value contradicting the `failed` / `unhealthy` in the very next
`getSnapshot()`. Two answers to one question, and the caller reads the wrong one.

The records decide. If any affected resource ends the restart in `failed`, the
restart is `failed`.

## A restart is bounded, like every other way down

`closeOne` was the one stopping path that passed no deadline, and its
`AbortController` was constructed, threaded through every phase, and never
fired — an abort signal nothing aborts. One `drain()` awaiting work that never
finishes hung the restart for the life of the process, and because restarts are
serialised, every restart queued behind it.

It takes the application's shutdown budget, or one the call names. Same three
phases, same budget question, same answer.

## What this costs

A resource author now has one more thing to get right, and the framework cannot
check it: nothing in the type system distinguishes a resource that rebuilds its
state in `start` from one that does not. What the framework can do is test its
own against the real thing, which is what
`packages/core/tests/application-restart-real-resources.test.ts` is for — and
what the fixture-only suite could never have done.
