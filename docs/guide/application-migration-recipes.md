---
title: Application migration recipes
description: Executable patterns for moving database, poller, queue and operational publishing lifecycle into the managed application kernel.
type: architecture
status: active
created: 2026-08-24
updated: 2026-08-24
---

# Application migration recipes

These recipes are the migration companion to the
[managed application kernel](./application-kernel.md). Their canonical source is
the packed-consumer fixture
[`application-migration-recipes.ts`](../../packages/core/scripts/consumer-lane/fixtures/minimal/src/application-migration-recipes.ts):
the consumer lane installs the package tarball, typechecks that file and runs it
only through `stitchkit/application` exports.

## Database connection

Wrap connection allocation and readiness in `start`, and make `close` safe after
partial setup. Stitchkit invokes cleanup for every attempted start, including a
start that allocates a client and then rejects.

```ts
const database = defineManagedResource({
  id: 'database',
  async start({ signal, reportHealth }) {
    await databaseClient.connect(signal)
    await databaseClient.assertReady()
    reportHealth('healthy')
  },
  close: () => databaseClient.close(),
})
```

The application still owns the client, ORM configuration, transactions,
migrations and reconnect policy. The executable recipe deliberately fails after
allocation and proves one rollback close.

## Long-running poller

Return separate readiness and completion promises. Readiness says dependants may
start; completion represents the whole background lifetime.

```ts
const poller = defineManagedResource({
  id: 'poller',
  start: ({ signal }) => ({
    ready: providerPoller.ready,
    completion: providerPoller.run(signal),
  }),
  stopAdmission: () => providerPoller.stop(),
  drain: () => providerPoller.completion,
  close: () => providerPoller.close(),
})
```

Completion before readiness fails startup and rolls back. Completion after
readiness removes application readiness. Provider cursor persistence, retry,
backoff and restart policy remain application/provider concerns.

## Queue consumer

Acquire the application lease only after provider delivery/claim. If admission
is already closed, reject the delivery through the provider's own nack/requeue
primitive. Work admitted before shutdown releases its lease after ack/nack and
therefore participates in application drain.

```ts
async function handleDelivery(delivery: Delivery) {
  const lease = app.admission.acquire()
  if (!lease) return delivery.nack({ requeue: true })
  try {
    await processClaim(delivery.claim)
    await delivery.ack()
  } catch (error) {
    await delivery.nack({ requeue: shouldRetry(error) })
    throw error
  } finally {
    lease.release()
  }
}
```

Stitchkit owns only process-local admission accounting and drain. Durable claims,
visibility timeouts, deduplication, idempotency and retry classification remain
in the queue/product layer.

## Operational publisher

Project anonymous aggregate activity, then feed absolute snapshots into the
latest-value sink. A slow transport holds one write plus one replaceable latest
revision rather than an unbounded event queue.

```ts
const publisher = createApplicationSnapshotSink({
  write: (snapshot) => monitoring.publish(snapshot),
})
const activity = createActivityProjection({
  id: 'generation',
  stages: ['queued', 'running'],
})
const unsubscribe = activity.subscribe((snapshot) => {
  publisher.publish(snapshot)
})

// cleanup boundary
unsubscribe()
publisher.publish(activity.getSnapshot())
await publisher.close()
```

The monitoring backend, transport retry and cross-process aggregation remain
outside Stitchkit. The executable recipe blocks revision 0, coalesces
intermediate revisions, explicitly admits the final absolute snapshot after
unsubscribe and proves that `close()` flushes revision 3. Do not rely on an
asynchronous subscriber callback racing cleanup: publish `getSnapshot()` before
closing the outer sink, so any older or duplicate late delivery is rejected as
stale instead of dropping the final state.

## Bound a handler and a local worker with one lease policy

Use a bounded admission when two entry paths consume the same finite local
capacity. Composing it with `application.admission` keeps readiness and shutdown
as the upstream gate:

```ts
const work = createBoundedAdmission({
  upstream: app.admission,
  policy: {
    global: { maxConcurrent: 4 },
    perKey: { maxConcurrent: 1, maxKeys: 1_000 },
  },
})

const fromHttp = (key: string, signal: AbortSignal) =>
  work.run(key, (context) => render(context.signal), { signal, timeoutMs: 20_000 })

const fromWorker = (key: string) =>
  work.run(key, (context) => reconcile(context.signal))
```

A timeout in `fromHttp` does not free a permit while `render` remains active.
At shutdown call `work.stopAdmission()` with the other admission owners and
await `work.drain(...)`; the result reports the actual remainder.

## Replace ad-hoc output and progress queues

Ordered output and replaceable progress are separate declarations:

```ts
const lines = createBoundedChannel<string>({
  policy: 'ordered', maxItems: 100, maxBytes: 1_000_000,
  sizeOf: (line) => new TextEncoder().encode(line).byteLength,
})

const state = createBoundedChannel<{ revision: number; percent: number }>({
  policy: 'latest', maxItems: 1, maxBytes: 64,
  sizeOf: () => 64,
})

const lineResult = lines.offer('one durable-in-process ordering unit')
const stateResult = state.offer({ revision: 2, percent: 50 })
```

Handle `refused` from `lines` at the protocol boundary; do not turn it into
implicit loss. A `coalesced` state result is expected latest-value behaviour,
not evidence that an ordered event was delivered. Neither channel is durable;
persist first when restart replay is required.

## Handing a handle to the resources that depend on it

`dependsOn` carries ordering. To carry the object as well, return a `value` from
`start` and read it with `context.use(...)`. This replaces the module-local
`let handle: T | null` with the guard the graph makes unreachable.

```ts
const database = defineManagedResource({
  id: 'database',
  start: async () => ({ value: await connect(env.DATABASE_URL) }),
})

const worker = defineManagedResource({
  id: 'worker',
  dependsOn: [database],
  start(context) {
    const db = context.use(database)   // Connection — not Connection | null
  },
})
```

Declare the dependency with the **resource** whenever you intend to read from
it: that is the form `use` can type, and it stops the declaration and the read
from drifting. A string still expresses order on its own.

The value is published when `start` resolves and stays readable from `activate`
and from the shutdown phases. `use` refuses a resource that was not declared in
`dependsOn` — that only ever worked by luck of declaration order — and refuses a
resource that published nothing, which the compiler refuses too. The executable
recipe proves both the read and the refusal.

## Managed HTTP server

The main resource of a web backend, and the one whose ownership rule is
counter-intuitive: give `managedServerResource` a **thunk** and it creates the
server during `start`, after its dependencies are ready. Give it an
already-listening server and it adopts that one instead.

```ts
const http = managedServerResource({
  id: 'http',
  dependsOn: [database],
  server: () => createServer({ port: env.PORT, services }),
})

const app = createApplication({ id: 'service', resources: [database, http] })
await app.start()   // the port is bound; the snapshot means it
```

The server resource publishes its `ManagedServerHandle`, so anything that needs
the running server — a Socket.IO attachment, a URL to log, a probe — reads it
with `context.use(http)` rather than through a module-local.

Do not spread this resource over your own `start` to control creation order:
that shape exists only as a workaround for the version whose `start` was empty,
and `dependsOn` now expresses the order directly. The executable recipe binds a
real port, proves a request reaches it after `start()` resolves, and proves the
port is closed after `shutdown()`.

## Deletion checklist

After the cutover, remove the old generic lifecycle path completely:

- duplicate `process.on(...)` handlers and shutdown promise caches;
- manual readiness waiters and resource close fan-out;
- raw interval handles, overlap flags and timer drain code;
- global in-flight counters and waiter sets replaced by application leases;
- progress delta queues replaced by absolute snapshot publishing.

Keep the product code that still owns durable state and policy:

- database schema, transactions and migrations;
- queue claims, ack/nack, deduplication and external-effect idempotency;
- provider cursor, retry/backoff and credentials;
- monitoring transport configuration and durable retention;
- process exit code, hard-exit and deployment/supervisor policy.

Run the old and new lifecycle paths separately during development if needed,
but do not ship both. Before cutover, verify there is exactly one signal binding,
one timer owner, one admission gate and one resource cleanup chain.
