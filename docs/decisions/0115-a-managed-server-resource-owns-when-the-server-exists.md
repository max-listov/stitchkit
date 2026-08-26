---
title: "ADR 0115: A managed server resource owns when the server exists"
description: "managedServerResource creates the server during start instead of calling its thunk on the way down, because the old reading produced a healthy application with nothing listening on the port."
type: decision
status: accepted
created: 2026-08-26
updated: 2026-08-26
---

# ADR 0115 — A managed server resource owns when the server exists

## Context

`managedServerResource` accepted either a handle or a thunk:

```ts
readonly server: ManagedServerHandle<TRuntime> | (() => ManagedServerHandle<TRuntime>)
```

Its `start()` was empty, and the thunk was called from `ensureShutdown` — that
is, on `stopAdmission` / `drain` / `close` / `force`. Adapting an
already-running server was the documented intent, and for that the empty start
was right.

But a thunk reads as the opposite. `server: () => createServer(config)` says
"make the server when it is time", and that is exactly what an application
needs, because it is the only way to express *bind the port after the database
is up*. Written that way, the graph did this:

```ts
await app.start()
// resolves. health: 'healthy'. ready: true. every resource ready.
// createServer was never called. nothing is listening.
```

No error, no warning, no `degraded`. The failure surfaced outside the process —
as a request that never arrived, or a health check if one existed.

That is the worst available shape, and it is the one the kernel exists to
prevent. The whole argument for the application kernel is that *ready stops
being a tautology*: the snapshot means the required graph is genuinely up. Here
the snapshot became the tautology.

## Decision

**`start()` resolves the server; the thunk is called there, and the handle is
published to dependants** (→ ADR 0114). The thunk may be asynchronous, because
"bind the port after the database is up" often needs to await something.

Three cases, and the shutdown path distinguishes them:

- **`start` ran and produced a handle** — the ordinary graph. Shut that handle
  down.
- **`start` ran and produced nothing** — a thunk that threw. There is no server.
  Calling the thunk again during the rollback would raise its failure a second
  time and turn one honest startup error into "startup and rollback failed".
- **`start` never ran at all** — the resource is spread over someone else's
  `start`, which is the workaround the broken version forced on consumers. The
  thunk is still the only way to reach their server, so it is still called.

The third case is why this is not simply "call the thunk in start". A consumer
who worked around the defect wrote:

```ts
let handle: ManagedServerHandle<T> | null = null
const shutdown = managedServerResource({ id: 'http', server: () => handle! })
const http = defineManagedResource({
  ...shutdown,
  dependsOn: ['database', 'socket-io'],
  start: () => { handle = createServer(config) },
})
```

Their `start` overrides the adapter's, so the adapter's never runs. Removing the
lazy path would leave their server up forever — punishing precisely the people
who worked around the bug being fixed.

The shutdown call also stays **synchronous** whenever the handle is already in
hand, which is every case but a pending async thunk. `stopAdmission` closes the
admission gate by making that call; deferring it by a microtask would admit
requests after the application decided to stop accepting them.

## Consequences

- A graph may delegate server creation to the resource that owns the server, and
  the port is bound after the dependencies are ready — expressed in the graph
  rather than by spreading one resource over another.
- A thunk that throws fails the startup with its own error, and the rollback
  closes what was actually opened.
- An already-created handle behaves exactly as before: `start` adopts it, and
  nothing about the shutdown changes.
- The migration recipes gain the managed HTTP server, which is the main resource
  of any web backend and was the one case they did not cover.
