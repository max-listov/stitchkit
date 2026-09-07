---
title: "ADR 0174: Runtime operations are durable run facts"
description: "Model requests and compaction update one last-operation record and publish post-CAS lifecycle events; structural stream boundaries checkpoint independently from delta batching."
type: decision
status: accepted
created: 2026-09-07
updated: 2026-09-07
---

# ADR 0174 — Runtime operations are durable run facts

## Context

`running` begins before prompt projection, tool preparation and the provider
call. A UI seeing only that state cannot truthfully distinguish local work from
a model request that is waiting for its first output. Transient deltas reveal
the end of that wait, but reconnect loses when it began. Consumer middleware
around the model would create a second lifecycle with different identities and
no canonical snapshot.

Assistant persistence had the inverse problem. `checkpointEveryEvents` bounded
ordinary stream writes, but tool calls, tool results, approvals and step ends
were not boundaries of their own. A consumer that needed recoverable tool
history therefore set the cadence to one and rewrote the growing assistant for
every metadata and delta part.

## Decision

`AgentRun.lastOperation` is the one durable current/last operation projection.
Its kind is `model-request` or `compaction`; its phase is `started`,
`first-output`, `completed`, `failed` or `cancelled`. It carries an operation
identity, the model step when applicable, and the original observed timestamps.
`AgentRuntimeStore.recordRunOperation` replaces that projection under the same
owner, fencing-token and revision checks as other run mutations.

Every successful mutation publishes a durable `run-operation` event. A model
request starts at the AI SDK callback immediately before provider `doStream`,
not at run acquisition and not as a claim that an HTTP request crossed the
network. Its identity combines the SDK call identity with the zero-based step,
because the SDK scopes one call identity to the whole managed generation. The
first-output phase requires the first non-empty text, reasoning or streaming
tool-argument delta, or a complete parsed tool call. Metadata, stream-start,
usage, files and sources do not qualify. Terminal phases never carry provider
error text.

Compaction starts immediately before the configured `compact` callback and
finishes from that invocation's result, cancellation or error. It means
"compaction callback / context preparation is running"; a `not_needed` result
does not claim that a summary was produced or stored. No event is invented when
no compactor is configured. A snapshot retains the last phase and its initial
timestamp, so reconnect never substitutes connection time.

Timestamps are wall-clock observations, not a causal clock and not durations.
NTP or an operator may move that clock backwards; schemas therefore validate
their form and phase presence but do not order them. Duration measurement, when
needed, uses the runtime's existing monotonic performance clock.

Assistant checkpoints retain their configured batching cadence for ordinary
parts. Independently, a tool call, tool result/error/denial, approval
request/response or step finish forces a checkpoint and resets the batch
counter. All live deltas are still published individually.

The structural checkpoint is awaited when the runtime observes the normalized
stream boundary. It is not a persist-before-effect guarantee: the AI SDK may
execute a tool before the consumer loop receives its result. The managed tool
fence remains the pre/post-effect ownership boundary, and application
idempotency remains necessary for crash-safe effects.

## Consequences

- A live surface can distinguish compaction, provider wait and streaming using
  the same schema it reloads after reconnect.
- One model run with tools has a distinct request identity per step without a
  second consumer event engine.
- Default batching writes proportional to batched stream parts plus structural
  boundaries, rather than one growing assistant record per delta.
- Custom `AgentRuntimeStore` implementations must add
  `recordRunOperation`; normalized driver implementations built through
  `createAgentRuntimeStore` receive the reference reducer automatically.
- The record is a latest-operation projection, not an audit log or a provider
  trace. Durable history beyond the latest fact remains an application outbox
  concern.
