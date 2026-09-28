---
title: Session lifetimes fence client work
description: One captured login lifetime guards transport, refresh, persistence and final delivery.
status: accepted
created: 2026-09-28
---

# Session lifetimes fence client work

## Decision

A login lifetime is distinct from an authorization owner: signing into the same
account creates a new lifetime. `createSessionScope` owns that lifetime; a captured
operation owns an opaque instance ID, generation, cancellation signal and explicit
checks. Request attempts use `bindFetch`, complete asynchronous calls use `run`,
and the final synchronous state mutation or transport send uses `deliver`.
Neither cancellation nor freshness checks undo server-side effects.

`createSessionCredentials` uses the same scope, a refresh flight per generation,
and the neutral internal mutation queue also used by agent run mutations. Only
storage work enters that queue. Logout invalidates memory synchronously; ordered,
generation-checked writes and clears prevent an old operation from overwriting a
later successful login. Storage failures and capacity refusals remain caller-visible.
Refresh has a deadline and does not retry application commands. The host classifies
auth failures and owns any one-shot retry policy; `403` alone is not that policy.

The coordinator owns one client instance. Shared browser tabs, processes and secure
storage providers require their own locking/CAS contract. Contexts and credentials
must be treated as immutable. All credential writes must use this coordinator.

## Consequences

Existing clients and auth providers remain usable. Adoption replaces local lifetime
counters and refresh/storage coordinators; it does not introduce a second client,
RPC dispatcher, global auth store or provider-specific login policy.

Invariants: I8, I10, I12, I13.
