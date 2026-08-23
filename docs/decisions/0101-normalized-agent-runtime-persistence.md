---
title: "ADR 0101: Agent runtime persistence is bounded and normalized"
description: The reducer linearizes transitions through a constant-size head while runs and admissions remain addressable durable records.
type: decision
status: accepted
created: 2026-08-23
updated: 2026-08-23
---

# ADR 0101 — Agent runtime persistence is bounded and normalized

## Context

ADR 0100 moved transition policy into Stitchkit, but its first driver contract stored every run and
admission identity in one `AgentStoredState`. Each mutation therefore read, validated and rewrote a
payload that grew for the lifetime of the conversation. Recovery also required a synchronized copy
of active run descriptors.

Physical product-history compaction exposed a second coupling: a durable idempotent retry could
recover its input from archived history, but not its terminal assistant after that row was deleted.

## Decision

The persistence model has four independently mapped entities inside one adapter transaction:

- a constant-size head: schema version, conversation identity and monotonic runtime version;
- one canonical record per run, including revision, ownership, terminal outcome and an optional
  retained terminal assistant;
- one immutable admission receipt per `(conversationId, idempotencyKey)`, including the canonical
  input and assigned run/assistant identities;
- product-owned active history, mutated through the existing typed history operations.

The head CAS remains the per-conversation linearization point. After it wins, the affected run,
admission and history mutation are written in the same transaction. Drivers expose addressable run
and receipt operations but never implement state transitions. Recovery scans an index over active
run states; there is no second recoverable projection.

Snapshots include active runs and runs referenced by active history. A duplicate admission loads
its receipt and canonical run directly. Terminal duplicates use the assistant retained on the run,
so product history may physically delete both original input and assistant records.

This is a pre-1.0 clean cutover. `AgentStoredStateSchema`, `AgentAdmissionIdentitySchema`,
`history.loadById` and the driver `state` member are removed without a compatibility path.

## Consequences

- Head CAS payload size is independent of lifetime run/admission count.
- Admission and run uniqueness use database keys instead of array scans.
- Recovery is one indexed run-state query and cannot drift from canonical run state.
- Durable idempotency data deliberately outlives product-history compaction; retention policy must
  delete compatible admission/run records together after the idempotency horizon.
- Physical table count and ORM remain adapter choices. A product conversation row may host the
  head, and existing message tables may host active history.
- Adapters must migrate the old aggregate before cutover and pass the shared conformance suite.
