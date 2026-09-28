---
title: Outbox actions and projections have separate receipts
description: An immutable action plan and its checkpoints live in the existing atomic notification outbox state.
status: accepted
created: 2026-09-28
---

# Outbox actions and projections have separate receipts

## Decision

A notification may opt into an immutable versioned plan captured at enqueue. Each
external action returns a JSON receipt and checkpoints under the current lease ID.
After all actions, an idempotent local projection receives those receipts and gets
its own completion timestamp. The final outbox receipt retains the plan and receipts
within the existing retention and byte bounds. Existing single-send notifications
retain their API and state shape; new fields are optional, never default-filled.

A projection failure retries the projection without re-sending confirmed actions.
A reclaimed lease refuses an old checkpoint. Each action gets a stable idempotency
key. A crash after remote success but before checkpoint is still ambiguous: delivery
is at-least-once, and the provider adapter must use idempotency or reconciliation.
A crash after projection but before its checkpoint can repeat that projection, so
it too must be idempotent. No exactly-once claim is made.

All state remains in the owning `StateStore.update` boundary; no second queue or
scheduler is introduced. Whole-state file/memory stores remain valid. This API does
not make enqueue atomic with an unrelated business transaction. Applications needing
that boundary retain their transactional adapter. Terminal handling uses the existing
classification and `onDropped` contract; durable quarantine is application-owned.
Plan version mismatch never invokes a different action executor silently.

Invariants: I3, I8, I10, I13.
