---
title: Composable bounded admission and operation leases
description: Composable bounded admission and operation leases with explicit ownership, bounds and published conformance evidence.
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 05:08 +00:00
pipeline: transport-primitives
order: 3
depends-on: —
---

## Зачем

Application admission in 0.67.0 gates readiness and tracks accepted/pending/completed operations. It does not itself express simultaneous global/per-key concurrency and rate budgets. Local clients, handlers and workers otherwise implement different counters and release paths.

## Результат

A generic process-local bounded admission mechanism composed with existing application admission, not a distributed lock service. Acquisition across declared budgets is atomic; refusal does not leak partial permits. The resource's actual lifetime, not just the caller's waiting promise, controls capacity release.

## Состояния

Admission: accepting → draining → closed. Acquisition: refused or leased → released, exactly once.
Caller outcome: waiting → completed/cancelled/timed-out. Underlying work may still be active after the caller's terminal outcome; its resource lease remains held until it actually settles.

## План

- [x] Inspect current application, agent-runtime and request-cancellation mechanisms and reuse their shared guarantees without importing agent/domain policy.
- [x] Specify global and per-key limits, bounded rate accounting, admission result/reason and idempotent release.
- [x] Specify monotonic/injected clock behavior; compute retryAfter only when a timed budget gives a real bound, never guess when another operation ends.
- [x] Make no-queue refusal the safe explicit mode; any optional queue must have its own finite capacity and cancellation semantics.
- [x] Compose with stopAdmission/drain/force and expose bounded, non-domain counters.
- [x] Validate non-cooperative work, synchronous throws, late completion and release races.

## Acceptance

- [x] Contending acquisitions never exceed any declared budget or leak permits after partial refusal.
- [x] Repeated release/cancel/timeout cannot underflow counters; rejected work does not consume unrelated quota.
- [x] Caller timeout does not free a still-running non-cancellable resource; the response can settle without corrupting resource accounting.
- [x] Per-key/rate registries are bounded and retired keys do not accumulate forever.
- [x] Drain refuses new work and observes real pending work; force behavior reports rather than pretends termination.
- [x] A bounded handler and an independent local worker exercise the published API in Bun/Node packed consumers.
- [x] API/ADR/migration, canonical full gates and installable release evidence are complete.

## Выполнено до публикации

- `createBoundedAdmission()` is exported by `stitchkit/application` with
  Zod-backed policy/snapshot contracts, simultaneous global/per-key concurrency,
  bounded rate registries and explicit reasoned refusals. There is deliberately
  no implicit queue.
- Acquisition is atomic across local budgets and optional upstream
  `ApplicationAdmission`; leases release exactly once. `run()` can settle the
  caller on timeout/cancellation while retaining capacity until the underlying
  work actually settles.
- `stopAdmission()`, `drain()` and `force()` expose the real active work rather
  than pretending that a caller timeout stopped it.

## Регрессия

`packages/core/tests/bounded-admission.test.ts`:

- `global and per-key permits are atomic and release exactly once`
- `rate windows give retryAfter and retire bounded key state`
- `an upstream refusal rolls every local reservation and rate sample back`
- `caller timeout settles without releasing non-cooperative underlying work`
- `sync throws release, refusal throws a reasoned run error`
- `drain waits for real work and force only reports what remains`
- `the existing application admission is an upstream readiness boundary`

The installed Bun fixture exercises an independent worker plus keyed
handler-shaped work; the Node fixture compiles and runs the same public exports.

## Release evidence

Published by `stitchkit@0.68.0` from
`8c64154f77aabce65f57948ab2c7cb29a0dcae34`. Registry integrity is
`sha512-tugTbOXIVyUu7js/HfdRunE6lc8/9fNMBureorJX5UA/nfkghT0avyG9E6Ej0a5+QnnlBngnj57z2y/BLCYhxA==`.
The API and composition recipes are in `docs/api/reference.md`,
`docs/guide/application-kernel.md` and
`docs/guide/application-migration-recipes.md`; the ownership decision is ADR
0118.
