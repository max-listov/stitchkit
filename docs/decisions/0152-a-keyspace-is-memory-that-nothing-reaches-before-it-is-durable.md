---
title: A keyspace is memory that nothing reaches before it is durable
description: defineKeyspace declares a named record set read synchronously from memory and written through one serialised chain, where memory and the change event both follow the backend's acknowledgement, and the whole thing is a managed resource so the kernel can close it in order.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0152 — A keyspace is memory that nothing reaches before it is durable

## Decision

`defineKeyspace(name, { schema, key })` declares a record set. `keyspaceResource`
opens it as a `ManagedResource` whose `start` publishes a handle: `get` and
`list` read synchronously from memory, `put` and `delete` return a promise that
resolves when the change is durable.

The order is fixed and is the whole decision: **backend, then memory, then the
change event.**

- Backend first is what makes the memory authoritative. A reader can never
  observe a value that did not survive. The reverse order makes writes feel
  instant and makes every rejected write a lie somebody has already read.
- The event last, after memory, because a subscriber woken by it will read
  immediately — an event emitted before the memory update is a wake-up to the
  old value.

Writes run on **one chain per keyspace**, so two writes to one key reach the
backend in the order they were accepted and their events follow that same order.
The queue is bounded and `put` rejects when it is full: an unbounded write queue
turns a slow backend into memory exhaustion, discovered when the process dies.

## Why it is a resource rather than a function you call

The application kernel resolves its resource graph in its constructor and has no
way to register one afterwards. A keyspace opened by a bare `openKeyspace()`
inside another resource's `start` is invisible to it: never drained, never
closed, never ordered against the things that write to it. Declared as a resource
it closes *after* its writers, because a writer that depends on it is stopped
first.

## What "durable" is allowed to mean

It means the backend's `put` resolved. It does not mean `fsync`, and this
boundary cannot make it mean that — SQLite in WAL mode with
`synchronous = NORMAL` returns success before the data reaches the disk. What an
acknowledgement is worth is the backend's to state and the owner's to configure.
Claiming durability without naming whose would be the more comfortable lie.

The same honesty applies to shutdown. Graceful close is deadline-bounded and a
forced close can cut a drain short, so a keyspace that closes with writes still
queued reports **how many** through `onUnwritten`. A number, because silence
there is a keyspace that lost records and said nothing.

## The backend port is not a SQL port

`KeyspaceBackend` is `load` / `put` / `delete` / optional `close`. Typing it
against statements would make SQLite the only backend anyone could actually
write — everyone else would be forging a `prepare()`. `sqliteKeyspaceBackend`
is one implementation of that port, and a file, a bucket or a remote store are
equally expressible.

It does not close the database handle it was given. That handle was opened by the
caller, may back several keyspaces and the agent-runtime store besides, and a
backend that closes a connection it did not open takes the rest of the process
with it.

## The name, and a rename it forced

Not `defineDomain`. `stitchkit/primitives` already publishes nineteen `Domain*`
exports about domain *events* — a different meaning of the word — and two senses
of one word in one public surface make a search for it useless.

Shipping the SQLite backend also required the minimal `exec`/`prepare`/`close`
boundary the agent runtime already had. It was called
`AgentRuntimeSqliteDatabase`, which stopped being true the moment something other
than the agent runtime used it: a keyspace typed against an `AgentRuntime*`
boundary reads as a dependency on the agent runtime, which it is not. It moved to
a neutral module as `SqliteDatabase` / `SqliteStatement` / `SqliteValue` and the
old names were deleted in the same pass. No re-export under the old name — that
would be an alias, and one thing with two names is the defect this repository
refuses on principle.

## Consequences

- A stored record that no longer satisfies the schema stops `start` rather than
  being skipped. Skipping makes "absent" and "never written" the same observation
  for everything downstream.
- A value that does not satisfy the schema never reaches the backend: `put`
  parses before it queues, so a bad record is refused at the call site rather
  than discovered at load time on the next restart.
- The change callback is a callback, not a bus dependency, so a keyspace works
  without one. Wire it to a topic declared with `defineEvents` and a watched read
  invalidates on it.
