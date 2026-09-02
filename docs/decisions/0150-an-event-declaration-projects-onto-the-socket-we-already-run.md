---
title: An event declaration projects onto the socket we already run
description: defineEvents declares topics, payload schemas and how each is delivered to in-process listeners, and reaches the wire by projecting onto the existing realtime contract rather than by owning a transport of its own.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0150 — An event declaration projects onto the socket we already run

## Decision

`defineEvents` declares topics: a wire name, one payload schema, and how the
topic reaches listeners **in this process** (`emit`, `serial`, `decision`).

It owns no transport. `toRealtimeContract(declaration)` produces a
`RealtimeContract` whose `serverToClient` registry carries each topic as a
one-element argument tuple, and from there the existing machinery does
everything: `bindRealtimeServer` publishes, `bindRealtimeClient` subscribes,
`createValidatedRealtimeSocket` validates in both directions and reports
rejections, `buildSurfaceManifest` catalogues, and the client's `retain:` option
replays the last payload to a late subscriber. There is no second `on()`, no
second validator, no second catalogue and no second retained-value store.

In-process delivery is the existing `createEventBus`, which gains two verbs
beside `emit`: `emitSerial` (one listener at a time, awaited) and `decide`
(listeners vote `allow` / `deny` / `defer`). Passing the declaration's `topics`
closes the bus: an undeclared topic is refused, and a topic can only be delivered
by the verb its declaration chose.

## Why not a transport

Because this repository already built one and deleted it. ADR 0009 records a
native WebSocket stack whose event registry was called `defineEvents` — about
700 lines, never adopted by a single consumer — and ADR 0008 replaced it with
thin Socket.IO wrappers and wrote down the lesson: *wrap the transport the
consumers already run on*. The name returning does not un-revert that decision;
the declaration is the half that was missing, and it is the only half being
added.

## Why the mode is a property of the topic

A delivery mode chosen at the call site is a mode two call sites disagree about.
Declaring it means the announcement site cannot decide to stop waiting for
listeners on a topic whose listeners were written expecting to be waited for.

Modes describe **local** delivery only. A remote subscriber cannot delay or veto
a server's announcement, so nothing about the mode reaches the wire — a
`decision` topic's frame is an ordinary announcement once the decision is made.

## Three things with no default

- **`whenAllDefer`**, on a `decision` topic. Every listener deferring is a real
  outcome — nobody claimed the event — and whichever value were chosen as a
  default would be a standing `allow` or a standing `deny` applied to every topic
  whose author never considered it. Both are decisions; a default makes them
  silently.
- **`listenerTimeoutMs`**, on any mode that waits. A listener that never settles
  would otherwise hang the caller forever, and a caller hanging forever is
  indistinguishable from a caller doing work.
- **What a non-vote means.** A `decision` listener that throws, times out, or
  returns something that is not a decision is counted as `deny` with a reason.
  This is the deliberate asymmetry with `emit`, where an isolated failure means
  "the others carry on": for a vote, the same isolation would mean "counted as
  consent". A listener that was asked and did not answer has not agreed.

## Consequences

- A topic has exactly one name — `prefix.name` — and it is the key of the
  declaration, the event on the wire and the string passed to `on`. The short key
  in the literal is where the full name is built, not a second name for it.
- A rejected announcement is reported at the peer that refused it, through
  `onRejected`; a fire-and-forget event has no acknowledgement channel to carry a
  refusal back, which is the boundary ADR 0106 already describes.
- Issue paths name the tuple position: a bad `revision` field is `0.revision`,
  because event arguments are a tuple and one payload sits at index 0 of it.
- An unsubscribed listener is no longer called mid-dispatch. The bus used to
  snapshot its subscription set and call everything in it; on a `decision` topic
  that meant a listener which had unsubscribed still got a vote.
- The declaration is browser-safe and ships from `stitchkit/live`, declared
  **evolving** — its shape is being found with its first consumers, and an
  entrypoint says so where a symbol cannot (→ ADR 0103).
