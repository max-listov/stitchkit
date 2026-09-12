---
title: "ADR 0182: A durability port exposes step, sleep and wait over the store"
description: "Runtime-tool bodies checkpoint memoized steps and park on time or an external event through a swappable port; the local implementation sits on our store, and no workflow SDK is added as a dependency."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12T17:51+07:00
---

# ADR 0182 — A durability port exposes step, sleep and wait

## Decision

`createAgentRuntime({ durability: true })` provides optional `step`, `sleep`
and `waitFor` functions to runtime-tool handlers mounted with `mountAgent`.
A factory may supply a host-owned port instead; it receives the store,
conversation, run, tool name, tool call identity and abort signal. Plain mounts
without a runtime port leave these functions undefined.

The local implementation records JSON step results, sleep deadlines and event
deliveries in the canonical store ledger. The runtime scopes it by the tuple
of run id, tool name and tool call id. Standalone ports use the supplied runId
as their durable scope. Equal keys in distinct store objects never share
in-flight work. Incremental reads advance through the append-only ledger.

A completed step returns its recorded result on replay. The host must make
external effects idempotent: a crash between an effect and its result record
can repeat that effect. The port is not an exactly-once transaction across
arbitrary services, and it does not acquire a cross-process lease.

`sleep` holds a lightweight, unreferenced timer with bounded timer intervals;
`waitFor` holds a promise. These are local waits, not automatic process
suspension. Cancellation releases local waiters but preserves durable facts.
After a host observes the old executor has exited, it may call
`runtime.recover` with a replay-safe decision. Stable tool call identities are
required for replay to find the previous scope.

## External delivery

The host can supply `subscribe(wake)` when constructing the local port to wake
waiters after another process appends a delivery. The port reads the ledger
after subscribing, so a delivery racing registration is not lost. The returned
unsubscribe runs on every completion or cancellation. Without this notification,
external writes become visible on reconstruction; same-object-store `deliver`
wakes local waiters directly. No hidden polling or workflow SDK is installed.

## Validation

Step results are lossless JSON values. Non-finite numbers, negative zero, undefined,
sparse arrays, accessors and non-plain objects are refused rather than coerced by
JSON.stringify. Effect-only bodies return null explicitly. First execution and
replay return detached snapshots; consumer mutation cannot change the ledger or
the next replay. Validation happens after the body, so a rejected result cannot
roll back an external effect and does not replace host idempotency.

A child Bun process runs a real mounted runtime tool against SQLite and exits
after the first recorded step. A second process recovers the same run and
executes only the second effect. Separate tests cover store isolation,
concurrent deduplication, cancellation, corrupt records and ledger cursor reads.
