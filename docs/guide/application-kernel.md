---
title: Managed application kernel
description: Compose process-local resources, schedules, readiness, drain and optional provider adapters without building a second job platform.
type: architecture
status: active
created: 2026-08-23
updated: 2026-08-23
---

# Managed application kernel

> **Maturity: evolving.** This surface is still finding its shape and may be
> redefined in any minor release — always with a `### ⚠️ Breaking changes` entry
> and a migration section, never silently. The server, contract and client
> surfaces it composes are stable.

Use `stitchkit/application` when several process-local resources must become
ready and shut down as one application. Keep using the lower-level server and
signal APIs when one managed server is already the complete lifecycle boundary.

The neutral entrypoint is server-only and works on Bun and Node ≥ 22. It does
not import provider SDKs.

For complete database, poller, queue-consumer and operational-publisher
cutovers, continue with the executable
[application migration recipes](./application-migration-recipes.md).

## Minimal composition

```ts
import {
  createApplication,
  createManagedSchedule,
  defineManagedResource,
  managedServerResource,
} from 'stitchkit/application'
import { bindProcessSignals } from 'stitchkit/server'

const database = defineManagedResource({
  id: 'database',
  required: true,
  start: async ({ signal, reportHealth }) => {
    await db.connect({ signal })
    reportHealth('healthy')
  },
  close: () => db.disconnect(),
})

const cleanup = createManagedSchedule({
  id: 'cleanup',
  dependsOn: ['database'],
  everyMs: 60_000,
  startAfterMs: 60_000,
  overlap: { mode: 'skip' },
  errorPolicy: 'continue',
  run: ({ signal }) => removeExpiredRecords(signal),
})

const http = managedServerResource({
  id: 'http',
  dependsOn: [database],
  // Called during `start`, after `database` is ready — which is how "bind the
  // port once the database is up" is expressed. Pass an already-running server
  // instead when the application created it itself.
  server: () => createServer({ port: env.PORT, services }),
})

const app = createApplication({
  id: 'service',
  resources: [database, http, cleanup],
  // One number for how long this application may take to stop. `shutdown()`
  // with no options and the signal path both spend it.
  shutdown: { gracePeriodMs: 30_000, forceTimeoutMs: 5_000 },
})

const signals = bindProcessSignals(app, {
  onComplete: (result) => {
    process.exitCode = result.outcome === 'clean' ? 0 : 1
  },
})

await app.start()
```

The exact resource callbacks are typed by their public configuration. The
important ownership rule is stable: the application decides what the
database/server/provider objects are and how they are configured; Stitchkit
orders their process-local lifecycle and decides *when* they come into
existence.

## Resource authoring

Give every resource a stable, bounded ID and list its dependencies explicitly.
The graph is validated before any start. Required resources may depend only on
required resources; an optional integration cannot silently become a required
dependency.

Start and readiness are different. A connection can finish setup and return a
ready handle. A poller can return a handle immediately, settle `ready` later,
and keep a long-lived `completion` promise. Stitchkit observes both.

Once Stitchkit invokes start/activation, cleanup is guaranteed to be attempted.
Write `close` so it is safe when setup was partial:

```ts
let cacheClient: CacheClient | undefined

const cache = defineManagedResource({
  id: 'cache',
  required: false,
  start: async ({ signal, reportHealth }) => {
    cacheClient = new CacheClient()
    await cacheClient.connect(signal)
    reportHealth('healthy')
  },
  close: async () => {
    await cacheClient?.close()
    cacheClient = undefined
  },
})
```

Invoking `start` makes the descriptor rollback-eligible immediately. Its
`close` callback must therefore clean side effects even when `start` rejects
before returning a runtime handle. The kernel calls cleanup once and continues
cleaning other attempted resources even if one close fails.

### Handing a resource to the resources that depend on it

`dependsOn` says *when*. To say *what*, return a `value` from `start` and read
it with `context.use(...)`:

```ts
const database = defineManagedResource({
  id: 'database',
  start: async ({ signal }) => ({ value: await connect(env.DATABASE_URL, signal) }),
})

const worker = defineManagedResource({
  id: 'worker',
  dependsOn: [database],
  start: (context) => {
    const db = context.use(database)   // Connection — not Connection | null
    return { completion: consume(db, context.signal) }
  },
})
```

Declare the dependency with the **resource**, not its id, whenever you intend to
read from it: that is the form `use` can type, and it keeps the declaration and
the read from drifting apart. A string still works when all you need is order.

The value is published when `start` resolves and stays readable for the rest of
the application's life — from `activate` and from the shutdown phases too, where
a dependant may still need the handle it was given.

`use` refuses two things, both loudly: a resource that was never declared in
`dependsOn` (it happens to work whenever declaration order is lucky), and a
resource that published nothing. The second is refused by the compiler as well —
reading a value off a resource with no `value` in its `start` does not type.

## Readiness and health

`await app.start()` resolves only after every required resource is ready and
every required post-ready activation has succeeded. Lifecycle `ready` is
published before activation so schedules never arm during `starting`;
application admission opens only after successful activation. Optional failure
may retain lifecycle `ready`, but snapshot health is `degraded`, never
`healthy`.

Readiness is not hidden polling. A resource reports health changes through its
lifecycle context; the application decides when a database/provider probe runs.

**A `reportHealth` call inside `start` is kept.** A resource that says nothing
is assumed healthy once it is ready; one that reports its own health has already
answered the question, and the answer stands. (It used to be overwritten — and
the example above hides that, because `healthy` is the same value that
overwrote it.)

**A resource is required unless you write `required: false`.** That default is
what makes the next sentence bite.

**Readiness requires every required resource to be healthy**, so "ready but
degraded" is unreachable for a required resource by construction: an
application whose required resource reports anything but `healthy` refuses to
start, and says which resource and in what state. The refusal distinguishes the
two ways to get there — a resource that was never healthy is pointed at
`required: false`; one that was healthy and stopped is pointed at
`onResourceFailure`. A resource that is *expected* to start
degraded — up, but still dialling something external — belongs behind
`required: false`, where it keeps its own health and does not gate the
application:

```ts
defineManagedResource({
  id: 'dialling',
  required: false,
  start: ({ reportHealth }) => { reportHealth('degraded') },
})
```

An optional resource reporting non-healthy does not gate readiness, but it does
move the application **aggregate** to `degraded` — which a readiness endpoint
mapping `degraded` to non-200 will notice.

If startup fails, every resource that was already started is closed in reverse
order. The rollback runs **one** phase — `close` — not the five a real shutdown
runs, and `close` receives the same deadlines a shutdown would give it, so a
server drains what is in flight instead of aborting it.

Those deadlines come from the application's declared budget, and it is worth
knowing what they cost. With nothing in flight the rollback returns at once: a
grace period is a ceiling, not a sleep. With something in flight it waits for
it — that is the point — and with something that **never finishes**, a hung
upstream or a client that ignores a close frame, it waits out the whole budget
before forcing. Under the default 30s+5s that turns a failed `start()` that used
to reject in milliseconds into one that can take 35 seconds to reject.

An application that would rather hear about a broken start immediately says so,
in the one place both stopping paths read:

```ts
createApplication({
  id: 'app',
  resources,
  // Applies to `shutdown()` called with no options AND to the rollback of a
  // failed `start()`, which has no call site of its own to be told.
  shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },
})
```

The budget is a real bound, not just a number handed to each resource: a `close`
that never returns is abandoned when the budget runs out, reported as a `close`
failure, and the startup error stays the `cause` of the `AggregateError` that
`start()` rejects with. Without that, one unresponsive resource could keep a
failed startup from ever reporting why it failed.

A required long-lived completion that rejects after startup makes readiness
false and health unhealthy. Stitchkit records the failure but does not restart
the resource or process.

`ApplicationResourceShutdown.failures` names the phase that failed — `start`,
`ready`, `completion`, `admission`, `drain`, `close`, `force` — and nothing
else. To learn *why*, pass `onResourceFailure`:

```ts
createApplication({
  id: 'app',
  resources,
  onResourceFailure: ({ resourceId, phase, error }) => {
    log.error({ resourceId, phase, err: error }, 'managed resource failed')
  },
})
```

It fires for every phase, including the one place the cause would otherwise be
lost entirely: an **optional** resource failing to start. A required one
rethrows, so its cause reaches you anyway; an optional one is swallowed on
purpose, because the application keeps running. A throwing observer cannot
break the lifecycle it observes.

`createApplicationHealthHandler` publishes an `ApplicationStatusProjection`
through a Fetch-compatible handler, suitable for a raw route on Bun or Node.
The projection carries the verdict — the application's own `id`, `lifecycle`,
`health`, `ready`, `capturedAt` and resource **counts** — and never the internal
topology: no per-resource ids, no `dependsOn` edges, no process `epoch`, no
admission counters.
Those stay in `getSnapshot()`, which never leaves the process, and in whatever
telemetry you wire to it. Product-specific probes may be composed beside it; do
not put secrets or raw provider failures in the response.

For the conventional three-route surface, reuse the same semantics instead of
copying them into the application:

```ts
const operational = createApplicationOperationalHandlers(app)

const rawRoutes = [
  { method: 'GET', path: '/status', handler: operational.status },
  { method: 'GET', path: '/ready', handler: operational.readiness },
  { method: 'GET', path: '/live', handler: operational.liveness },
]
```

`status` always returns the current published projection with HTTP 200,
including while starting, draining or stopped. To read the full snapshot — every
resource, its dependency edges and the live counters — call `app.getSnapshot()`
in-process; there is no option that publishes it over HTTP, because these routes
are meant to be reachable. The two probes retain the existing
readiness/liveness status and `Retry-After` policy.

Applications that already own an OpenTelemetry SDK may inject its `Meter` into
the isolated adapter:

```ts
import { createApplicationOpenTelemetry } from 'stitchkit/application/opentelemetry'

const telemetry = createApplicationOpenTelemetry({
  meter,
  application: app,
  activities: [activity],
  schedules: [schedule],
})

// During application cleanup:
telemetry.close()
```

The adapter registers fixed observable gauges and pulls the latest canonical
snapshots on every collection. It owns no exporter, SDK lifecycle, cache,
subscription or polling loop. Attributes are limited to declared application,
resource, activity, stage and schedule IDs plus bounded framework states;
epoch, revision, timestamps, failures and product/provider identities are never
metric attributes. Install `@opentelemetry/api` only when this entrypoint is
used; the neutral `stitchkit/application` graph remains peer-free.

Every instrument uses unit `1` and reports an absolute current/lifetime value:

| Instruments | Meaning |
|---|---|
| `stitchkit.application.lifecycle`, `.ready` | current lifecycle/health fact and readiness |
| `stitchkit.application.admission.accepting`, `.accepted`, `.completed`, `.pending` | current gate and absolute lifetime admission counts |
| `stitchkit.application.resource.ready` | readiness for each declared resource with required/state/health attributes |
| `stitchkit.application.schedule.accepting`, `.active`, `.queued`, `.runs_started`, `.runs_completed`, `.runs_failed`, `.ticks_skipped` | current schedule state and absolute run/tick counts |
| `stitchkit.application.activity.active`, `.queued`, `.completed`, `.failed` | absolute stage projections for declared activity sources |

## Admission and graceful shutdown

Use the application operation lease for work that is not already counted by a
managed resource:

```ts
const operation = app.admission.acquire()
if (!operation) return Response.json({ error: 'unavailable' }, { status: 503 })

try {
  await performAcceptedWork()
} finally {
  operation.release()
}
```

`release()` is idempotent. Admission and counter increment are atomic, so work
cannot slip between the shutdown check and drain accounting.

### Bounded operation admission

Compose `createBoundedAdmission` when accepted work also competes for a finite
process-local resource:

```ts
const generations = createBoundedAdmission({
  upstream: app.admission,
  policy: {
    global: { maxConcurrent: 8, rate: { limit: 120, intervalMs: 60_000 } },
    perKey: { maxConcurrent: 1, maxKeys: 2_000 },
  },
})

await generations.run(accountId, ({ signal }) => generate({ signal }), {
  signal: request.signal,
  timeoutMs: 30_000,
})
```

Acquisition is no-queue and atomic across every configured budget. Refusal names
the exact bound; only a rate refusal carries `retryAfterMs`. `maxKeys` keeps the
per-key registry finite, and expired idle entries are retired.

The caller timeout is a wait budget, not proof that the resource stopped. It
aborts the signal and settles the caller, but the lease remains active until the
underlying Promise actually settles. `drain()` therefore reports real work;
`force()` closes admission and reports remaining work without claiming to have
terminated it. → ADR 0118.

### Bounded delivery and byte credit

`createBoundedChannel` is for one asynchronous reader when an event bus is not a
queue:

```ts
const output = createBoundedChannel<string>({
  policy: 'ordered',
  maxItems: 64,
  maxBytes: 256 * 1024,
  sizeOf: (value) => new TextEncoder().encode(value).byteLength,
})

const progress = createBoundedChannel<{ revision: number }>({
  policy: 'latest',
  maxItems: 1,
  maxBytes: 128,
  sizeOf: () => 128,
})
```

`ordered` never overwrites accepted values; overflow is a reasoned refusal.
`latest` retains exactly one pending replaceable value and reports
`coalesced`. Offers never create a hidden writer queue, and only one `next()` may
wait. Close chooses `drain` (default) or `discard`; abort discards; failure
rejects the parked and all later reads.

`createCreditWindow({ capacityBytes })` is the smaller primitive for a protocol
that already owns its queue but needs exact byte permission. Each credit lease
replenishes once; it is flow-control credit, not a durable acknowledgement. The
application snapshot sink now shares the same latest-value mechanics without
changing its revision or status contract. → ADR 0119.

Shutdown performs one phase barrier at a time: stop admission everywhere,
cancel future schedules, drain admitted work, then close in reverse stable
topological order. Every hook shares the same grace deadline. Forced cleanup
shares one force deadline. Repeated `shutdown()` calls return the cached promise;
a repeated process signal forces that same chain.

Do not add a second `process.on('SIGTERM')` handler around the application.
`bindProcessSignals(app)` is the force/escalation owner. Exit code and hard-exit
policy remain application/supervisor choices.

**Where the budget comes from on the signal path.** `bindProcessSignals(app)`
with no `shutdown` forwards nothing, so the application spends the budget it
declared in `createApplication({ shutdown })`. Pass `shutdown` to the binding
only to override that budget for signals specifically; passing one key overrides
that key alone and leaves the other at the declaration. Declare the budget once,
on the application — repeating it in both places is how the two numbers start to
disagree, and the operator's supervisor timeout is calculated from the one they
can read.

## Managed schedules

Schedules activate only after top-level readiness:

```ts
createManagedSchedule({
  id: 'reconcile',
  everyMs: 5_000,
  startAfterMs: 0,
  overlap: { mode: 'queue-one' },
  errorPolicy: 'continue',
  onError: (error) => internalLogger.error(error),
  run: ({ signal }) => reconcile(signal),
})
```

- `skip` ignores a due tick while one execution is active.
- `queue-one` retains one successor; additional due ticks coalesce.
- `parallel` requires `maxConcurrent`; overflow skips rather than creating a
  hidden queue.

The callback receives the application shutdown signal. Normal shutdown waits
for admitted executions; force aborts the shared signal. There are no retries,
cron/timezone rules, persisted cursors, backfill or cross-process locks. Put
those semantics in a durable application scheduler when they are required.
Schedule cadence stays monotonic, while status snapshots expose ISO wall-clock
`capturedAt`, `changedAt` and next/last-run timestamps for portable observation.

## Operational projection

Declare aggregate activity stages, then update them with anonymous handles:

```ts
const generations = createActivityProjection({
  id: 'generation',
  stages: ['queued', 'running', 'finalizing'],
})

const activity = generations.open('queued', 'queued')
generations.transition(activity, { stage: 'running', state: 'active' })
generations.transition(activity, { stage: 'finalizing', state: 'active' })
generations.complete(activity)
```

Item identity is deliberately absent from the snapshot. Observers receive
aggregate counts with application identity, process epoch, revision and
timestamps. Calling a terminal method twice does not double-count.

```ts
const sink = createApplicationSnapshotSink({
  write: (snapshot) => publishOperationalSnapshot(snapshot),
})

const unsubscribe = generations.subscribe((snapshot) => {
  sink.publish(snapshot)
})

// During application cleanup:
unsubscribe()
await sink.close()
```

The sink replays the current absolute value and coalesces obsolete pending
revisions behind a slow write. Sink failure is observable but cannot fail the
application operation that changed the projection.

## Optional grammY adapter

Install grammY only in an application that imports the adapter:

```ts
import { Bot } from 'grammy'
import {
  createGrammyWebhookResource,
  grammyPollingResource,
} from 'stitchkit/application/grammy'
```

For simple long polling, pass an already-configured bot:

```ts
const bot = new Bot(env.BOT_TOKEN)
bot.command('start', (ctx) => ctx.reply('Hello'))
bot.catch(({ error }) => internalLogger.error(error))

const telegram = grammyPollingResource({
  id: 'telegram',
  bot,
  required: true,
})
```

Readiness follows grammY's `onStart`. Shutdown calls `bot.stop()` once and then
awaits the retained `bot.start()` promise, because grammY documents that
`stop()` alone does not wait for middleware completion.

For webhook ingress, `createGrammyWebhookResource` wraps provider-owned update
handling with admission and drain. The application still mounts the HTTP route,
verifies/configures its webhook and chooses the grammY framework adapter. An
update accepted before shutdown may finish; a later update is rejected.

The adapter never reads the token/env, installs commands, changes `bot.catch`,
chooses retry plugins, drops pending updates, sends outbound messages or stores
updates. A durable inbox/retry worker remains an application component, not a
mode of this adapter.

## What disappears from an application

A typical small service can replace roughly 120–220 lines of generic signal,
timer, admission and close bookkeeping with resource declarations. A larger
multi-resource service commonly carries 250–450 generic lifecycle lines plus
15–30 lines for each periodic timer. These are directional review estimates,
not an API guarantee.

The responsibility change is more important than line count:

| Before | After |
|---|---|
| hand-written phase enum and readiness waiters | `createApplication` snapshot |
| `process.on` signal loop and escalation | `bindProcessSignals(app)` |
| interval/timeout handles and overlap flag | `createManagedSchedule` |
| global in-flight counter and drain waiter set | application operation leases |
| manual stop/close fan-out | resource graph + bounded shutdown |
| progress delta events | absolute activity projection |

Durable job tables, lifecycle journals/outboxes, provider inboxes and business
retry rules do **not** disappear. They were never process-local glue and remain
application-owned.
