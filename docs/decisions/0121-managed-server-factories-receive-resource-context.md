---
title: "ADR 0121: Managed server factories receive resource context"
description: "A managed server factory receives the same declared-dependency and startup-signal context as every other managed resource."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0121 — Managed server factories receive resource context

## Context

ADR 0114 makes dependency values available through
`ManagedResourceContext.use(resource)`. ADR 0115 makes
`managedServerResource` invoke its server factory during `start`, after declared
dependencies are ready. The two decisions must compose: route construction often
needs the database, service or socket value that the graph just made ready.

A zero-argument factory discards that context. The application can preserve the
value only through an outer mutable variable or by overriding the resource's
`start`, which creates a second lifecycle owner and defeats the graph boundary.

## Decision

The `server` factory receives `ManagedResourceContext`:

```ts
managedServerResource({
  id: 'http',
  dependsOn: [database],
  server: (context) => {
    const db = context.use(database)
    return createServer({ port, services: createServices(db) })
  },
})
```

The context is the one used for this resource's startup. Its `signal` is the
application startup/lifetime signal, and `use` enforces the resource's declared
dependencies. Sync and async factories receive the same context.

A zero-argument function remains assignable and behaves unchanged. An already
created handle remains valid. Once factory invocation begins, any rejection is a
single startup failure: rollback never calls the factory again.

## Consequences

- Server construction can consume typed dependency values without an outer
  handoff.
- A failed or undeclared dependency prevents binding before the server factory
  can become a second source of lifecycle state.
- The managed adapter remains the sole owner of server start and shutdown.
- Factory cancellation follows the resource graph's existing signal semantics;
  no server-specific signal channel is introduced.
