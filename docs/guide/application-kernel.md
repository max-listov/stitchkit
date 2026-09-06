---
title: Managed application kernel
description: Compose process-local resources, schedules, readiness, drain and optional provider adapters without building a second job platform.
type: architecture
status: active
created: 2026-08-23
updated: 2026-09-04 14:11 +07:00
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
  // Called during `start`, after `database` is ready. The factory receives the
  // same declared-dependency and startup-signal context as any resource.
  server: (context) => {
    const db = context.use(database)
    return createServer({ port: env.PORT, services: createServices(db) })
  },
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

`managedServerResource` follows the same rule. Its factory receives this context
during `start`, so constructing routes from a database/service/socket value does
not need an outer mutable handoff or a custom `start` override. A zero-argument
factory remains valid when it needs only ordering, and an already-running handle
can still be passed directly. → ADR 0121.

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

## Replacing part of the graph without stopping the process

`restart` takes down one resource **and everything that depends on it**, then
brings that subtree back. Everything else keeps running, and the process epoch
does not move.

```ts
const result = await app.restart({ resourceId: 'database' })

result.outcome  // 'restarted' | 'failed' | 'refused'
result.affected // ['database', 'repository', 'api'] — in start order
```

The dependants come down with it because they are holding what the resource
published. A repository that kept running across a database replacement holds a
pool that has been closed: it still typechecks, still has methods, and fails at
whatever moment the first call happens. There is no version of this where a
dependant keeps a live handle, so the subtree — not the resource — is the unit.

A leaf restart affects one resource, and an independent neighbour is never
touched:

```ts
await app.restart({ resourceId: 'cache' })
// mailer and database were not stopped, not started, not activated
```

**Refused is not failed.** An unknown id, a restart during shutdown, and a
restart before the application is ready all return `refused` with a reason and
touch nothing. `failed` means the subtree came down and the new generation did
not come up — and the result agrees with the snapshot: if any affected resource
ends the restart in `failed`, so does the restart, including an optional one
whose failure the start loop does not re-throw.

**The close phase is bounded**, by the application's shutdown budget or by one
this call names:

```ts
await app.restart({ resourceId: 'database', gracePeriodMs: 5_000, forceTimeoutMs: 2_000 })
```

**A resource has to be able to start twice.** The kernel calls `start` again, so
a resource holding state across its own lifetime rebuilds it there. The ones this
framework ships do — a schedule re-arms, a keyspace opens a new generation and
re-loads, a managed server built from a factory gets a fresh server. A managed
server given a server *instance* cannot, and says so by name rather than
republishing something it has shut down. Give a keyspace a
`backend: () => …` factory when its backend cannot be re-opened after `close()`.

→ [ADR 0157](../decisions/0157-a-restartable-resource-begins-a-generation.md).

Restarts of overlapping subtrees queue behind each other rather than being
refused. Two callers asking at once is ordinary; two generations of one resource
alive at once is the thing this must make impossible.

```ts
// Both succeed, one complete pass after the other.
await Promise.all([
  app.restart({ resourceId: 'database' }),
  app.restart({ resourceId: 'database' }),
])
```

What a restart is **not** is a process restart: it replaces resources, and does
not re-read configuration the kernel captured when it was constructed.

→ [ADR 0154](../decisions/0154-the-unit-of-a-restart-is-the-subtree.md).

## Decisions a policy set makes together

`createDecisionPipeline` runs an ordered list of policies that each vote
`allow`, `deny` (with a reason) or `defer`. The first terminal verdict wins and
the rest do not run.

```ts
import { createDecisionPipeline } from 'stitchkit/application'

const pipeline = createDecisionPipeline<{ userId: string; scope: string }>([
  { id: 'banned', decide: (r) => (isBanned(r.userId)
      ? { outcome: 'deny', reason: 'account suspended' }
      : { outcome: 'defer' }) },
  { id: 'scope', decide: (r) => (r.scope === 'admin'
      ? { outcome: 'allow' }
      : { outcome: 'defer' }) },
  { id: 'default', decide: () => ({ outcome: 'deny', reason: 'no policy allowed this' }) },
], { policyTimeoutMs: 2_000 })

const result = await pipeline.decide(request)
result.outcome // 'allow' | 'deny' — never 'defer'
result.trace   // the policies that actually ran, in order
```

Three things are deliberate.

**A deny carries a reason, by schema.** `{ outcome: 'deny' }` alone does not
typecheck. A refusal whose cause exists only in the log of whoever refused is a
support ticket.

**The trace is what ran, not what was declared.** It stops at the terminal
verdict. When something was denied the question is which policy denied it and
what the ones before it said, and a trace listing policies that never ran would
answer that wrongly while looking complete.

**Every policy deferring raises.** `DecisionUndecidedError`, not a default —
defaulting to `allow` turns an incomplete policy set into an open door, and
defaulting to `deny` turns it into an outage whose cause reads as a legitimate
refusal.

**A policy that does not answer raises too.** A non-decision, a throw, and running
past `policyTimeoutMs` are one error — `DecisionPolicyError`, naming the policy
and carrying the trace so far — because they are indistinguishable downstream and
handling one but not the others is how a broken policy becomes a skipped one. The
chain stops there rather than falling through to whatever the next policy would
have said.

`policyTimeoutMs` is required and has no default. Pick a number your slowest
policy comfortably beats. The framework will not choose it for you: a policy that
never settles hangs every caller of the operation it guards, and a default here
is a number nobody chose applied to code the framework has never seen.

The same `allow`/`deny`/`defer` type is what an event topic declared
`mode: 'decision'` uses in `stitchkit/live` — one vocabulary, because a listener
voting on an event and a policy voting on a request are answering the same
question.

→ [ADR 0155](../decisions/0155-one-decision-vocabulary-and-an-unanswered-question-is-an-error.md).

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

`managedServerResource` already owns contract/streaming-route response lifetimes. It cancels
their supplied signals at admission close and awaits source cleanup before dependent resources
close. Do not add application admission leases or a second cancellation registry for those
streams. A source that ignores cancellation or fails its cleanup prevents a clean shutdown;
the existing grace and force budgets still bound the result.

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

### Bounded revision wake-up

Use `createRevisionSignal` when several operations need to wait for the same
process-local fact to change, but the change itself is not a queue item:

```ts
const connectionsChanged = createRevisionSignal({ maxWaiters: 256 })

const observed = connectionsChanged.getSnapshot().revision
const result = await connectionsChanged.wait(observed, {
  signal: request.signal,
  timeoutMs: 10_000,
})

// After changing the canonical connection state:
connectionsChanged.advance()
```

`wait(after)` resolves immediately when the signal is already newer than
`after`; this closes the race between reading a snapshot and registering the
wait. Waiting on the current revision parks one operation, up to `maxWaiters`.
Every terminal result carries the revision it observed and distinguishes
`changed`, `timed-out`, `aborted`, `closed` and `capacity`. A future `after` is
a caller error rather than a revision the signal could honestly promise to
reach.

One advance wakes every older waiter. It is not consumed by the first reader,
does not retain event payloads and has no replay history. A bounded channel is
for delivering items to one reader; a credit window grants a finite resource.

The signal is already its whole lifecycle handle. Call its idempotent `close()`
from the `close` phase of the managed resource that owns the changing fact;
there is no second managed-resource wrapper around the same state. → ADR 0163.

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

### Bounded local diagnostic journal

Use `createDiagnosticJournal` when a process needs finite, ordered local metadata evidence and the
deployment log pipeline is not the right boundary:

It lives at `stitchkit/application/diagnostic-journal`, not in the main barrel:
it is the one part of the kernel that spawns, locks and writes files, and while it
was exported from `stitchkit/application` that single line made the whole
entrypoint unusable in a browser bundle. Its schemas stay in
`stitchkit/application`.

```ts
import { createDiagnosticJournal } from 'stitchkit/application/diagnostic-journal'
import { z } from 'zod'

const journal = await createDiagnosticJournal({
  eventSchema: z.object({
    kind: z.enum(['resource_failed', 'recovery_started']),
    resource: z.string().max(80),
  }).strict(),
  path: '/var/lib/example/diagnostic.jsonl', // operator configuration, never request data
  limits: {
    maxEventBytes: 4 * 1024,
    maxPendingItems: 128,
    maxPendingBytes: 512 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxFiles: 4,
  },
  onFailure: (failure) => internalLogger.error(failure),
})

const result = journal.submit({ kind: 'recovery_started', resource: 'database' })
if (result.outcome === 'refused') internalCounter.add(1, { reason: result.reason })

// During managed-resource close. Timeout ends this wait, not the physical append.
await journal.close({ timeoutMs: 5_000 })
```

The owner schema and JSON serialization run synchronously before admission. Accepted frames carry
a process epoch and contiguous sequence and retain their complete bytes inside both pending limits
until their append attempt settles. Capacity, invalid, oversized, closed and terminal-failure
refusals are explicit; accepted ordered frames are never evicted.

The absolute path's parent must already exist and be operator-controlled. One manager owns it via
an exclusive `.lock`; new files use mode `0600` by default. `maxFiles` includes the active file,
and a non-newline startup tail is rotated intact rather than guessed or repaired. An abrupt process
death may leave the lock for an operator to remove only after proving the former owner is gone.

`flush()` means every accepted append through that call's boundary settled. It is not `fsync`, a
durable receipt, exactly-once execution or remote delivery. Timeout/cancellation bound only the
waiter; the writer retains physical capacity until settlement. There is no reader or upload API.
Use a durable application store or deployment-owned log collector when restart recovery, replay or
aggregation is required. → [ADR 0134](../decisions/0134-diagnostic-journal-is-bounded-local-evidence.md).

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

## Durable process facts and owner notifications

`createProcessLifecycleLedger` records a bounded versioned list of process runs.
Start, readiness and shutdown target both `runId` and `pid`, so hot reload and
PID reuse cannot close the wrong generation. A start classifies what happened to
the newest run before it, and the classification is decided by three facts —
whether that run recorded its own exit, whether the pid is the same, and whether
the version changed:

| newest run | same pid | version | `previousExit` | predecessor's `termination` |
|---|---|---|---|---|
| none | — | — | `first-boot` | — |
| recorded `stoppedAt` | — | — | `clean` / `forced` / `abnormal` as recorded | unchanged |
| still `active` | yes | — | `hot-reload` | `hot-reload`, closed at the new start |
| still `active` | no | changed | `handoff` | stays `active`; it records its own stop later |
| still `active` | no | same | `abnormal` (default) | `abnormal`, closed at the new start — an upper bound, the crash time is unknown |

A version of `unknown` on either side is never a version change, so a dev build
after a crashed release reads `abnormal`, not `handoff`. `forced` means the
process itself acknowledged a kill; `abnormal` means a successor found it dead.

The last row is a choice, and the default is the single-process deployment:
one process per build, a new pid of the same build means the old one stopped
answering. Where two processes of **one** build overlap on purpose — a
cluster, a zero-downtime reload of the same build — pass
`sameVersionOverlap: 'handoff'` to the ledger, and the predecessor stays
`active` until it records its own shutdown. The cost of that setting is
symmetric: a real crash under it is reported as a handoff and the dead run
stays `active` in the ledger until retention drops it. The list is kept in the
order the transitions wrote it — every write goes through one atomic update,
so that order is the causal one, and a successor whose clock lags its
predecessor still finds it at the head; `startedAt` is data, not the sort key.
Retention (`retain`, default 20) drops finished runs first and an active one —
a live handoff predecessor — only when nothing finished is left. Facts are
published through the ledger's own subscription and resource value;
`ApplicationEventSink` remains the strict application-state stream.

`createNotificationOutbox` is the transport-neutral durable delivery side. It
persists before send, claims an item with an expiring lease, carries one stable
idempotency key into the transport, retries under an injected clock and records
terminal drops. The guarantee is at-least-once: a crash after remote acceptance
but before the receipt is persisted may redeliver, so transports should use the
key when they support deduplication. The retry budget is sized for the outage
an owner notification has to outlive, not for a flaky call: the default backoff
doubles from one second and caps at sixty (`backoffDelay`, the one formula the
client's resumable streams also use, with jitter 0), and the 99 waits between
the default `maxAttempts` of 100 sum to 1+2+4+8+16+32 s plus 93 × 60 s — about
94 minutes — before `onDropped` sees `attempt-limit`.
`state()` is a read and never fails on the bounds a transition enforces — a file
that grew past `maxStateBytes` under an older limit is inspectable and is
trimmed by the next transition. Two bounds do fail loudly: `enqueue` past
`maxQueue` throws rather than dropping silently, and a `backoffMs` that returns
`NaN`, a negative or an infinite delay rejects the flush. `stop()` lets the
send in flight finish and claims nothing more; a `send` without its own
deadline holds `stop()` — and so the resource's `force()` — for that one call,
so give the transport a timeout. Superseding a key that is being sent right now
does not recall it: the send completes, and only its receipt is not written.

Both primitives depend on the structural `StateStore`. On a server,
`createFileStateStore` supplies the shared Zod-validated JSON adapter with an
inter-process lock, unique temporary file, fsync and atomic rename. The lock
is a file with a heartbeat: the holder refreshes its mtime every third of
`staleLockMs` (default 3 s), a contender waits up to `lockTimeoutMs` (default
10 s), and the stale bound must sit inside the timeout — otherwise a crashed
holder blocks every update until the lock ages out, which the constructor
refuses. A lock whose heartbeat is stale is reclaimed once its recorded pid is
gone; a live or unverifiable pid (a reused number, another user's process)
keeps it for ten stale bounds, after which the heartbeat wins and the lock is
abandoned. Temporary files a crashed writer left beside the state are swept on
the store's first update. Ledger corruption may be declared reconstructable;
an outbox must fail closed rather than silently discard pending delivery.
