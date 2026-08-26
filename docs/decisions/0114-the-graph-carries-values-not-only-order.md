---
title: "ADR 0114: The resource graph carries values, not only order"
description: "start publishes a value and a dependant reads it with context.use(resource), typed from the publisher's own start — because dependsOn expressed half the dependency and the other half lived in a module-local with an unreachable null guard."
type: decision
status: accepted
created: 2026-08-26
updated: 2026-08-26
---

# ADR 0114 — The resource graph carries values, not only order

## Context

`dependsOn` expressed **when** a resource starts and nothing else.
`ManagedResourceStartResult` carried `ready` and `completion`, both
`Promise<void>`; `ManagedResourceContext` gave a resource its id, its signal,
its deadlines and a way to report health, but no way to reach a neighbour.

Yet a dependency is almost never only temporal. An HTTP server needs the socket
server. A worker needs the database client. A publisher needs the transport. The
kernel guaranteed the neighbour was ready and then offered no way to take
anything from it.

So every consumer wrote the same thing:

```ts
let socket: SocketHandle | null = null

const socketIo = defineManagedResource({
  id: 'socket-io',
  start: async () => { socket = await createSocketServer(config) },
})

const http = defineManagedResource({
  id: 'http',
  dependsOn: ['socket-io'],
  start: () => {
    if (!socket) throw new Error('socket is not initialized')  // unreachable
    server = createServer({ socket })
  },
})
```

Four costs, and the last one is what makes it an architectural question rather
than a style complaint:

- **the type is lost** — `SocketHandle | null` instead of `SocketHandle`, and the
  `null` has to be answered at every use;
- **the guard is noise** — it exists to satisfy the compiler, and a reader spends
  time working out when it can fire (never, if the graph is right);
- **half the invariant leaves the graph** — "http takes the socket from socket-io"
  is declared once in `dependsOn` and once again in the order of assignments,
  and only the first half is checked;
- **everybody writes it.** An application with one resource and no dependencies
  is rare. Past two resources this pattern is not a possibility, it is a
  certainty.

That the migration recipes avoided it is evidence, not coincidence: `database`,
`poller`, `queue consumer` and `publisher` each close over their own module
singleton and hand nothing to anyone. The moment resources exchange objects —
the normal case — there was no recipe, because there was no mechanism.

## Decision

**`start` publishes a value; a dependant reads it with `context.use(resource)`.**

```ts
const database = defineManagedResource({
  id: 'database',
  start: async () => ({ value: await connect(env.DATABASE_URL) }),
})

const worker = defineManagedResource({
  id: 'worker',
  dependsOn: [database],
  start: (context) => {
    const db = context.use(database)   // Connection, not Connection | null
  },
})
```

Four things follow from it, and each was a choice with a rejected alternative.

**`dependsOn` accepts the resource itself, not only its id.** Otherwise the
declaration and the read drift: `dependsOn: ['databse']` and `use(database)` are
a runtime error in one place and a compile error in neither. Strings still work
— ordering without value-passing is a real need — but the object form is the one
`use` can type. This is a breaking widening of a published type and is recorded
as one.

**The value type is recovered from `start`'s return, not inferred from the
argument.** The obvious signature, `use<TValue>(resource: ManagedResource<TValue>):
TValue`, is unsound: with no inference site in the argument, TypeScript infers
`TValue` from the **assignment context**, so `const port: string =
context.use(database)` compiles and the annotation makes itself true. Reading
the type out of the publisher's own `start` leaves the argument as the only
source. This was measured, not reasoned about.

**A resource that publishes nothing yields a branded refusal, not `never`.**
`never` is assignable to every type, so `use` on a value-less resource would
compile everywhere and fail only at runtime — the same silent shape this
mechanism exists to remove. `ManagedResourcePublishesNoValue` is unassignable,
and its single property is the sentence the compiler prints.

**`use` refuses an undeclared dependency.** Reading a value the graph was never
told about happens to work whenever declaration order is lucky; it breaks the
day someone reorders the array. The refusal names both resources.

## Consequences

- The value is published when `start` resolves and stays readable for the
  application's whole life — from `activate` and from the shutdown phases too. A
  dependant may still need the handle it was given while it drains, and a value
  that worked in `start` and failed in `close` would be a new trap in place of
  the old one.
- `managedServerResource` publishes its `ManagedServerHandle`, so the server is
  reachable from dependants without a module-local. That is only possible because
  it now creates the server in `start` (→ ADR 0115).
- Publishing is optional. A resource that hands nothing to anyone declares
  nothing extra, and the shape every existing application already has keeps
  compiling.
- The kernel holds one untyped map for the whole graph, and the loose↔typed
  bridge lives at exactly one cast in `use` (→ ADR 0003).
- `stitchkit/application` stays **evolving** (→ ADR 0103): this is a redefinition
  of a published type in a minor, marked and migrated, not a silent one.
