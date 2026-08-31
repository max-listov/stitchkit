---
title: Conversation purge reserves identity atomically
description: Optional durable deletion removes runtime payloads and permanently fences a conversation ID in the same transaction.
type: decision
status: active
created: 2026-08-31
updated: 2026-08-31
---

# ADR 0138 — Conversation purge reserves identity atomically

- Status: Accepted
- Date: 2026-08-31

## Context

Runtime history is more than visible messages: normalized runs retain terminal assistants,
admission receipts retain input payloads, and compaction retains inactive SQLite rows. Removing
only the visible history neither deletes those payloads nor fences a queued or delayed writer.
Applications must not depend on private runtime tables to implement deletion.

## Decision

`AgentRuntimeStore.purgeConversation` is optional. `purgeAgentConversation` validates the request
and returns `unsupported` when the capability is absent. Custom stores retain source compatibility.
The normalized driver exposes optional `conversations` with transactional `isPurged` and `remove`.
Opting in requires serialization against every mutation, including creation of an absent ID;
head compare-and-swap without a shared lock cannot satisfy the capability contract.

Purge checks the optional expected snapshot version and refuses every nonterminal run. A successful
transaction removes all runtime-owned payloads, heads and derived indexes while retaining only an
ID tombstone. Purging an absent ID reserves it too. Repeating a successful deletion returns
`already_purged`, even with the original expected version; it is safe after a lost response.

Every runtime mutation checks the tombstone within its writing transaction and throws
`AgentConversationPurgedError`. The memory driver uses its serialized copy-on-write transaction;
SQLite uses `BEGIN IMMEDIATE`, rollback, and additive v1 tombstone/trigger initialization. Triggers
reject inserts/updates from already-open writers using the original v1 SQL. Older uninitialized
connections may read, but cannot claim the capability until opened with initialization.

Existing readers see empty snapshots or absent records; the catalog excludes purged conversations.
There is no ID reuse or tombstone deletion API. New chats use new opaque IDs. This is logical
payload deletion, not secure wiping of SQLite pages, WAL, backups, logs or remote provider history.

## Rejected alternatives

- Message-only deletion: leaves retained assistants, receipts and inactive history behind.
- Delete and reuse the ID: lets an old admission or lease silently recreate the conversation.
- Force-abandon inside purge: confuses deletion with authorization to interrupt live effects.
- Consumer SQL or filesystem deletion: couples clients to private schema and crosses ownership.
- Required store method: breaks valid custom adapters that do not need deletion.

## Consequences

The host authorizes deletion, closes ingress, settles or explicitly abandons active runs, and then
purges. Controller leases do not bypass store fencing. External attachment/model-selection/cache
cleanup is a consumer-owned retryable step after purge, not another transaction the library claims
to own. External effects already dispatched require their existing cancellation/idempotency policy.
Tombstones grow with deleted identities; removing them would invalidate the no-resurrection promise.
