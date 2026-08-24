---
title: Managed application kernel and optional provider adapters
description: Add a process-local application composition layer for lifecycle, readiness, drain, schedules, state projection and thin provider adapters without turning Stitchkit into a distributed job platform.
type: task
status: done
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23 17:39 +00:00
related:
  - docs/decisions/0074-server-owned-managed-shutdown.md
  - docs/decisions/0076-explicit-process-signal-binding.md
  - docs/decisions/0089-async-operations-describe-transport-not-jobs.md
  - docs/decisions/0098-optional-agent-application-runtime.md
---

# Managed application kernel and optional provider adapters

## Зачем

Small and large Stitchkit consumers repeatedly hand-build the same process boundary around their
actual domain logic: resource startup and rollback, readiness, signal handling, admission stop,
queue drain, timers, provider retry/error policy, structured activity state and bounded shutdown.
The existing HTTP and process-signal primitives cover parts of that lifecycle, but an application
still has to compose databases, ingress adapters, queues and schedules independently.

Audits of multiple consuming applications confirmed independent copies of the same mechanics:
application phases, required readiness, admission leases, bounded drain, reverse close, periodic
timer ownership and absolute operational counters. The framework therefore needs one generic
application kernel. It must make a minimal service small without
absorbing its database, durable queue, business workflow or deployment platform. Provider SDKs stay
behind optional thin adapters: for Telegram, grammY remains the transport implementation rather
than being reimplemented inside Stitchkit.

## Архитектурное решение

Current Vision deliberately describes an optional application runtime rather than a generic job
platform. Before public API implementation, write an ADR and update the decision index/Vision to
draw the new boundary precisely:

- Stitchkit owns process-local composition, lifecycle truth, admission accounting and typed adapter
  boundaries;
- the application owns durable state, idempotency, distributed leases and business effects;
- provider adapters wrap established SDKs and do not fork their protocols;
- schedules and operational projections are framework primitives, but distributed execution is not;
- deployment/process-manager control (PM2, systemd, Docker, release placement) remains outside core.

## State model

The ADR must settle exact transitions and failure semantics before API naming. The minimum model is:

Lifecycle and health are separate truths:

```text
lifecycle: created → starting → ready → draining → stopping → stopped
                         └────→ failed ←──────────────┘
health:    unknown | healthy | degraded | unhealthy
```

Resource state and application state are separate. Optional degradation may leave lifecycle
`ready`, but top-level health is not `healthy`. Startup failure performs deterministic rollback of
every resource whose `start()` was invoked: resource cleanup must be safe after partial or rejected
startup. Shutdown always stops admission before drain and closes resources in reverse stable
topological order. A second termination signal keeps the existing forced-shutdown contract.

A resource may become ready before its long-lived completion settles. Its runtime handle therefore
separates `ready`, optional observed `completion`, health reporting, activation, admission stop,
drain, close and force. The kernel observes completion rejection immediately; a required post-ready
failure removes readiness and makes health unhealthy without inventing automatic restart policy.

## Public surface

The neutral server-only entrypoint is `stitchkit/application`. Schedules and projections stay in
that entrypoint because they are managed resources, not separate runtimes. The first provider bridge
is isolated at `stitchkit/application/grammy`; grammY is an optional peer and must never resolve when
only the neutral entrypoint is imported.

```ts
const app = createApplication({
  id: 'minimal-bot',
  resources: [
    defineManagedResource({
      id: 'database',
      start: async () => {
        await connectDatabase()
        return { ready: databaseReady }
      },
      close: disconnectDatabase,
    }),
    grammyPollingResource({
      id: 'telegram',
      bot,
      onError: reportProviderError,
    }),
    createManagedSchedule({
      id: 'cleanup',
      everyMs: 60_000,
      overlap: { mode: 'skip' },
      run: cleanup,
    }),
  ],
})

bindProcessSignals(app)
await app.start()
```

The application handle is a truthful generic `ShutdownTarget<ApplicationShutdownResult>`, not a
parallel signal machine. The existing server default result remains source-compatible. A generic
managed-resource contract covers dependency-aware start, readiness, stop-admission, bounded drain,
close and optional force. A managed server adapter starts its existing idempotent `shutdown()` at
stop-admission and awaits the same promise during drain rather than exposing server internals.

Schedules are ephemeral and process-local: they arm only after the application reaches `ready`, use
explicit `skip | queue-one | parallel`, bounded
`parallel.maxConcurrent`, no retries/backfill/cron/timezones, and cancellation of future ticks before
draining admitted executions. Operational projection stores immutable absolute snapshots with
process epoch, monotonic revision, captured time and aggregate stage counts. Its delivery is a
latest-value coalescing sink, not an event queue that can permanently drop the newest state. It never
accepts provider payloads, arbitrary runtime text or generic metadata bags.

The grammY bridge accepts an already-created bot. It owns polling/webhook admission, initialization,
in-flight update counting and drain. Commands, middleware, API retry plugins, token/env, outbound
messages, durable inbox/recovery and update idempotency remain application-owned.

## Результат

- A Zod-first application descriptor, exact transition table and explicit application/resource
  state snapshots.
- Deterministic startup, rollback, readiness/liveness, drain and graceful shutdown.
- Managed periodic schedules with overlap policy, cancellation and shutdown drain.
- Process-local typed activity/pipeline projection for counts and stages, with a generic sink.
- Sanitized lifecycle/operator events that compose with existing observability sinks.
- A thin optional grammY adapter covering polling/webhook admission, error hooks, update errors and
  drain while leaving commands and domain handlers application-owned.
- A generic operational-state projection that downstream observers can consume without any
  consumer-specific dashboard or monitoring dependency in Stitchkit.
- Packed Bun and Node consumers showing that a small service contains domain behavior rather than
  lifecycle boilerplate and that neutral imports remain provider-peer-free.

## Декомпозиция

- [x] `application-kernel-contract`: ADR, generic signal result, schemas, dependency graph and kernel.
- [x] `application-managed-schedules`: deterministic process-local schedule resource.
- [x] `application-operational-projection`: absolute activity and lifecycle event projection.
- [x] `application-grammy-adapter`: isolated polling/webhook provider bridge.
- [x] `application-public-proof`: resource adapters, guide/reference, packed Bun/Node proofs and
      optional-peer absence.

## План

- [x] Inventory and reuse existing HTTP lifecycle, `bindProcessSignals`, observability and agent
      runtime primitives; remove any proposed duplicate state machine.
- [x] Write ADR 0102, state/transition table, ownership boundary and compatibility plan; update the
      decisions index and Vision in the same change.
- [x] Generalize `ShutdownTarget`, `ProcessSignalsOptions` and `ProcessSignalsBinding` by result type
      while preserving the released server defaults and second-signal semantics.
- [x] Define Zod schemas and inferred types for application identity, lifecycle/health, managed
      resources, readiness, bounded drain, schedules and sanitized state projection.
- [x] Validate the resource DAG fail-first for duplicate IDs, missing dependencies and cycles.
- [x] Implement deterministic resource ordering, attempted-start rollback, long-lived completion,
      post-ready health, admission stop, drain, close/force and idempotent concurrent start/shutdown.
- [x] Provide a generic application operation lease and adapters for existing managed server and
      closable/drainable resources without duplicating their state machines.
- [x] Add managed schedule primitives with explicit overlap (`skip`, `queue-one`, `parallel`), error
      policy, bounded parallelism, post-readiness activation, injectable clock and cancellation
      semantics.
- [x] Add process-local typed activity/stage projection and a latest-value sink contract; snapshots
      are absolute state, not lossy increment/decrement events.
- [x] Integrate sanitized lifecycle events with existing bounded sink/trace patterns.
- [x] Implement the first optional grammY adapter as a thin adapter and document which concerns
      remain provider/application-owned.
- [x] Add Bun and Node packed-consumer tests for startup failure, readiness, signals, forced
      shutdown, timer overlap, provider update drain and optional-peer absence.
- [x] Publish a minimal service guide and migration guide for applications with existing manual
      lifecycle code.

## Acceptance

- [x] A minimal provider-driven service starts and stops through `createApplication` with no manual
      signal loop or resource-close fan-out.
- [x] Readiness becomes true only after every required resource is ready; optional degradation is
      explicit and never reported as healthy by default.
- [x] Partial startup failure closes every resource whose start was attempted, once, in deterministic
      order, including the resource whose start rejected after side effects.
- [x] Shutdown stops admission, drains bounded work, closes resources and remains safe when called
      repeatedly or concurrently with a process signal.
- [x] A second signal preserves the existing forced-exit semantics without a competing handler.
- [x] Schedule overlap and drain behavior are deterministic under fake time and real packed tests;
      no schedule runs before top-level readiness.
- [x] Operational snapshots contain stable identity, lifecycle, freshness and typed activity but no
      provider payloads, secrets or arbitrary business data.
- [x] The grammY adapter can be absent without affecting the core package graph and can be replaced
      by another ingress adapter without changing the application kernel.
- [x] Existing server/agent consumers remain source-compatible or receive an explicit migration and
      changelog entry.
- [x] Grace and force use two process-wide absolute deadlines; no resource receives a fresh timeout.
- [x] All five child tasks are done with exact evidence, `bun run verify` is green, both
      implementation validators are clean, and no commit, push or release was performed.

## Конвейер 2/2

- [x] Plan validator 1: lifecycle/state/API boundary.
- [x] Plan validator 2: consumer deletion value/provider/package boundary.
- [x] Implementation validator 1: state-machine races and shutdown truth.
- [x] Implementation validator 2: public API, optional peers, docs and packed consumers.

## Non-goals

- Reimplementing Telegram Bot API, grammY polling or webhook transport.
- A distributed queue, durable job database, workflow engine or lease coordinator.
- Automatic retry/backoff, restart recovery, backfill, cron/timezone or leader election.
- Owning ORM connections, business transactions, idempotency keys or domain retry semantics.
- A deployment/process manager, monitoring backend, dashboard or consumer registry.
- A universal set of product metrics or arbitrary text/status payloads.

## Что сделано

### Application kernel

- [x] Neutral public API and its modules are implemented in `packages/core/src/application.ts` and
      `packages/core/src/application/`; the optional provider boundary is isolated in
      `packages/core/src/application-grammy.ts`.
- [x] The current architecture and ownership boundary are canonical in
      `docs/decisions/0102-managed-application-kernel.md`,
      `docs/architecture/application-kernel.md`, `docs/guide/application-kernel.md` and
      `docs/api/reference.md`.
- [x] Child evidence is archived in
      `docs/backlog/done/2026-08-23-application-kernel-contract.md`,
      `docs/backlog/done/2026-08-23-application-managed-schedules.md`,
      `docs/backlog/done/2026-08-23-application-operational-projection.md`,
      `docs/backlog/done/2026-08-23-application-grammy-adapter.md` and
      `docs/backlog/done/2026-08-23-application-public-proof.md`.

### Конвейер 2/2 и gates

- [x] Two independent plan validators approved lifecycle/state/API and consumer/provider/package
      boundaries before implementation; two independent implementation validators returned `CLEAN`
      after race, shutdown-truth, public-surface, optional-peer, docs and packed-consumer review.
- [x] Регрессия: packages/core/tests/application-kernel.test.ts::keeps health, readiness and canonical admission truth synchronized after startup; packages/core/tests/application-kernel.test.ts::rejects startup when a required resource loses health during activation; packages/core/tests/application-kernel.test.ts::isolates synchronous and asynchronous snapshot observers from lifecycle work.
- [x] Регрессия: packages/core/tests/application-schedule.test.ts::queue-one collapses ticks to the latest successor and discards it on stop; packages/core/tests/application-activity.test.ts::delivers a blocked revision 1 followed by only the latest revision 100; packages/core/tests/application-grammy.test.ts::webhook admission drains an accepted update and rejects later updates.
- [x] `bun run verify` completed with exit `0` after the final implementation and public docs: lint,
      typechecks, 1532 core tests, 24 create-stitchkit tests, 40 repository script tests, build, Next
      SSR, Node smoke, packed minimal/full/Node/grammY consumers and both starter target/all browser
      lanes all passed.
- [x] After lifecycle closure, `packages/core/tests/docs-hygiene.test.ts` and repository lint passed
      against all six archived task files.
- [x] No release, deploy, Git index mutation, commit, push, tag or publication was performed.
