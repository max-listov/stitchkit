---
title: Managed application kernel architecture
description: Current process-local resource, readiness, shutdown, schedule, projection and provider-adapter model.
type: architecture
status: active
created: 2026-08-23
updated: 2026-08-23
---

# Managed application kernel architecture

The application kernel composes resources that live in one process. It extends
the existing managed-server and process-signal primitives; it does not replace
their transport state machines or add a worker control plane.

## Ownership boundary

| Stitchkit owns | Application/provider owns | Deployment plane owns |
|---|---|---|
| resource graph and lifecycle | durable records and recovery | process registration and placement |
| readiness and health projection | business health probes and effects | PM2/systemd/Docker control |
| process-local admission leases | distributed leases and idempotency | boot/restart/resource policy |
| bounded drain and close ordering | ORM transactions and queue claims | host logs and fleet aggregation |
| ephemeral periodic timers | cron/timezone/backfill semantics | scheduled units and external cron |
| aggregate operational snapshots | provider payloads and product metrics | monitoring backend/dashboard |

The boundary is mechanical: anything that must survive a process restart or
coordinate replicas requires application-owned durable state. Anything that
starts, places or replaces the process belongs to deployment tooling.

## Application state

`createApplication` creates one non-restartable state machine.

| Current | Action | Next | Required effect |
|---|---|---|---|
| `created` | `start()` | `starting` | validate the whole DAG before invoking a resource |
| `created` | `shutdown()` | `stopping` | close admission and return one terminal chain; no drain/resource is fabricated |
| `starting` | all required resources ready | `ready` | publish top-level readiness with application admission still closed |
| `starting` | required start/readiness failure | `failed` | roll back every attempted resource |
| `starting` | `shutdown()` | `draining` | cancel startup and roll back attempted resources |
| `ready` | activation completes | `ready` | open application admission only after every required activation succeeds |
| `ready` | required activation failure | `failed` | close readiness/admission and roll back every attempted resource |
| `ready` | optional resource failure | `ready` | health becomes `degraded` |
| `ready` | required resource completion failure | `ready` | readiness/admission false, health `unhealthy`; no auto-shutdown/restart |
| `ready` or `failed` | `shutdown()` | `draining` | return the one cached shutdown promise |
| `draining` | grace settles or force begins | `stopping` | close/force resources under the shared deadline |
| `stopping` | cleanup completes | `stopped` | retain complete cleanup truth in the result |
| `stopping` | cleanup remains incomplete | `failed` | retain every phase failure in the result |
| `failed` or `stopped` | `start()` | unchanged | reject; construct a new application instead |

Concurrent `start()` calls observe one start chain. Concurrent `shutdown()`
calls observe one shutdown chain. Shutdown wins a race with startup: no later
readiness callback can reopen admission or activate a schedule.

Health is derived separately:

- `unknown` before required readiness is known;
- `healthy` only when lifecycle is `ready` and every declared resource is
  healthy;
- `degraded` when lifecycle is `ready` and an optional resource is unavailable
  or unhealthy; and
- `unhealthy` when a required resource fails. Lifecycle independently removes
  readiness during drain/stop even if the remaining resources are still healthy.

Required resources cannot depend on optional resources. A failed dependency
blocks its dependants even when the failed dependency itself is optional.

## Resource model

`defineManagedResource` declares a stable ID, required/optional policy and
dependencies. DAG validation fails before any start for duplicate IDs, missing
dependencies, cycles and required-to-optional edges. Independent nodes use
declaration order as the stable topological tie-breaker.

The public resource state stays deliberately small:

```text
registered ─start─▶ starting ─ready─▶ ready
                    └─failure──────▶ failed
attempted ─shutdown─▶ stopping ─close─▶ stopped
                              └─failure─▶ failed
```

`activate`, `stopAdmission` and `drain` are ordered lifecycle phases, not extra
public resource states. This keeps the snapshot bounded while the shutdown
result preserves phase-specific failure codes.

Once start or activation is invoked, the resource is *attempted*. Attempted
resources must tolerate cleanup after a rejected or aborted start. Readiness is
an observed promise/state, not an assumption that `start()` returning means a
background loop is healthy. Optional long-lived completion is observed from
the moment it is created:

- rejection before readiness is a startup/readiness failure;
- rejection after readiness fails a required resource or degrades an optional
  one; and
- settlement during shutdown is recorded but cannot start a second cleanup
  chain.

Resource health reporting is explicit; the kernel does not poll providers or
invent probe intervals. Raw error causes go only to the configured internal
error/event sink. Public snapshots use bounded framework reason/status codes.

## Admission and drain

The application admission gate returns an idempotent operation lease. Acquiring
a lease is atomic with checking admission; releasing it twice is harmless.
Every accepted lease contributes to the application drain count. Provider and
domain resources may also keep narrower in-flight accounting, but they must not
admit new work after their `stopAdmission` phase.

Shutdown is a two-budget transaction:

```text
t0                              graceDeadlineAt              forceDeadlineAt
│ stop admission ─ drain ─ close │ force remaining resources │ terminal result
```

The deadlines are timestamps, not per-hook durations. Slow early cleanup
therefore consumes the same budget available to later cleanup. A second process
signal aborts the current grace chain and begins force on that same shutdown;
it never calls `shutdown()` again with a disconnected signal.

The application result contains application admission counts and per-resource
cleanup outcomes. It never manufactures HTTP request or WebSocket counters.
`managedServerResource` retains the real server shutdown promise: it starts the
existing shutdown once and every later phase awaits that exact promise.

## Managed schedules

`createManagedSchedule` produces an ordinary managed resource. Construction and
startup prepare the schedule, but its timer arms only after the application has
reached top-level readiness. Cadence is fixed-rate from the monotonic activation
anchor; wall-clock values are used only for snapshots.

Overlap is explicit:

| Policy | Due tick while work is active |
|---|---|
| `skip` | record a skipped tick; never overlap |
| `queue-one` | retain one non-admitted successor; additional ticks coalesce |
| `parallel` | admit up to `maxConcurrent`; overflow skips |

`continue` observes a run failure and leaves future ticks armed.
`stop-schedule` cancels future and queued ticks while allowing already admitted
executions to settle. Shutdown always cancels future ticks before drain; a
queued-one successor was not admitted and is discarded. Running callbacks see
the application shutdown signal, which aborts only when the shared chain is
forced.

There is deliberately no durable cursor, missed-run replay, automatic retry,
leader election, cron parser, timezone policy or cross-process mutex.

## Operational projection

`createActivityProjection` aggregates process-local activity by declared kind
and stage. Runtime operation tokens are anonymous and never serialize. A
terminal transition is idempotent; aggregate counts remain consistent under
concurrency.

Every snapshot is independently useful. `ApplicationSnapshot` contains stable
application/resource identity, process epoch, monotonic revision, timestamps,
lifecycle, health, readiness and admission counters. `ManagedScheduleStatus`
contains bounded timer state and counters. `ActivitySnapshot` contains its own
epoch/revision/timestamps and bounded aggregate
active/queued/completed/failed counts by declared stage. Consumers may publish
these absolute records together, but Stitchkit does not fabricate one merged
monitoring model.

It cannot contain item IDs, provider updates, tenant IDs, secrets, arbitrary
runtime messages or generic metadata bags. Declared IDs are configuration, not
runtime payload.

`createApplicationSnapshotSink` has one write in flight and one replaceable
pending value. Revisions 2…100 may coalesce while revision 1 is blocked, but
revision 100 remains deliverable and revision 2 cannot later overwrite it.
Activity-projection subscribers receive the current snapshot on attachment and
may feed that sink. Sink failure is isolated from application work and is
visible through sink status/drain truth.

Lifecycle events are separate sanitized observability facts. They help an
operator explain transitions, but canonical state is never reconstructed from
them.

`createApplicationOperationalHandlers` is only a Fetch-clean projection of the
same application snapshot and probe rules: status remains readable, readiness
tracks admission-capable readiness and liveness excludes failed/stopped
lifecycle. It retains no route state.

The isolated `stitchkit/application/opentelemetry` adapter accepts an injected
Meter and registers observable gauges over absolute values. Each collection
pulls and validates the current application, activity or schedule snapshot.
There is no merged envelope, revision cursor, replay cache, exporter, SDK
lifecycle or polling loop. Callback removal is exact and idempotent. Only
bounded declared IDs and framework states become attributes; process epochs,
revisions, timestamps, failures and product/provider identity do not.

## Optional grammY adapter

Only `stitchkit/application/grammy` resolves grammY. Both factories accept an
already-created bot; neither reads a token or environment variable.

`grammyPollingResource` starts grammY polling as an immediately observed
background promise. `onStart` settles resource readiness. Shutdown closes
admission, calls `bot.stop()` once and awaits the retained polling promise so
accepted middleware may finish. A polling rejection before or after readiness
is observed and projected without an unhandled rejection.

`createGrammyWebhookResource` initializes the bot and wraps provider-owned
update handling with resource-local admission and drain. It does not host HTTP,
parse Telegram requests, own webhook registration or retain update payloads.
An update admitted before shutdown may finish; one arriving after admission
closes is rejected by the resource.

Commands, middleware, `bot.catch`, retry plugins, outbound messages, durable
inboxes and update idempotency remain with grammY and the application.
