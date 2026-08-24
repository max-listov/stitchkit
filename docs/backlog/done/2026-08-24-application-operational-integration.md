---
title: Typed application operational integration
description: Provide pull-based health/status composition and an injected OpenTelemetry bridge over canonical snapshots without creating a merged monitoring model.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 02:26 +00:00
related:
  - docs/decisions/0102-managed-application-kernel.md
  - docs/backlog/done/2026-08-23-application-operational-projection.md
---

# Typed application operational integration

## Зачем

Application, activity and schedule snapshots are individually canonical, but each consumer must
currently build the same health/status handler set and telemetry mapping. The integration is generic
only when it pulls those snapshots directly and never creates another state, revision or monitoring
store.

## Результат

- A small handler factory composes Fetch-clean `status | readiness | liveness` handlers from the
  existing application snapshot and existing health semantics.
- An optional `stitchkit/application/opentelemetry` entrypoint accepts an injected Meter and records
  bounded observable gauges by pulling canonical application/activity/schedule snapshots without
  choosing an exporter or SDK lifecycle.

## План

- [x] Compose status/readiness/liveness handlers without duplicating health semantics; status is an
      always-readable sanitized snapshot.
- [x] Map lifecycle, resource, admission, schedule and activity absolute facts to documented
      low-cardinality observable gauges with fixed names, units and descriptions. Never use
      additive counters over replayable snapshots.
- [x] Accept an injected Meter, register concurrency-safe pull callbacks and remove the exact
      callbacks on idempotent close; own no SDK/exporter lifecycle and isolate collection errors.
- [x] Allow only declared bounded IDs/states as attributes; exclude epoch, revision, timestamps,
      failures, provider/item/user identity and arbitrary metadata.
- [x] Add source, packed-bundle, type-only optional-peer and callback-cleanup regressions.
- [x] Update architecture, guide, API reference and package exports without reversing ADR 0102.

## Acceptance

- [x] Every collection pulls the latest validated canonical source snapshots; there is no composite
      cache, cursor, subscription, replay or freshness state to regress.
- [x] Duplicate collection and bridge recreation cannot double-count because every instrument is an
      observable gauge over an absolute value.
- [x] Telemetry attributes contain only bounded declared IDs/states, never item/provider/user data.
- [x] The neutral application entrypoint remains OpenTelemetry-peer-free; the adapter entrypoint
      has only a type-level optional `@opentelemetry/api` boundary and no runtime import.
- [x] Callback removal is exact and idempotent, and no exporter, monitoring backend, polling loop or
      durable metrics store enters Stitchkit.

## Что сделано

- `packages/core/src/application/health.ts` exports the three canonical Fetch-clean handlers.
- `packages/core/src/application/opentelemetry.ts` registers fixed pull-only observable gauges on
  an injected structural Meter and removes the exact callbacks on close.
- `stitchkit/application/opentelemetry` is an isolated export with a type-only optional
  `@opentelemetry/api` peer; the neutral application graph has no runtime or declaration leak.
- Exact regression coverage:
  - `packages/core/tests/application-health.test.ts` —
    `application operational handlers compose status and existing probe semantics`;
  - `packages/core/tests/application-opentelemetry.test.ts` — all six
    `OpenTelemetry adapter ...` cases for absolute snapshots, error isolation, recreation/cleanup,
    bounded declarations, pinned identities and registration rollback;
  - `packages/core/tests/optional-peer-matrix.test.mjs` — exact export coverage and forbidden
    runtime/type-only diagnostics;
  - packed `consumer-lane` case `application-opentelemetry` — zero runtime peers and only the
    declared type-level OpenTelemetry boundary.
- Focused tests, TypeScript check, package build and full packed consumer lane are green.
