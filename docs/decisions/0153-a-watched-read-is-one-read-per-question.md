---
title: A watched read is one read per question, and the question is not a function
description: The watch hub shares one single-flight read per (operation, arguments) across every subscriber, and the client is built from the contract because a client method carries no identity a server could act on.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0153 — A watched read is one read per question, and the question is not a function

## Decision

A watched read is a GET the server re-runs when something it depends on
announces a change, pushing the new answer to everyone watching it.

`createWatchHub` (server, `stitchkit/application`) holds one source per
`(service, action, arguments digest)`. Every subscriber asking the same question
joins that source, so eight panels showing one conversation are eight
subscriptions and one read.

`createWatchClient` (browser-safe, `stitchkit/live`) is built **from the
contract**, giving `watch.action(args)` — mirroring `createUrlBuilder`.

## Single-flight is the ordering guarantee, not an optimisation

A key has at most one read in flight. An invalidation arriving during a read
marks the key dirty; the loop reads again when the first finishes.

Two overlapping reads finish in either order, and the slow one carries the older
world. A hub that published both would leave the *older* value standing as
current — with the phase still `live`, the value entirely plausible, and nothing
anywhere to indicate a problem — until an unrelated invalidation happened to
correct it. Serialising per key removes that race rather than detecting it, and
the dirty bit coalesces a burst of invalidations into one re-read instead of one
per announcement.

The revision on the wire is the value's version, and the client drops a frame no
newer than what it holds. Ordering is already guaranteed at the hub; the revision
keeps the guarantee legible at the other end.

## Why the client is built from the contract

`watch(api.notes.list, args)` is the shape one writes first, and it cannot work.
A generated client method is a bare closure carrying a single `withOptions`
property — no name, no path, no service — and deliberately so, because it has to
survive being handed to a `map`. Passing one to `watch` yields an anonymous
function, while the server needs to know *what* to re-read.

So the identity is the contract's own `(prefix, endpoint key)` — the same pair
the server labels every request with (ADR 0022) — and the arguments are reduced
to an order-independent digest, because `{a,b}` and `{b,a}` are the same question
and a key that disagreed would silently split one shared read into two. That
digest is the same function the MCP round already keys retries with; it was
module-private and is now shared, rather than written a second time.

## What the hub does not know

**How to read.** The application supplies `read`. A hub calling handlers itself
would be a second dispatch path — one that skips the authorization the first one
has.

**What may be watched.** A predicate over the operation's identity, supplied by
the caller. Not a field in `meta`: the core attaches no meaning to `meta`, which
is what makes it an escape hatch (ADR 0002/0021), and a core that started reading
`meta.uiRead` would end that.

## Failure is said in words, and there are three answers, not two

A failed read publishes `unavailable` with the error's own code and message. A
flag would make "the database is down" and "you are not allowed" the same fact.
The hub retries on its own schedule with the existing `createBackoff`, and a
successful read clears the state without anyone asking.

The vocabulary is `LiveStatePhase` and `LiveStateStopReason` — the ones the live
state controller already publishes — and not a second, poorer pair. Beyond
comparability, it supplies the third answer a two-word vocabulary loses:
`opening`, meaning subscribed and nothing read yet. That is neither healthy nor
broken, and rendering it as `unavailable` tells a user something is wrong when
the truth is that it is early.

## What it cannot claim

**One source per process.** Two processes behind a balancer are two reads, and no
test in this repository can show otherwise. The claim is "one read per question
per process", and it is written that way.

## Consequences

- The last value of a key is retained while anyone holds it and for `holdMs`
  after the last subscriber leaves, so a component that unmounts and remounts
  inside that window paints from memory. The key digest is cached alongside, so
  that second subscription resolves synchronously — a value arriving on a later
  microtask is not "before the network" in any sense a renderer can use.
- A source is not dropped while a read is in flight, even with no subscribers
  left: dropping it would publish the result into nothing and let the next
  subscriber start a second read for the same question.
- Both limits are declared and observable: watches per connection, and the read
  counter the "two browsers, one read" claim is measured with. The counter is
  exercised in both directions, because one that could only ever reach one would
  make that claim true of a hub that never reads at all.
