---
title: Live data — announcements, watched reads, keyspaces and the trust fence
description: How to declare events beside the operation contract, share one server-side read between every browser asking the same question, keep authoritative memory in front of a durable backend, and refuse a request whose authority you never agreed to answer on.
type: guide
status: active
created: 2026-09-02
updated: 2026-09-02
---

# Live data

Four things an application builds by hand the second time it needs them.
`stitchkit/live` is **evolving**: it ships from its own entrypoint so that is
visible rather than discovered in a minor.

- [Announcements — `defineEvents`](#announcements)
- [Watched reads — `createWatchHub` / `createWatchClient`](#watched-reads)
- [Keyspaces — `defineKeyspace`](#keyspaces)
- [The trust fence — `createTrustFence`](#the-trust-fence)

---

## Announcements

`defineContract` says what a caller may **ask**. `defineEvents` says what the
server may **announce**.

```ts
import { defineEvents } from 'stitchkit/live';
import { z } from 'zod';

export const events = defineEvents(
  { prefix: 'notes' },
  {
    'changed': { schema: z.object({ folder: z.string() }), mode: 'emit' },
    'archiving': {
      schema: z.object({ folder: z.string() }),
      mode: 'decision',
      whenAllDefer: 'allow',
      listenerTimeoutMs: 2_000,
    },
  },
);
// events.topics has the keys 'notes.changed' and 'notes.archiving'
```

A topic has exactly one name: the prefixed one. It is the key of `topics`, the
event on the wire, and the string you pass to `on`. The short key in the literal
is where the full name is *built*, not a second name for the same topic.

### The wire is the socket you already run

`toRealtimeContract` projects the declaration onto `RealtimeContract`. Everything
after that is the machinery Stitchkit already ships — validation both ways,
rejection reporting, rooms, and the client's `retain:` replay.

```ts
import { bindRealtimeServer } from 'stitchkit/server';
import { bindRealtimeClient } from 'stitchkit';
import { toRealtimeContract } from 'stitchkit/live';

const realtime = bindRealtimeServer(toRealtimeContract(events), { io });
realtime.emit('notes.changed', { folder: 'inbox' });

// browser
const live = bindRealtimeClient(toRealtimeContract(events), socket);
live.on('notes.changed', (payload) => { /* payload is typed */ });
```

There is no `bindEvents`. Subscribing to an announcement is `bindRealtimeClient`,
because a second `on()` over the same socket would be a second name for one
thing.

Two details worth knowing before you meet them:

- A rejected announcement is reported **at the peer that refused it**, through
  `onRejected`. A fire-and-forget event has no acknowledgement channel to carry
  a refusal back to the sender.
- An issue path names the tuple position — a bad `revision` field appears as
  `0.revision`, because event arguments are a tuple and one payload sits at
  index 0 of it.

### Delivery modes are about **this process**

A browser cannot delay or veto a server's announcement, so a mode says nothing
about the wire. It says what the server's own listeners may do.

| mode | what the caller gets back | a listener that fails |
|---|---|---|
| `emit` | nothing; announce and continue | isolated, reported, the others still run |
| `serial` | a promise for the whole sequence | reported at its deadline; the next still runs |
| `decision` | a promise for `allow` / `deny` | **denies**, with the reason |

Pass the declaration to the bus and it enforces the mode:

```ts
import { createEventBus } from 'stitchkit/server';
import type { EventPayloads } from 'stitchkit/live';

const bus = createEventBus<EventPayloads<typeof events>>({ topics: events.topics });

bus.on('notes.archiving', async () =>
  (await runsOpen()) ? { outcome: 'deny', reason: 'a run is still open' } : { outcome: 'allow' },
);

const decision = await bus.decide('notes.archiving', { folder: 'inbox' });
bus.emit('notes.archiving', …);   // throws: that topic is delivered with decide()
```

The asymmetry in the table is deliberate and is the point of the mode. For
`emit`, isolating a failing listener means "the others carry on". For a vote, the
same isolation would mean "counted as consent" — so a listener that throws, times
out, or returns something that is not a decision **denies**. A listener that was
asked and did not answer has not agreed.

`whenAllDefer` and `listenerTimeoutMs` have no defaults, and that is on purpose:
either default would be a standing `allow`/`deny`, or an unbounded wait, applied
to every topic whose author never thought about it.

---

## Watched reads

A watched read is a GET the server re-runs when a topic announces a change,
pushing the new answer to everyone watching it.

```ts
// server
import { createWatchHub } from 'stitchkit/application';

const hub = createWatchHub({
  read: (operation, args) => api[operation.action](args),
  watchable: (operation) => operation.service === 'notes',
  invalidatedBy: () => ['notes.changed'],
  subscribe: (topic, listener) => bus.on(topic, listener),
  holdMs: 30_000,
});
```

```ts
// browser
import { createWatchClient, watchTransport } from 'stitchkit/live';

// `live` is the bound realtime client. It goes through `watchTransport`, and
// that is not ceremony: its `on` is generic over the contract it was bound to,
// and TypeScript will not relate that signature to the one a watch client
// declares. The conversion lives in the framework so it is written once rather
// than in every application.
const watch = createWatchClient(notesContract, {
  transport: watchTransport(live),
  holdMs: 30_000,
});

const handle = watch.list({ folder: 'inbox' });
const stop = handle.subscribe({
  value: (notes) => render(notes),
  state: (state) => {
    if (state.phase === 'unavailable') showBanner(state.message);
  },
});
```

Two browsers asking the same question are **one read**. The identity of a
question is `(service, action, digest of arguments)`, and the digest is
order-independent — `{a, b}` and `{b, a}` are the same question, which a plain
`JSON.stringify` key would get wrong exactly when two components happen to build
their argument object in a different order.

### Narrow the topic to the arguments

`invalidatedBy` is given the arguments as well as the operation, so a topic can
name what the answer actually depends on:

```ts
invalidatedBy: (operation, args) => [`chat.transcript:${args.address}`],
```

Without that, one address changing wakes every watcher of the operation. Twenty
conversations open means twenty reads for one change — nineteen of them publish
nothing, because nothing changed, and the read is paid anyway.

### Who shares with whom

A key is `(service, action, digest of arguments)`, and everyone on that key gets
one read. So the question a sharing primitive has to answer is what keeps one
caller's answer from reaching another — and here the answer is structural:
`read` is **given no subscriber**. An answer that depends on who is asking has to
carry the asker in its arguments, and the arguments are what the digest is taken
over, so two callers who differ get two keys and two reads.

The one way to defeat that is to resolve an identity from ambient state *inside*
`read` — a request-scoped context, a module-level "current user". Then every
subscriber on that key receives whatever the first read happened to resolve.
Put the identity in the arguments instead.

### Three states, not two

`state.phase` comes from `LiveStatePhase`, the vocabulary the live-state
controller already uses. The one to notice is `opening`: subscribed, nothing read
yet. It is neither healthy nor broken, and rendering it as "unavailable" tells a
user something is wrong when the truth is that it is early.

A failed read arrives as `unavailable` with the read's own `code` and `message`.
The hub retries on its own backoff, and a success clears the state without anyone
asking.

### Across a reconnect

The hub releases a connection's keys when it detaches, so everything opened over
the old socket is gone the moment it drops. The client recovers on its own: on a
drop your `state` listener gets `unavailable` / `source-unavailable`, and on the
next connection every key that still has a listener is re-opened and the values
resume. That is what `onConnectionChange` on the transport is for, and why it is
required rather than optional — a client that cannot be told has no way to
notice, and the face stops updating without a word.

Nothing an open can fail with escapes as a rejected promise: a disconnected
socket, a timeout, a refusal all arrive as `unavailable` carrying the error's own
code and message, and the next connection retries.

### `watch` or `createLiveStateController`?

> **If you would have written `applyEvent` as `(_, next) => next`, you want
> `watch`: the server sends the value whole.** `createLiveStateController` is for
> a server that sends *deltas* you have to fold. `watch` is that controller with
> the fold fixed to replacement, plus the key sharing and the retention — so
> applying both to one value is always a mistake.

### What it cannot promise

One source per **process**. Two processes behind a balancer are two reads, and no
test can show you otherwise from inside one of them.

---

## Keyspaces

Authoritative memory in front of a durable backend: read synchronously, write
through one serialised chain.

```ts
import { defineKeyspace, keyspaceResource, sqliteKeyspaceBackend } from 'stitchkit/application';

const sessions = defineKeyspace('sessions', {
  schema: SessionSchema,
  key: (session) => session.id,
});

createApplication({
  resources: [
    keyspaceResource(sessions, {
      backend: sqliteKeyspaceBackend(sessions, { database }),
      onChanged: (change) => bus.emit('sessions.changed', { id: change.key }),
      dependsOn: ['database'],
    }),
  ],
});
```

The order is **backend, then memory, then the change event**, and it is the whole
point:

- Backend first is what makes the memory authoritative — a reader can never
  observe a value that did not survive. The reverse order makes writes feel
  instant and makes every rejected write a lie somebody already read.
- The event last, after memory, because a subscriber woken by it reads
  immediately. An event emitted before the memory update is a wake-up to the old
  value.

Where there is no kernel — a server that binds its own signals and closes what
it holds in an order it wrote — open it directly instead:

```ts
const opened = await openKeyspace(sessions, { backend });
opened.keyspace.get(id);                       // synchronous, from memory
// on shutdown, in the order you chose:
opened.stopAdmission();
await opened.drain();
await opened.close();
```

The resource is a thin wrapper over exactly that, so there is one implementation
and two lifecycles, not two keyspaces.

Where there **is** a kernel it is a **resource**, read with `context.use(...)`,
rather than a function you call wherever you need it. The kernel resolves its resource graph in the constructor
and cannot register one afterwards, so a keyspace opened by a bare call inside
another resource's `start` is never drained, never closed, and never ordered
against the things that write to it.

"Durable" means the backend's `put` resolved. It does **not** mean `fsync` —
SQLite in WAL mode with `synchronous = NORMAL` returns success before the data
reaches the disk. What an acknowledgement is worth is the backend's to state and
yours to configure. In the same spirit, a keyspace that closes with writes still
queued reports how many through `onUnwritten`, because a graceful close is
deadline-bounded and a forced one can cut a drain short.

---

## The trust fence

Compare the authority a request addressed against a list you declared, and refuse
before anything is dispatched.

```ts
import { createTrustFence } from 'stitchkit/server';

const fence = createTrustFence({
  trustedHosts: ['app.internal', 'localhost:5180', '192.168.1.10:5180'],
  logger,
});

createServer({
  services,
  hooks: composeLifecycleHooks(fence.hooks, applicationHooks),
  socket: { io, allowRequest: fence.allowRequest },
});
```

### A UI on one port, an API on the next

The most ordinary arrangement in development is also the one the fence refuses by
default: a UI dev server on `:5180` calling an API on `:5181`. The browser sends
`Origin: http://localhost:5180` to `Host: localhost:5181`, they differ, and both
lanes answer 403. Declare the second origin:

```ts
createTrustFence({
  trustedHosts: ['localhost:5181'],
  trustedOrigins: ['localhost:5180'],
});
```

Same entry format as `trustedHosts`, compared against the `Origin`'s authority.
Declaring one does not widen anything else: an undeclared origin is still
refused, and `trustedHosts` still decides which authority the server answers on.

It is worth knowing what the `Origin` check is for, because it is not what most
people assume. It is **not** the DNS-rebinding defence — that attack is
same-origin by construction, so it sends a matching `Origin` or none at all, and
`trustedHosts` is what refuses it. What the `Origin` check stops is a plain
cross-origin request from a page that never needs to read the reply: CORS governs
whether a response can be *read*, never whether the request is *sent*, so a
state-changing endpoint is reachable without it.

### Install **both** halves

`fence.hooks` fences HTTP. `fence.allowRequest` fences the Socket.IO lane — and
that lane never reaches `hooks.onRequest` on either runtime: on Bun the fetch
handler answers the socket prefix before the contract handler exists, and on Node
`socket.attach` hands the upgrade to Socket.IO directly. A fence installed only
in `hooks` leaves open the lane a live application pushes its data over.

Order matters too: `composeLifecycleHooks` stops at the first hook that answers,
so the fence goes **first**. Behind a hook that returns a maintenance page, it
never runs.

### What it does not do

- **It does not gate operations.** "Only from this machine" is a property of an
  operation, and an operation is known after routing, not before it. Write it as
  an auth rule over `ctx.ipAddress` — `isLoopbackAddress` is exported for
  exactly that — where it composes with your other rules.
- **It does not re-check an open connection.** Both lanes check at admission.
- **It does not see an `OPTIONS` preflight** when `cors` is configured; that is
  answered earlier. The preflight carries no operation and no body, and the
  DNS-rebinding attack the fence exists for is same-origin and sends none.

An entry is `host` or `host:port` — no scheme, no path, no wildcard — and an
entry that is not a readable authority stops startup naming itself, rather than
quietly matching nothing. There is no implicit `localhost`: list it when you want
it.

Every refusal answers the same bare 403. A response that said *which* rule
refused would let a caller learn your trusted list one guess at a time; the
reason goes to `onRefused` and the log, where you are.

### One thing that changed

A route group can no longer declare `onRequest`. It never worked — the framework
dispatched only the server-level hook — and it could not be made to work without
matching group prefixes a second time, ahead of the real router. Use the
server-level `hooks.onRequest` to refuse before dispatch, or the group's
`authorize` to gate once the endpoint is known.
