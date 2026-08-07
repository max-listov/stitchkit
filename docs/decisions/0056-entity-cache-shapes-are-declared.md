---
title: "ADR 0056 — Entity cache shapes are declared"
description: CRUD cache handlers declare their envelope, projection, keys and mutation policies instead of inferring application semantics.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0056 — Entity cache shapes are declared

- **Status:** Accepted — extends the optional cache bridge without turning it
  into a domain cache framework
- **Date:** 2026-08-07

## Context

The original entity helper understood only `Paginated<T>` and
`InfiniteData<Paginated<T>>`, assumed list rows were full entities, used one
static list-key prefix and prepended every create. Real query caches also use
plain arrays and array-valued infinite pages. Scoped keys, projected list rows
and backend ordering therefore required a second hand-written CRUD updater.

Those differences are application policy. Inferring a workspace from a key,
deriving sort order from fields or rewriting totals would make the helper
domain-aware and silently corrupt cache metadata.

## Decision

Keep one `createEntityCacheHandlers<TData, TListItem>` API. Its list config
declares one of four shapes: array, paginated, infinite array pages or infinite
paginated pages. A built-in discriminant is sufficient; a separate public list
adapter would expose more machinery without expressing another behavior.

The config explicitly provides full-entity identity, list-item identity and
projection. Static keys remain the short path. Dynamic list/detail keys receive
one discriminated created/updated/deleted event, including the canonical id and
the original entity or deleted payload.

`createAt` selects the insertion edge/page. `updateMissing` explicitly chooses
skip or insert. An optional comparator is application-owned and applied after
create/update; Stitchkit never guesses backend ordering.

All operations preserve outer objects, `nextCursor`, page-specific metadata
and `pageParams`. Infinite insertion changes only the selected edge page.
Create deduplication and update/delete matching inspect every cached page.
Runtime shape checks leave other query values under an intentionally partial
list-key prefix untouched.

## Alternatives rejected

- **A generic read/write list adapter callback.** It exposes TanStack internals
  in every consumer config and becomes callback soup for four fixed shapes.
- **Keep the old helper beside a new one.** Two CRUD semantics would drift and
  make migrations ambiguous.
- **Infer shape from cached values.** Empty/missing caches are ambiguous and a
  malformed neighbouring query under a prefix would be patched incorrectly.
- **Update totals or cursor metadata.** Their meaning is endpoint-specific and
  cannot be derived from a socket event safely.

## Consequences

- One small declaration covers the representative real cache shapes.
- Projection and sorting remain typed and owned by the application.
- The config is intentionally more explicit; this is a pre-1.0 breaking change
  with one clean path and no compatibility shim.
- Arbitrary cache transformations continue to use TanStack Query directly.
