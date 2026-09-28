---
title: Change hints reconcile owned reads
description: Managed subscriptions and watched reads share coalescing while session and admission scopes fence delivery.
status: accepted
created: 2026-09-28
---

# Change hints reconcile owned reads

## Decision

A notification is a volatile hint, not proof of delivery. `changeSubscriptionResource`
connects and subscribes before reconciling a finite declared key set. Reconnect and
an explicit periodic interval both trigger authoritative reads. It shares one
internal coalesced-task implementation with `WatchHub`: one running read per key,
one trailing dirty pass and bounded backoff on failure.

Connection and read deadlines abort their generation. An adapter ignoring abort
remains owned until it settles; recovery must not silently overlap it. Publication
uses `ChangeReconciliation.commit`, which checks the originating connection.
Transport drivers own their protocol and subscription consistency boundary. A
PostgreSQL driver is consumer-owned; no database dependency enters this module.

A watch hub can attach a server-verified account/session/permission scope and its
revocation signal. The scope participates in internal sharing and is supplied to
`read`; it is never accepted as an authorization assertion from wire arguments.
A client session also adds an opaque instance nonce to `WatchKey`. This distinguishes
late frames on a reused transport; it grants no permissions. Existing unscoped
watches keep their wire shape. Scoped watches require both ends of this addition.

`CacheBridge` accepts explicit watched-handle/query-key bindings. Values use the
existing query cache; unavailable states invalidate without inventing empty data
or starting a second watch engine. Ending its session removes the bound queries.
Query keys must include the session scope. Existing watch state phases remain the
shared vocabulary; applications map them to presentation.

Invariants: I8, I10, I12, I13.
