---
title: "ADR 0102: Application composition is process-local and provider-neutral"
description: Stitchkit composes application resources, schedules and operational truth inside one process while durable work, deployment and provider protocols stay outside core.
type: decision
status: accepted
created: 2026-08-23
updated: 2026-08-23
---

# ADR 0102 — Application composition is process-local and provider-neutral

## Context

The managed HTTP server and `bindProcessSignals` already provide a truthful
transport drain and one process-signal machine. Applications still repeat the
larger process boundary around them: dependency-aware startup, partial-start
rollback, readiness, non-HTTP admission, background timers, long-lived provider
completion, aggregate operational state and ordered resource close.

Those mechanics are generic, but the nearby concerns are not. A database
transaction, a durable job claim, a provider retry policy and a deployment
supervisor each have persistence or operational authority that a process-local
framework cannot infer. Folding them into one “application framework” would
hide distributed failure modes and compete with the established SDKs and
process managers Stitchkit is supposed to compose.

## Decision

Stitchkit adds the server-only `stitchkit/application` entrypoint. It owns one
process-local application kernel with:

- a validated resource dependency graph and stable topological order;
- explicit application, resource, readiness and health states;
- rollback of every resource whose start was attempted;
- one application admission gate and idempotent operation leases;
- bounded drain, reverse-order close and optional force under two absolute
  process-wide deadlines;
- periodic schedules that activate only after application readiness;
- absolute operational snapshots delivered through a latest-value sink; and
- sanitized lifecycle facts using the existing isolated sink patterns.

The application handle implements the existing process-signal target contract.
`bindProcessSignals(app)` therefore remains the only signal machine: the first
signal starts the cached shutdown, a later signal aborts that same chain, and
later escalation retains the released default-signal behavior. The framework
does not choose `process.exit`, an exit code or a supervisor policy.

Lifecycle and health are separate truths:

```text
created ──start──▶ starting ──required readiness──▶ ready
created ──shutdown──▶ stopping ──▶ stopped
starting ──required startup failure──▶ failed
starting / ready / failed ──shutdown──▶ draining ──▶ stopping ──▶ stopped | failed
ready ──required late completion──▶ ready (readiness false, health unhealthy)

health: unknown | healthy | degraded | unhealthy
```

An optional resource failure may leave the lifecycle `ready`, but changes
health to `degraded`. A required startup/readiness failure changes lifecycle and
health to `failed`/`unhealthy`. A required post-ready completion failure keeps
lifecycle `ready` — the kernel does not invent auto-shutdown or restart — but
removes readiness, closes admission and changes health to `unhealthy`. No failed
or stopped application may be restarted; construct a new application instance
instead.

Resource start is an attempted-start boundary. Once the kernel invokes a
resource's start/activate path, that resource is rollback-eligible even if the
operation rejects after creating partial state. Resource cleanup must therefore
be safe after rejected or aborted startup. A long-lived resource exposes
readiness separately from its observed completion; the kernel observes
completion immediately so a late rejection cannot become an unhandled promise.

Shutdown has phase barriers:

1. close application and resource admission;
2. cancel future schedule ticks;
3. drain all admitted work against one `graceDeadlineAt`;
4. close attempted resources once in reverse stable topological order;
5. when forced, invoke eligible force hooks concurrently against one
   `forceDeadlineAt`.

Both deadlines are computed once when shutdown begins. A repeated signal may
skip the remaining grace phase, but it cannot create a fresh timeout for each
resource or extend the force deadline.

Schedules are ephemeral resources. They support fixed-rate monotonic cadence,
an initial delay and explicit overlap policies: `skip`, `queue-one`, or bounded
`parallel`. They do not persist a cursor, recover missed ticks, retry work,
elect a leader, interpret cron/timezones or coordinate replicas.

Operational projection publishes full immutable snapshots. Stable declared
activity and stage identifiers are allowed; provider payloads, item identifiers,
tenant identifiers, arbitrary runtime text and metadata bags are not. A process
epoch and monotonic revision make resets and replacements explicit. Delivery
coalesces obsolete pending snapshots so a slow observer eventually receives the
latest absolute truth rather than reconstructing state from deltas.

Provider bridges are isolated optional entrypoints. The first bridge,
`stitchkit/application/grammy`, accepts an already-created grammY bot and wraps
provider-owned polling or webhook handling with application readiness,
admission and drain. It does not read tokens or environment variables, install
commands or middleware, send messages, choose retry plugins, persist updates or
reimplement the Telegram Bot API. Importing `stitchkit/application` never
resolves grammY.

Applications continue to own:

- durable queues, inboxes, schedules, claims, leases and restart recovery;
- idempotency, business transactions, external effects and domain retries;
- database/ORM implementations and provider configuration;
- provider commands, middleware, outbound APIs and payload models;
- process exit, hard-exit and deployment/supervisor policy; and
- monitoring backends, dashboards, registries and cross-process aggregation.

Deployment tooling continues to own PM2, systemd, Docker, release placement,
boot binding and host reconciliation. A deployment observer may consume an
application snapshot, but the application kernel does not import or control the
deployment plane.

## Consequences

- A small service declares resources and domain callbacks instead of carrying a
  signal loop, interval handles, admission counters and close fan-out.
- An established application can adopt the kernel one resource at a time
  without migrating its durable work or business storage.
- Existing unparameterized server signal types retain `ShutdownResult`; an
  application binding infers `ApplicationShutdownResult`.
- A managed-server adapter starts the existing server's idempotent shutdown
  once and awaits that same promise; it does not copy the HTTP lifecycle.
- Optional provider peers remain isolated from neutral package graphs.
- The application kernel is not a distributed job platform, provider framework,
  process manager or monitoring service.
- The current state/action model and public composition guidance live in
  [`docs/architecture/application-kernel.md`](../architecture/application-kernel.md)
  and [`docs/guide/application-kernel.md`](../guide/application-kernel.md).
