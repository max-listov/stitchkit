---
title: "ADR 0137: Live state opens one continuous source generation"
description: "A browser-safe controller installs a typed snapshot and bounded following events from one host-owned consistency boundary."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0137 — Live state opens one continuous source generation

## Context

An open realtime transport does not prove that application state is current. Reading a snapshot
and attaching an event listener as unrelated operations can miss the change between them. Several
applications need the same small state machine—buffer events while a snapshot is opening, reject
gaps, fence old generations and clean up—but their schemas, cursors, replay and reconnect policy
are different.

Socket.IO already owns transport connection and retry. Contract HTTP streams already own framing
and schema validation. A new transport adapter, cursor format or event store would duplicate those
boundaries rather than solve the shared race.

## Decision

The browser-safe root exports `createLiveStateController`. Its host supplies one typed `source.open`
operation, a synchronous provider-owned event classifier/reducer, explicit item/byte limits and
exact event sizing. `open` receives `onEvent` before doing asynchronous work and resolves with a
snapshot only when every event after that snapshot's consistency point has already been or will be
delivered to that callback.

The controller owns finite pre-snapshot buffering, ordered drain, observable phases/counters,
duplicate/gap outcomes, generation fencing, subscriptions and explicit resync. It fails closed on
gaps, overflow and source loss. It never automatically retries, compares opaque cursors, replays
commands, validates schemas, stores events or claims that caller-owned work can be forcibly
cancelled. A separate snapshot request followed by subscription does not satisfy the source
contract; a single typed HTTP stream beginning with its snapshot does.

Socket.IO and HTTP remain different bindings over the same semantic boundary. Socket.IO can
establish subscription/room membership and acknowledge the matching snapshot; an HTTP response can
emit a validated snapshot as its first frame and subsequent events in that same response
generation. Existing renderers, React Query caches and managed resources may subscribe without
becoming dependencies of the controller.

## Consequences

- Applications share one race-free receiver state machine while retaining their own wire,
  authorization, schemas, cursors, storage and reducers.
- Physical reconnect and application resynchronization remain separate facts; a reconnected socket
  may still require a fresh source generation.
- Memory is explicit and finite before the snapshot boundary. Late work from retired generations
  cannot mutate current state, and non-cooperative source cleanup cannot hold controller settlement.
- The root remains browser-safe and peer-free. No second Socket.IO adapter, HTTP framing layer,
  React hook library, event database or process supervisor is introduced.

The external-store subscriber is synchronous. Async subscribers are removed on their first
thenable result so one unresolved rendering task cannot be retained per event. At most two
physical source open/cleanup operations in total may remain unsettled. Crossing that operation
bound publishes `unavailable/controller-capacity`; settlement publishes
`resync-required/controller-capacity` so the host can retry explicitly without a controller-owned
transport loop. Source cleanup is idempotent because AbortSignal and the returned close handle may
observe the same retirement.
