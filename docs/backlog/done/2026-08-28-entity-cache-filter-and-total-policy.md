---
title: Entity cache membership and pagination total policies
description: Allow declarative cache handlers to maintain filtered cursor lists without consumer mutation engines.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
---

# Entity cache membership and pagination total policies

## Evidence

In 0.68.0, `src/react/entity-cache.ts` exposes list key, shape, ordering,
createAt and updateMissing. `patchList` changes item arrays while preserving
all envelope metadata. There is no per-query membership predicate, nor an
explicit policy for adjusting a paginated `total`.

A cached filtered list `{status: 'open'}` must remove an item when an update
changes it to `closed`; matching a key prefix and replacing the item leaves a
nonmatching entity visible. Conversely, inserting into every filtered list is
incorrect. Creating/deleting items leaves a server-provided total unchanged.

## Result

Declarative optional policies for per-query membership and total reconciliation,
with explicit handling of unknown membership and unseen IDs. Do not blindly
increment totals on duplicate events. Preserve cursor and pageParams; do not
invent where an unseen item belongs in a partially loaded ordered list.
Invalidation is a valid declared policy when the delta lacks enough evidence.

## Acceptance

- [x] Filtered/unfiltered lists, enter/leave membership, duplicate create/delete,
  unseen IDs and multiple loaded cursor pages have regression coverage.
- [x] Existing callers retain envelope-preserving defaults.
- [x] Export/document the policy through `stitchkit/react`; verify packed consumer
  typings and publish a release.

## Что сделано

- `packages/core/src/react/entity-cache.ts` evaluates optional membership for
  every exact query under the list prefix, applies include/exclude mechanics,
  and preserves or invalidates unknown evidence by declaration.
- Paginated and infinite-paginated shapes reconcile numeric totals using a
  conservative duplicate-safe delta or an explicit evidence callback; unknown
  unseen IDs preserve or invalidate without guessing loaded-page placement.
- Exact regression coverage: `packages/core/tests/entity-cache.test.ts` —
  `moves an update across filtered query membership with an explicit total transition`,
  `deduplicates creates/deletes and invalidates an unknowable unseen delta`, and
  `updates multiple loaded cursor pages without moving page envelopes or pageParams`.
- ADR 0124, realtime guide, API reference, changelog and packed full-consumer
  typing proof document the additive policy.
