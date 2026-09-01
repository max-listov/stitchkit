---
title: Generic application primitives declare facts, not infrastructure
description: Reusable values and policies share one browser-safe leaf while persistence, transactions and background execution remain application-owned.
type: decision
status: active
created: 2026-09-01
updated: 2026-09-01
---

# 0144 — Generic application primitives declare facts, not infrastructure

## Decision

`stitchkit/primitives` is a browser-safe leaf for facts an application can declare once and reuse
on both sides of its transport: finite lifecycle transitions, owner scope, permission decisions,
exact values, deadline projection, audit intent, domain-event routing and export result shape.

Every vocabulary remains application-owned. States, roles, operations, units, currencies,
categories, event types and destinations are literal strings supplied by the caller. The leaf
contains no ready-made business values and does not interpret a contract `scope` as a role or an
owner: scopes remain the transport authorization boundary, while permission and owner policies
answer different questions.

The infrastructure boundary is strict:

- a lifecycle returns the event to commit beside the application's state change;
- an audit declaration validates a change and produces that same event shape;
- event delivery plans destinations, but dispatches only an id claimed from an application-owned
  outbox after commit; each typed outcome invokes a distinct outbox transition, and an unknown
  outcome is held rather than retried by guess;
- a pending export carries an application operation id and a ready export carries a managed-file
  reference; generation and durable execution use the existing application-owned mechanisms;
- owner scope proves that intent reached the data adapter, not that an arbitrary ORM emitted a
  particular predicate.

There is no built-in database, transaction manager, scheduler, distributed lease, retry calendar,
document generator or transport. Adding one would turn reusable declarations into a second
application platform and conflict with the application-kernel boundary.

## Consequences

One declaration can drive server checks and client projections without copying policy. JSON-safe
exact values cross HTTP and browser boundaries without floating-point reinterpretation. Existing
applications can adopt each primitive independently because the leaf owns no process lifecycle.

The application must still persist state and event atomically, implement the outbox capability,
choose retry times, enforce the resolved owner scope in its data adapter and supply file bytes.
Stitchkit makes those obligations explicit and typed; it does not claim to perform them.
