---
title: Application-owned durable async-operation harness
description: Prove how the shipped async-operation, application and agent-tool primitives compose around consumer-owned durable work without turning Stitchkit into a job platform.
type: task
status: done
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
---

## Зачем

Stitchkit already defines the transport surface for long-running operations and the process-local
application lifecycle. Real consumers still have to compose those primitives with durable
idempotency, leases, external-effect receipts, recovery and reconciliation that correctly remain
application-owned.

The current boundary is deliberate: Stitchkit must not become a distributed queue, provider
workflow engine or owner of domain job state. What is missing is an installable, executable proof
showing that the public seams are sufficient for a crash-safe consumer. Without that proof,
applications can independently rebuild a second generic runtime or incorrectly treat a timed-out
provider submission as safe to replay.

## Результат

- A generic headless example and packed-consumer fixture compose
  `defineAsyncOperationContract` / `defineAsyncOperation`,
  `createApplication`, `createBoundedAdmission`, managed resources and agent tool fencing
  around an application-owned operation store and injected provider.
- The fixture demonstrates idempotent admission, versioned ownership, external-effect receipt
  persistence, restart recovery, reconciliation and caller-safe terminal projection.
- The example keeps operation schemas, storage, retry policy, provider protocol, assets and
  effect idempotency outside Stitchkit. No reusable job database or distributed worker is added.
- If the shipped public APIs cannot express one concrete composition seam, only that reproduced
  generic seam is added with Bun and Node proof. Documentation-only sufficiency is an acceptable
  result.

## План

- [x] Audit the published async-operation, application, contract-stream, managed-file and
  agent-tool-fence APIs in a clean consumer; record exact imports and lifecycle ownership.
- [x] Define a minimal application-owned fixture store with explicit version/CAS, attempt identity,
  idempotency key plus request hash and an external-effect receipt. The fixture is proof data,
  not a framework store or public domain schema.
- [x] Exercise submit, duplicate submit, claim, progress, cancellation request, provider receipt,
  reconciliation and terminal result through the canonical async-operation surface.
- [x] Reproduce the ambiguous crash window: external submission may have happened but no terminal
  response was received. Recovery must reconcile from the stored receipt or remain unresolved;
  it must not blindly submit the paid effect again.
- [x] Compose an agent-triggered start with the existing tool fence so stale or repeated tool calls
  cannot bypass the application's idempotency boundary.
- [x] Prove shutdown ordering: admission closes, accepted work drains within the application budget,
  unresolved durable work remains recoverable and process-local close does not claim to cancel a
  remote effect.
- [x] Add packed Bun and Node checks using only public package entrypoints. Verify safe public
  failures and retained internal diagnostics without provider-specific names or credentials.
- [x] Update the guide, API reference and generated LLM documentation with the verified recipe and
  the explicit non-goals. Add a public API only for a demonstrated seam that cannot be composed
  from the current release.

## Acceptance

- [x] A clean installed consumer can run the example on Bun and Node without source aliases,
  private imports or optional peers unrelated to the chosen surface.
- [x] Repeating one idempotency key with the same normalized request returns the existing
  operation; a different request conflicts in the application-owned fixture.
- [x] A restart after possible external dispatch does not create a second effect and reports an
  unresolved or reconciled outcome honestly.
- [x] Status, wait, cancel, result and artifacts keep one schema identity and resource authorization
  on every follow-up capability.
- [x] Agent tool fencing and application idempotency are both present and documented as different
  guarantees.
- [x] No durable queue, provider workflow, asset catalog, retry policy or domain job state becomes
  framework-owned.
- [x] Full repository verification and packed consumer gates pass if implementation changes are
  required; documentation-only completion records the executable checks that proved sufficiency.

## Что сделано

- Added an executable application-owned harness with Zod records, transactional admission,
  expected-revision CAS, attempt/effect identity, progress, cancellation intent, provider receipts,
  reconciliation and explicit recovery of `possibly-dispatched` work.
- Composed canonical runtime/HTTP async-operation surfaces, bounded application admission,
  managed shutdown and agent tool fencing without adding a framework queue or domain model.
- Added a packed public-entrypoint composition executed on Bun and Node, guide/API reference
  coverage and regenerated `llms.txt` / `llms-full.txt`.
- `bun run verify` passed for tree `3cc967e117b8`.

## Регрессия

- `packages/core/tests/durable-async-operation-harness.test.ts` —
  `duplicate starts share one operation while a changed request hash conflicts`.
- `packages/core/tests/durable-async-operation-harness.test.ts` —
  `ambiguous dispatch is reconciled after restart and is never blindly resubmitted`.
- `packages/core/tests/durable-async-operation-harness.test.ts` —
  `progress and cancellation intent are durable while a provider attempt is active`.
