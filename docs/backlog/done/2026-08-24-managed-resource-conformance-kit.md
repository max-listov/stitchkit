---
title: Managed resource conformance kit
description: Export deterministic black-box lifecycle scenarios for consumer-owned ManagedResource adapters through stitchkit/testing.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 02:26 +00:00
related:
  - docs/decisions/0102-managed-application-kernel.md
  - docs/backlog/done/2026-08-23-application-public-proof.md
---

# Managed resource conformance kit

## Зачем

`defineManagedResource` is intentionally generic, but a consumer adapter can still mishandle
partial startup, readiness, shutdown races, missing cleanup or force. Repeating those scenarios
in every project recreates the lifecycle knowledge Stitchkit is meant to own.

## Результат

- `runManagedResourceConformance()` is exported from `stitchkit/testing`.
- A discriminated scenario factory gives the harness deterministic readiness/completion controls.
- Stable scenario IDs and normalized traces keep diagnostics independent of timestamps and UUIDs.

## План

- [x] Define a discriminated scenario factory that tests a real public `ManagedResource` inside
      `createApplication`; return `void` on success and throw a scenario/trace diagnostic on failure.
- [x] Cover clean shutdown, partial-start rollback, readiness rejection, completion-before-ready,
      required/optional late completion, activation rejection, shutdown during startup and force
      after stalled close. Assert framework cleanup-once; allow distinct force after unfinished close.
- [x] Use caller-controlled barriers and abort for semantic ordering. A real-time watchdog is only
      an emergency harness bound with a distinct timeout diagnostic.
- [x] Require fixture disposal so a broken adapter cannot leak work after any scenario.
- [x] Prove the harness against a correct fixture and intentionally broken fixtures.
- [x] Import and run it from a packed consumer.

## Acceptance

- [x] The conformance API is fully typed, cast-free and independent of Bun test globals.
- [x] Correct adapters pass; broken readiness/completion wiring, leaked startup and missing force
      fail for the intended scenario diagnostic.
- [x] Tests use controllable barriers rather than arbitrary sleeps.
- [x] The packed package exposes every public conformance type it names.

## Что сделано

- Public schemas, controls, fixture contract, normalized traces and the scenario runner live in
  `packages/core/src/testing/managed-resource-conformance*.ts` and are exported by
  `packages/core/src/testing.ts`.
- `packages/core/tests/managed-resource-conformance.test.ts` proves the complete correct fixture
  matrix in `accepts a correctly wired adapter across the canonical scenario matrix`, plus nine
  named regressions for readiness, completion, rollback, force, disposal, undefined rejection,
  empty selection, live-leak detection and post-dispose rejection settlement diagnostics.
- `packages/core/scripts/consumer-lane/fixtures/minimal/src/managed-resource-conformance.ts`
  imports every public signature it needs from the packed peer-free entrypoints and runs the full
  matrix; `packages/core/scripts/consumer-lane/run.mjs` requires its success marker.

## Проверка

- `bun --filter stitchkit check`
- `bun test packages/core/tests/managed-resource-conformance.test.ts` — 10 passed, 0 failed.
- `bun --filter stitchkit build` — emitted JavaScript/declarations and public-type checks passed.
- `bun --filter stitchkit consumer-lane` — all packed fixtures, the managed-resource conformance
  marker and the complete optional-peer matrix passed.
