---
title: "ADR 0098: Agent conversations have one optional application runtime"
description: Stitchkit owns an opt-in process-local agent execution protocol while applications retain domain, transport and distributed-system ownership.
type: decision
status: accepted
created: 2026-08-22
updated: 2026-08-22
---

# ADR 0098 — Agent conversations have one optional application runtime

## Context

The existing agent surface projects contract operations into AI SDK tools. Real
applications still repeat a larger server-side layer: provider-valid message
history, model resolution, prompt budgeting, compaction, the multi-step stream
loop, durable checkpoints, keyed cancellation, managed-tool fencing, delivery
events and usage accounting. Independent implementations have diverged around
crash recovery and cancellation ordering.

ADR 0089 correctly rejects turning an async-operation descriptor into storage,
workers or a scheduler. A conversation runtime is a different boundary: it
coordinates one tool-using model execution and must make its message/run
transitions explicit to avoid losing inputs or accepting stale effects.

## Decision

Stitchkit adds a server-only, optional `stitchkit/agent-runtime` entrypoint. It
is not re-exported from the browser-safe root. The low-level `mountAgent` API
remains independently usable.

The runtime owns:

- versioned, Zod-first engine records and provider-valid history projection;
- one aggregate `AgentRuntimeStore` transaction boundary for message, run and
  compaction mutations;
- prompt/context budgeting and CAS-safe compaction mechanics;
- language-model registry mechanics and isolated provider adapters;
- a stream-first multi-step loop and stable application events;
- explicit process-local keyed coordination and managed-tool fencing;
- run observability and deterministic conformance probes.

Applications own domain prompts and tools, auth/tenant context, model allowlist
and default policy, ORM schema and store implementation, attachments/object
storage, transport presentation, UI, distributed leases and idempotency of
external business effects.

Durable order is:

```text
accept input + assign queued run (one transaction)
→ acquire run ownership
→ execute and checkpoint by expected run/revision
→ execution settles with no managed callbacks in flight
→ terminal CAS commits run + canonical assistant state
→ release lane ownership
→ admit successor
```

Abort requests cooperation; they are neither settlement nor a terminal state.
A stale tool fence is an internal control outcome, never a model-facing tool
failure. A transient delivery delta is speculative; checkpoint and terminal
events are emitted only after their matching CAS. Cross-process exactly-once
requires an application-provided lease/outbox and is not implied by the core.

## Consequences

- Consumers may replace several copied engines with one configuration and one
  persistence adapter instead of carrying a parallel runtime.
- Store implementations must provide atomic aggregate operations rather than
  expose independent message/run CRUD APIs.
- Provider-required opaque metadata may round-trip in a validated versioned
  envelope; it is not exposed to product delivery by default.
- A hung predecessor strictly blocks its process-local lane in the first
  version. Detachment cannot retain the single-owner guarantee.
- Durable human approval/resume and a media-generation catalog are outside the
  first version.
- The new entrypoint is additive. It becomes public only as a coherent package
  slice with Bun and Node packed-consumer proof.
- The current state/action table and failure guarantees are maintained in
  [`docs/architecture/agent-runtime.md`](../architecture/agent-runtime.md); API changes update that
  reference in the same pass.
- Durable delivery IDs, bounded event cursors/sinks and monotonic fencing tokens refine the original
  boundary without moving transport, outbox or distributed lease ownership into core.
