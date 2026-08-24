---
title: Managed application adoption hardening
description: Make the managed application kernel safer to bundle, test, migrate into and observe without expanding it into a durable job platform.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 02:36 +00:00
related:
  - docs/backlog/done/2026-08-23-managed-application-kernel.md
  - docs/decisions/0102-managed-application-kernel.md
---

# Managed application adoption hardening

## Зачем

The kernel is released, but adoption still has four generic costs: optional-peer bundle safety is
proved by scattered one-off checks, third-party resources have no reusable conformance suite,
migration recipes are mixed into the architecture guide, and operational consumers must compose
application/activity/schedule snapshots and telemetry by hand. These are framework mechanics, not
product policy.

## Результат

- Every public entrypoint has an explicit packed-bundle peer budget.
- Consumer-owned managed resources can run one deterministic black-box conformance suite.
- Migration recipes are executable against the packed package and keep domain/durable concerns in
  the application.
- Pull-based operational handlers and an optional injected OpenTelemetry bridge read canonical
  snapshots without creating a merged monitoring model.

## Декомпозиция

- [x] `application-optional-peer-bundle-matrix` (final package proof after new entrypoints land).
- [x] `managed-resource-conformance-kit`.
- [x] `application-migration-recipes`.
- [x] `application-operational-integration` (derived pull adapters only; no merged state model).

## Acceptance

- [x] All four child tasks are done with exact source, test and packed-consumer evidence.
- [x] Neutral entrypoints retain their minimal dependency budgets and provider adapters remain
      isolated.
- [x] No durable queue, retry/restart policy, provider workflow, deployment plane or monitoring
      backend enters core.
- [x] Public API/reference, guides, generated LLM docs, changelog and package exports agree.
- [x] Full `bun run verify` and two implementation validators are green. Release gates are recorded
      below and complete before the release tag is created.

## Конвейер 2/2

- [x] Plan validator 1: public API, ownership and consumer deletion value; narrowed operational
      scope, removed unsupported cleanup-idempotency and added declaration budgets.
- [x] Plan validator 2: bundle/test determinism, optional peers and operational semantics; defined
      pull-only telemetry, barrier/watchdog separation and full export-map coverage.
- [x] Implementation validator 1: CLEAN after the conformance driver distinguished watchdog expiry
      from ordinary adapter rejection, proved live-leak detection and made startup settlement
      race-safe.
- [x] Implementation validator 2: CLEAN after exact export-map coverage, failure-value preservation,
      pinned telemetry identities, rollback-safe callbacks and public consumer examples were
      verified.

## Что сделано

- The packed consumer lane now derives an exact optional-peer matrix from the public export map in
  `packages/core/scripts/consumer-lane/optional-peer-matrix.mjs`; its regression lives in
  `packages/core/tests/optional-peer-matrix.test.mjs`.
- `stitchkit/testing` exports the managed-resource conformance contract, deterministic driver and
  nine lifecycle scenarios from `packages/core/src/testing/managed-resource-conformance.ts`.
  `packages/core/tests/managed-resource-conformance.test.ts` proves the harness itself with ten
  cases, including live leaks, rollback, forced cleanup and rejected post-dispose work.
- Executable database, poller, queue and operational-publisher recipes live in the packed fixture
  `packages/core/scripts/consumer-lane/fixtures/minimal/src/application-migration-recipes.ts` and
  are explained in `docs/guide/application-migration-recipes.md`.
- `createApplicationOperationalHandlers` and the isolated
  `stitchkit/application/opentelemetry` bridge expose pull-based canonical snapshots without
  owning a monitoring backend. Exact behavior is covered by
  `packages/core/tests/application-health.test.ts` and
  `packages/core/tests/application-opentelemetry.test.ts`.

## Проверка

- Both conveyor 2/2 implementation validators returned CLEAN after their findings were fixed.
- `bun run verify` completed successfully on 2026-08-24, including lint, typecheck, unit tests,
  package build, Node smoke, packed consumer lanes and starter browser/production lanes.
