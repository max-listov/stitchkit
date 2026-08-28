---
title: "ADR 0127: Interrupt priority is durable execution order"
description: "Urgent input may interrupt and run next without deleting ordinary queued work; storage preserves both pending class and actual acquisition order."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0127 — Interrupt priority is durable execution order

## Context

FIFO `queue` and `interrupt` are correct defaults, but they cannot express one
common explicit action: A is running, ordinary B is waiting, urgent C interrupts
A and must execute before B. Putting C at the front of a process-local array is
insufficient. Durable admission, restart recovery and canonical prompt history
would still describe B before C, and a coalescing runtime could erase C's own
identity by attaching it to B.

## Decision

Add the opt-in input policy `interrupt-next`. It requests interruption of the
active run, waits for that run's real settlement, then selects the new input
before ordinary pending work. It never drops or re-admits the ordinary queue.
Urgent inputs are FIFO among themselves, and ordinary inputs remain FIFO among
themselves.

The run record owns two durable ordering facts. `queuePriority` records the
pending urgent class. `executionSequence` records the conversation head version
at the run's first successful acquisition. Snapshot ordering, active-run reads
and recovery use those facts before timestamp, history-position and identifier
fallbacks. The effective history is therefore A, C, B after execution even when
all three admissions shared a timestamp or a recovery scan split them across
pages.

An `interrupt-next` input does not coalesce into an ordinary pending run. Its
separate identity and priority are part of the requested behavior, while
ordinary coalescing and every existing policy retain their current defaults.

## Consequences

- Existing `queue`, `inject`, `interrupt` and `supersede` behavior is unchanged.
- Priority is explicit product policy; the core does not infer urgency from
  message contents, transport or business metadata.
- C cannot see B in its prompt, while B sees C's completed turn when it runs.
- Durable adapters need no new primitive or migration: the normalized run
  payload carries optional fields and old records use the stable fallback.
- The public store conformance kit proves the order for memory and third-party
  durable drivers, including restart pagination and equal timestamps.
