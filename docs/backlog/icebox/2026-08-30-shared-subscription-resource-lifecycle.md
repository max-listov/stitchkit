---
title: Share live subscriptions with explicit scope and bounded resource lifetime
description: Preserve the shared-subscription proposal until repeated consumers prove one safe compatibility key and lifecycle.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
pipeline: live-state-synchronization
order: 92
depends-on: —
defrost: Two working independent implementations repeat the same state transitions and bounded composite authorization, cursor, selector and ordering compatibility key.
---

## Зачем

Several views observing the same resource should not each open the same expensive provider
stream. A cached last snapshot also should not require keeping an upstream connection alive.
Applications repeat reference counts, idle retention and cancellation races.

This is a frozen intake proposal. Review whether a standalone resource primitive is justified
before adding an export; reuse existing application resources and emitter semantics.

## Current review disposition

Frozen pending repeated evidence. Sharing is valuable only when observers are genuinely
compatible; a wrong key can cross authorization scope, cursor generation, filters or ordering
requirements. Existing managed resources own process lifecycle, while individual consumers can
keep provider-specific sharing local until two implementations demonstrate the same safe state
machine and compatibility key.

The live-sync proofs may reveal this repetition. They do not assume sharing, and cached state
lifetime remains independent from upstream connection lifetime.

## Результат

An optional generic subscription resource shares compatible observers, starts on first retain
and cancels on last release, with an explicit optional grace period. Cached state lifetime is
separate from active connection lifetime. It works with a supplied start/cancel operation,
not only a specific socket or UI library.

The share key includes an application-provided authorization/scope partition and subscription
compatibility. Equal resource IDs alone are insufficient. Replay cursor, filters and ordering
requirements must either be compatible or create separate subscriptions.

## План

- [ ] Specify idle, opening, active, stopping, failed and disposed states, idempotent release,
      open failure, retry ownership and scope invalidation.
- [ ] Handle last release during asynchronous open: cancel/close the resource immediately if
      the open completes late; never let it become an unowned active stream.
- [ ] Bound active keys, observers and retained idle snapshots; make capacity refusal explicit.
- [ ] Keep zero-observer cache retention configurable and independent from provider connection.
- [ ] Fence late callbacks across reopening and key/auth changes.
- [ ] Isolate failing observers and delegate per-observer slow delivery to the queue policy,
      so one observer cannot stall or corrupt other observers.
- [ ] Provide headless usage and a React lifecycle recipe that tolerates repeated mount/unmount
      without making React or an application store a core dependency.

## Acceptance

- [ ] Concurrent compatible observers open one provider subscription; the last release closes it.
- [ ] Incompatible authorization partitions, cursors or selectors never share state accidentally.
- [ ] Release-before-open, open failure, immediate re-retain and repeated dispose leave no orphan.
- [ ] Resource/callback counts remain bounded under many keys and repeated mount cycles.
- [ ] Idle cache retention does not imply an active provider connection.
- [ ] Neither server authorization policy nor domain-specific selector/cursor semantics enter core.
