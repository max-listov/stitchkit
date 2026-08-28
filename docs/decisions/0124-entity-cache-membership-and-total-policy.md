---
title: "ADR 0124: Entity cache membership and total deltas are declared per query"
description: "Filtered cursor caches use explicit membership and evidence-aware total policies while preserving existing envelopes."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0124 — Entity cache membership and total deltas are declared per query

## Context

Replacing an entity by id cannot maintain a filtered list when an update moves
the entity across the filter. Cursor envelopes also commonly carry a `total`,
but a create/delete event does not always prove a delta: an unseen id may be a
duplicate or live on an unloaded page.

## Decision

- A list may evaluate `include | exclude | unknown` for each exact cached query
  key matched by its declared prefix.
- Unknown membership preserves by default and may invalidate that exact query.
- Paginated shapes may reconcile a numeric `total`. The built-in delta is
  conservative and deduplicates observed creates/deletes; a callback may state
  a transition only when the event carries stronger evidence.
- An unknown delta preserves by default and may invalidate. Cursor fields, page
  envelopes and `pageParams` are never rebuilt.

## Consequences

- Existing callers keep their current list and envelope behavior.
- Filter semantics stay application-owned but their mutation mechanics live in
  Stitchkit once.
- The framework does not guess that an unseen ordered item belongs on a loaded
  page; `updateMissing: 'insert'` and `createAt` remain explicit opt-ins.
