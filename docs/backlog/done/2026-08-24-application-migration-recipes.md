---
title: Executable application migration recipes
description: Give consumers tested recipes for databases, pollers, queue workers and operational publishing while preserving application-owned durable policy.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 02:13 +00:00
related:
  - docs/backlog/done/2026-08-23-managed-application-kernel.md
  - docs/guide/application-kernel.md
---

# Executable application migration recipes

## Зачем

The architecture guide explains each primitive, but a migrating consumer still has to reconstruct
how an existing database connection, long-running poller, queue consumer and snapshot publisher fit
together. Recipes must reduce bootstrap code without inventing provider packages or hiding durable
business semantics.

## Результат

- A focused migration/recipes guide shows before-to-after ownership and complete resource patterns.
- Database, poller, queue-consumer and operational-publisher examples execute against the packed
  public package.
- A migration checklist catches double signal handlers, duplicate timers/counters and parallel old
  lifecycle paths.

## План

- [x] Separate migration recipes from the application architecture guide and link both directions.
- [x] Add complete recipes for connection readiness/close, observed poller completion, queue
      admission/drain and latest-value snapshot publishing.
- [x] State exactly where transactions, durable claims, retry/idempotency and provider policy stay.
- [x] Make every documented recipe executable from one checked-in source path and run each from the
      packed package: partial database startup cleanup, poller completion before/after readiness,
      queue ingress after admission closes plus accepted drain, and slow publisher latest flush.
- [x] Document the deletion checklist and expected remaining product code.

## Acceptance

- [x] Every recipe compiles and runs from package exports, not source internals.
- [x] No recipe contains a second signal machine, timer overlap loop or generic in-flight counter.
- [x] Queue and database examples do not imply framework-owned durability or ORM policy.
- [x] The queue recipe handles shutdown after provider delivery/claim: rejected work is
      nacked/requeued by consumer/provider policy; accepted work drains under an application lease.
- [x] Guide/reference/generated LLM docs remain navigable and synchronized.

## Что сделано

- Added the canonical executable consumer source
  `packages/core/scripts/consumer-lane/fixtures/minimal/src/application-migration-recipes.ts` for
  database rollback, poller lifetime, queue admission/drain and latest-value publishing.
- Added `docs/guide/application-migration-recipes.md` with complete ownership boundaries and a
  deletion checklist; linked it from the application guide, docs index, API reference and generated
  LLM guide registry.
- Extended `packages/core/scripts/consumer-lane/run.mjs` to execute the recipes after installing the
  packed package and after the fixture typecheck/declaration gates.
- Verified with `bun run build` and the full packed consumer lane: all fixture families, the
  `minimal: application migration recipes` marker and the complete optional-peer matrix are green.
- Regenerated `packages/core/llms.txt` and `packages/core/llms-full.txt`; both include the new guide.
- `git diff --check` is clean.
