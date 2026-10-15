---
title: "ADR 0258: Conversation branches have new identity and no inherited authority"
description: "A settled prefix or validated archive becomes an independent conversation through one atomic store operation with typed rekeying and durable lineage."
type: decision
status: accepted
created: 2026-10-15 07:39 +07:00
updated: 2026-10-15 07:39 +07:00
---

# ADR 0258 — Conversation branches have new identity and no inherited authority

**Invariants:** I3, I8, I12, I15.

## Context

An identity-preserving archive import restores the same conversation. It cannot create an
independent branch: event and artifact identities may be globally unique, and opaque storage
references cannot be rewritten safely by an application that does not own their format.

A branch is historical context, not an authorization transfer. Replaying old state-slot,
schedule, child or durability events under a new conversation can activate work or restore
authority the destination owner never granted.

## Decision

1. `branchConversation` belongs to the aggregate store. Its source read, validated clone, artifact
   writes and lineage receipt share one write transaction. The source is immutable.
2. An explicit `throughRunId` ends at its recorded terminal/abandon event; omitting it selects the
   complete settled tip, including later compaction. Every run in that prefix must be terminal.
   Hash-only drafts require a later full terminal message; missing content is refused.
3. Rekey only schema-owned identities and references. Collect definitions before resolving
   references, reject foreign IDs, and update content-addressed provider references with the
   bodies they address. Arbitrary application JSON is not an undocumented reference codec.
4. Preserve control facts under the inert `runtime/branch-observation` kind. No effect, schedule,
   child, projection, lease or signed approval capability is instantiated from them. Terminal
   normalized runs have no owner/fence. Artifact authorization comes explicitly from the
   destination owner, never from the source row.
5. `(destinationConversationId, requestKey)` identifies a request. Its stable fingerprint covers
   the selector and destination policy; archive requests also bind the supplied bytes. A retry
   returns the committed receipt even if the source tip subsequently advances. The receipt binds
   the first observed source sequence, version and digest. Conflicts never replace an existing
   conversation.
6. An archive must have contiguous events and exactly one matching runtime snapshot. Unknown
   opaque projections/provider forms, missing artifacts and unsupported versions fail before
   destination mutation. Supporting another format requires an owner-defined transfer codec,
   not a consumer-side structural JSON rewrite.

## Consequences

The existing identity-preserving `importConversation` remains useful for disaster restoration.
Independent copies use the branch primitive. Built-in memory and SQLite adapters share the same
planner and reducers; driver transactions provide rollback. The public conformance kit exercises
branch/restore and independent identity whenever an adapter advertises the optional capability.
