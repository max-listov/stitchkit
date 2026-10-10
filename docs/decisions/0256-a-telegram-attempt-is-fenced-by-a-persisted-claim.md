---
title: "ADR 0256: A Telegram attempt is fenced by a persisted claim"
description: "Attempt-aware Telegram intake uses a persisted globally unique claim identity for ownership checks, and keeps terminal delivery in the update row until exact acknowledgement."
type: decision
status: accepted
created: 2026-10-10 21:49 +07:00
updated: 2026-10-10 21:49 +07:00
---

# ADR 0256 — A Telegram attempt is fenced by a persisted claim

**Invariants:** I8, I9, I10, I13, I14. Amends ADR 0213's durable webhook intake.

## Context

A renewed lease prevents a second worker from taking an update while its owner is healthy, but it
cannot revoke work that the old handler already started. A domain write therefore needs an
ownership check inside the same database transaction as the write. The pair
`{ updateId, attempt }` is insufficient: after a settled row is pruned, the same `updateId` can be
recorded again and its attempt counter starts at one, allowing an old identity to match by accident.

A terminal handler failure has a second durability boundary. Reporting it through an observer and
then settling the update can lose the final obligation when the process dies between those steps.
Putting it in a second queue duplicates the update's identity and transaction owner.

The existing `handle(update)` also accepts direct grammY handlers. grammY may use an optional second
argument for its own webhook envelope, so passing framework attempt metadata there would silently
change an established call.

## Decision

1. **Attempt-aware handling is explicit.** Existing `handle(update)` stays unary and uses the base
   `TelegramUpdateStore`. A consumer that needs ownership metadata chooses `handleAttempt(update,
   context)` and a `TelegramUpdateFencedStore`; runtime validation rejects an unfenced store.
2. **A claim has a persisted, globally unique identity.** `claimOwned` returns
   `{ updateId, attempt, claimId }`. `claimId` is generated for every successful claim and stored
   with the row. `renewOwned`, `owns` and `settleOwned` compare all three fields, so neither a later
   attempt nor a pruned and recreated `updateId` can adopt an old capability.
3. **The database decides write authority.** `ownerLost` asks cooperative work to stop when renewal
   fails or the last proven lease expires. It is advisory. `owns(identity, at)` is the authority for
   a domain transition and runs inside that transition's transaction. PostgreSQL locks the update
   row with `FOR UPDATE`, so reclaim cannot pass between the ownership check and commit.
4. **Terminal delivery remains in the update row.** With `handleExhaustion`, `exhaust` atomically
   turns the exact live claim into an unacknowledged terminal record. Ordered cursor pages recover
   every such row after restart. Only `acknowledgeExhaustion` with the same full identity makes it
   prunable. Delivery is at least once, and the full identity is its idempotency key.
5. **The base contract remains source and storage compatible.** The original six methods and
   `TelegramUpdateStoreStep` do not grow. Legacy PostgreSQL `claim`, `renew` and `settle` do not
   reference the new column, so a `createTable: false` consumer can keep its old table while it uses
   `handle(update)`. Opting into a fenced method, `handleExhaustion`, or a base claim with
   `durableExhaustion: true` requires the generated schema migration. SQLite and auto-created
   PostgreSQL stores add `claim_id`; SQLite rechecks after a failed `ALTER` so two rolling processes
   may safely race the upgrade.
6. **One conformance check covers capability levels.** Base rules run for every store, fenced rules
   also run for a store without exhaustion methods, and durable rules add terminal persistence,
   exact acknowledgement and cursor paging. Positive and stale-identity controls cover expiry,
   reclaim, pruning and `updateId` reuse.

## Consequences

- Consumers that keep `handle(update)` need no code or database change.
- A custom attempt-aware store implements `claimOwned`, `renewOwned`, `owns` and `settleOwned`; a
  durable store additionally implements `exhaust`, `dueExhaustions` and
  `acknowledgeExhaustion`.
- A PostgreSQL consumer with `createTable: false` applies
  `postgresTelegramUpdateStoreSchema(table)` before enabling attempt-aware or exhaustion handling.
- `claimId` is opaque. Consumers persist the complete `{ updateId, attempt, claimId }` key and do
  not derive meaning from the token.
