# Realtime

stitchkit's realtime layer is [Socket.IO](https://socket.io) — `polling`
fallback, heartbeats, acks, a mature client. stitchkit does not ship its own
WebSocket engine; it ships thin, typed wrappers over Socket.IO and a bridge that
syncs socket events into the TanStack Query cache. See
[ADR 0008](../decisions/0008-thin-wrappers.md).
The separate contract shape and rejection ownership are recorded in
[ADR 0069](../decisions/0069-realtime-contracts-validate-without-owning-delivery.md).

## Zod-first event contract

Declare wire events once in the shared module. Each `args` schema is a tuple, so
Socket.IO's no-payload and variadic forms stay intact; `ack` describes the value
returned through an acknowledgement callback.

```ts
// shared/contracts.ts
import { defineRealtimeContract } from 'stitchkit'
import { z } from 'zod'

export const realtimeContract = defineRealtimeContract({
  serverToClient: {
    'note:created': { args: z.tuple([NoteSchema]) },
    'note:deleted': { args: z.tuple([z.string()]) },
  },
  clientToServer: {
    'room:join': {
      args: z.tuple([z.string()]),
      ack: z.object({ joined: z.boolean() }),
    },
    ready: { args: z.tuple([]) },
  },
})
```

The contract derives every event handler type and validates both directions at
runtime. A malformed inbound tuple never reaches the application handler;
invalid outbound data throws before Socket.IO publishes it. Rejections call the
optional `onRejected` hook with event, direction, phase and the Zod error.

### Protocol generations

For a distributed producer/consumer pair, put a literal generation first in the
first payload object. Zod validates object fields in declaration order, so an
incompatible peer is identified before the rest of its payload is interpreted:

```ts
const ReplicationMessage = z.object({
  v: z.literal(2),
  item: ReplicatedItem,
})

const realtimeContract = defineRealtimeContract({
  serverToClient: {
    replicated: { args: z.tuple([ReplicationMessage]) },
  },
  clientToServer: {},
})
```

A frame that fails this check is **refused, and the sender is told so** — when
the event has an acknowledgement. `request()` rejects with
`RealtimeRequestRejectedError`, immediately, carrying the peer's own issues:

```ts
import { RealtimeRequestRejectedError } from 'stitchkit'

try {
  await socket.request('replicate', message, { timeoutMs: 5_000 })
} catch (error) {
  if (error instanceof RealtimeRequestRejectedError) {
    // reason: 'invalid-arguments'; issues: [{ path: '0.v', code: 'invalid_value', … }]
    if (error.issues?.some((issue) => issue.path === '0.v')) schedulePeerUpgrade()
    else reportMalformedRealtimePayload(error)
  }
}
```

`path` is `'0.v'` and not `'v'` because event arguments are a tuple: index `0`
is the first payload. The issues are already flattened by Stitchkit's own
normaliser, so telling "wrong generation" from "malformed payload" is one
comparison rather than an inspection of a `ZodError`'s internals.

The receiving side still reports it locally through `onRejected` — a refusal is
now visible on **both** ends rather than only where it happened.

**Two limits, both real.** A **fire-and-forget** event has no acknowledgement
channel, so its refusal stays local: the sender learns nothing, and no
convention in the payload can change that. And an event the receiver's contract
does not contain has no listener at all, so there is nothing on that side to
answer with — adding an event is not a change a generation field can announce.

### Where protocol identity belongs

For a distributed pair whose planes are mostly fire-and-forget, compare
identity **at the handshake** instead, where a mismatch is refused before the
first frame is interpreted and both ends see it at once. The typed handshake is
already the place:

```ts
const handshake = {
  schema: z.object({ token: z.string(), protocol: z.string() }),
  verify: (auth) => {
    if (auth.protocol !== PROTOCOL_IDENTITY) return null   // refused, with a reason
    return { subject: verifyToken(auth.token) }
  },
}
```

The client sends it as `auth`, and a rejection reaches `onConnectError` with
`terminal: true` — distinguishable in a log from a bad token, so a half-rolled
deployment reads as a half-rolled deployment and not as an access problem.

What that identity *is* remains the application's decision — a build version, a
contract hash, a protocol generation. Stitchkit does not compare it for you
(→ ADR 0002); it gives the place where the comparison happens before any frame
is interpreted, and it makes the per-frame alternative honest by letting its
refusals be seen.

## Server — `createSocketIOServer`

```ts
import {
  bindRealtimeServer,
  createServer,
  createSocketIOServer,
} from 'stitchkit/server'
import { realtimeContract } from '@app/shared'

const socket = await createSocketIOServer({
  cors: { origin: 'https://app.example.com' },
})

const realtime = bindRealtimeServer(realtimeContract, socket, {
  onRejected: (event) => audit.realtimeRejected(event),
})

realtime.onConnection(({ raw, events, to }) => {
  events.on('room:join', (room, acknowledge) => {
    raw.join(room) // authorization and room membership remain application policy
    acknowledge({ joined: true })
    to(room).emit('note:created', note)
  })
})
```

Pass the full handle to `createServer`; it mounts and owns the transport once:

```ts
createServer({
  services,
  socket,
})

// elsewhere — validated broadcast:
realtime.emit('note:created', note)
```

`socket.io` and, on Bun, `@socket.io/bun-engine` are optional peers, resolved
lazily so a project that never opens a socket does not have to install them. If
you ship **one self-contained file** to a machine with no `node_modules`, tell
the framework how to load them so your bundler can put them inside — see
[shipping one self-contained artifact](./testing-and-deployment.md#shipping-one-self-contained-artifact).

The canonical room-broadcast example below is executed by the test suite. Its
body is kept byte-identical to `packages/core/examples/realtime-room.ts`.

```ts canonical-realtime-room
export function publishExampleNote(realtime: ExampleRealtimePublisher): void {
  const note = { id: 'note-1', text: 'Ready' };
  realtime.to('general').emit('note:created', note);
}
```

| Handle field | Purpose |
|--------------|---------|
| `io` | raw Socket.IO server for middleware, handshake auth and transport ownership |
| `websocket` | Bun handlers used directly only in explicit raw-lane composition |
| `route` | `/socket.io/*socketPath`, mounted automatically by `createServer({ socket })` |
| `close()` | idempotent standalone close for CLI/tools with no HTTP server |
| `beginShutdown()` / `connections()` | lifecycle surface consumed by the managed server |

`SocketIOServerConfig` also takes `path`, `transports`, `pingTimeout`,
`pingInterval`, a runtime-neutral `allowRequest(Request)` handshake policy and
the typed **`handshake`** identity gate (schema + verify →
[typed `socket.data`](#handshake-auth--cookie-or-token)). `allowRequest` is the
transport gate (composed with managed-shutdown admission on both Bun and Node);
`handshake` is the identity gate that runs after it.
`transports` is an admission allowlist: `['websocket']` refuses polling,
`['polling']` refuses WebSocket handshakes/upgrades, and both explicitly enabled
transports remain usable. Defaults are both transports on Bun and WebSocket-only
on Node. Bun enforces this before consumer authorization through the engine's
request-policy extension (including existing sessions); Node uses native Engine.IO
enforcement. Bun's native upgrade hints do not override the allowlist. CORS
preflight is not transport admission and keeps its ordinary behavior.
For anything else socket.io's `ServerOptions` exposes, use the
typed **`serverOptions`** passthrough — most often `maxHttpBufferSize` to lift the
1 MB default for large emits:

```ts
await createSocketIOServer({
  cors: { origin: 'https://app.example.com' },
  serverOptions: { maxHttpBufferSize: 5 * 1024 * 1024 }, // 5 MB
})
```

`cors` is **optional**. Omit it when the browser reaches this server on its
own origin — Socket.IO then emits no CORS headers, which is same-origin only.
Supply it only for a genuinely cross-origin browser: naming a foreign origin is
naming where the code will run, and a repository that does not have to know
should not say.

The wrapper-owned fields (`cors` / `path` / `transports` / `ping*` /
`allowRequest`) take
precedence over the same keys in `serverOptions`. On Bun the engine-level options
(`maxHttpBufferSize`, the ping heartbeat, `upgradeTimeout`) are forwarded to
`@socket.io/bun-engine` too — so a configured `maxHttpBufferSize` actually applies
instead of silently truncating at 1 MB.

## Client — `createRealtimeClient`

```ts
import { createRealtimeClient } from 'stitchkit'
import { realtimeContract } from '@app/shared'

const socket = createRealtimeClient(realtimeContract, {
  url: 'https://api.example.com',
  retain: ['note:created'],
  onRejected: (event) => reportClientError(event),
  onRequestPhase: (event) => metrics.realtimeRequestPhase(event),
})

socket.connect()
socket.on('note:created', (note) => { /* typed note */ })
socket.emit('room:join', 'general', ({ joined }) => { /* typed + validated */ })
```

When an application already owns the low-level Stitchkit transport, bind the
contract without opening a second connection:

```ts
import { bindRealtimeClient, createSocketIOClient } from 'stitchkit'

const transport = createSocketIOClient({ url: 'https://api.example.com' })
const events = bindRealtimeClient(realtimeContract, transport, { onRejected })

transport.connect()       // lifecycle stays with the transport owner
events.on('note:created', handleNote)
await events.request('room:join', 'general', { timeoutMs: 5_000 })
```

The bound handle intentionally has no `connect()` or `disconnect()`. Its
`on`/`emit`/`request`, rejection and timeout semantics are exactly the path used
by `createRealtimeClient`; only transport construction/lifecycle differs.

## Snapshot + event state synchronization

`createLiveStateController` is the optional browser-safe state machine between a
validated transport binding and any renderer. It solves one problem: install a
snapshot and every event after that snapshot's consistency point without a race.
It does not create a socket, choose a cursor, retry a transport, store history or
invent ordering for the application.

```ts
import {
  createLiveStateController,
  type LiveStateEventDecision,
  type LiveStateSource,
} from 'stitchkit'

type View = { revision: number; rows: readonly Row[] }
type Change = { revision: number; row: Row }

const applyChange = (state: View, event: Change): LiveStateEventDecision<View> => {
  if (event.revision <= state.revision) return { outcome: 'duplicate' }
  if (event.revision !== state.revision + 1) return { outcome: 'gap' }
  return {
    outcome: 'applied',
    state: { revision: event.revision, rows: [...state.rows, event.row] },
  }
}

const live = createLiveStateController({
  source,
  applyEvent: applyChange,
  maxBufferedEvents: 128,
  maxBufferedBytes: 256 * 1024,
  sizeOfEvent: encodedChangeBytes,
})

const unsubscribe = live.subscribe(render)
await live.start()
// On a gap/overflow or source loss, choose when the UI should resync.
const status = live.getSnapshot()
if (status.phase === 'resync-required' || status.phase === 'unavailable') {
  await live.resync()
}

unsubscribe()
await live.close()
```

The source boundary is the important part:

```ts
interface LiveStateSource<State, Event> {
  open(input: {
    signal: AbortSignal
    onEvent(event: Event): void
    onUnavailable(): void
  }): Promise<{ snapshot: State; close(): void | Promise<void> }>
}
```

`onEvent` is available before `open()` begins asynchronous work. By the time
`open()` resolves, the source guarantees that every event after the returned
snapshot's consistency point has already been or will be passed to that callback.
The controller buffers early events within both explicit limits, installs the
snapshot, drains in order, then becomes `live`. A late result from an earlier
`resync()` generation is fenced. Non-cooperative caller-owned cleanup is asked to
stop but cannot hold controller settlement.

`subscribe()` listeners are synchronous external-store notifications: read the
published snapshot and schedule rendering elsewhere. A listener that returns a
Promise is removed after its first call, preventing unresolved UI work from
accumulating per event. Source `close()` must be idempotent because an abort-aware
binding may have started cleanup before the controller calls it.

At most two physical source `open()` / `close()` operations in total may remain
unsettled. If a caller-owned source ignores cancellation beyond that operation
bound, `resync()` returns
`unavailable/controller-capacity` without opening another generation. When a slot
settles, the controller publishes `resync-required/controller-capacity`; the host
may retry explicitly. This bounds controller-retained work without inventing a
transport retry loop.

### Socket.IO binding

Use an acknowledged operation whose server handler establishes the subscription
before it captures/returns the snapshot. For example, the server can join the
socket to the resource room, capture revision `N`, then acknowledge that snapshot;
ordered Socket.IO frames after that point reach the already-installed handler:

```ts
const source: LiveStateSource<View, Change> = {
  async open({ signal, onEvent, onUnavailable }) {
    const offEvent = socket.on('view:changed', onEvent)
    const offConnection = socket.onConnectionChange((connected) => {
      if (!connected) onUnavailable()
    })
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      offEvent()
      offConnection()
    }
    signal.addEventListener('abort', close, { once: true })

    try {
      const snapshot = await socket.request('view:open', { timeoutMs: 5_000 })
      return { snapshot, close }
    } catch (error) {
      close()
      throw error
    }
  },
}
```

Socket.IO still owns physical reconnect. A reconnected transport only means the
connection is open; call `resync()` when application state needs a fresh
generation. If the application has replay, its source may resume from its opaque
cursor and return an accepted consistency point. If history expired or a cursor is
incompatible, the source must acquire a fresh authoritative snapshot or reject the
open; the controller does not classify or compare opaque cursors itself.

### One-way HTTP stream binding

NDJSON/SSE can use the same receiver semantics when **one response generation**
starts with a schema-validated snapshot frame and every later frame is a validated
event. Attach `parseNDJSON` or the typed contract-stream reader, parse the first
frame before resolving `open()`, and pump remaining frames into `onEvent`. Abort
that response in `close()`.

A separate `GET /snapshot` followed by `GET /events` is not this boundary: a
change can land between the two requests and disappear unless the application
supplies a watermark/replay protocol. The controller intentionally cannot make
that uncoordinated recipe safe.

### Rendering, cache and process lifecycle

For replaceable progress, let the reducer replace the absolute view at each
accepted revision. For ordered records, append only the exact next revision and
return `gap` otherwise. Both use the same controller; their ordering policy stays
in their reducers. `getSnapshot()` + `subscribe()` works headlessly and with
`useSyncExternalStore`. A React Query application can update its existing query
cache from a subscriber after `phase === 'live'`; no second hook or store adapter
is required. Cache `markFresh` windows suppress local echoes, while revision/cursor
classification detects duplicates—those are different policies.

A server process that owns such a receiver can place `start()` and `close()` in
an existing `defineManagedResource` and include it in `createApplication`.
Readiness follows a successful `live` snapshot; shutdown calls `close()`. Stitchkit
does not add another supervisor, reconnect loop or durable event database.

When migrating a hand-written receiver, remove only the superseded attach/snapshot
race loop, retry timer and listener bookkeeping. Keep the application's schemas,
authorization, reducer, cursor/replay policy and durable storage. Development
proxying and Vite HMR remain frontend tooling; they are described in
[frontend integrations](./frontend-integrations.md) and never travel through live
application event envelopes.

The Agent harness control server follows the same ordering: it installs the
conversation attachment before awaiting the authoritative snapshot and rolls the
attachment back if that read fails. A host adapter installs its delivery callback,
issues `attach`, and supplies the returned snapshot through its live-state source;
the existing Agent cursor and view reducers still own runtime epochs, durable
versions and transcript projection.

### Request-response over realtime

For an event with an `ack` schema, `request()` is the Promise form of the same
native Socket.IO acknowledgement. Arguments and the resolved value are inferred
from the contract and validated on both sides:

```ts
const result = await socket.request(
  'room:join',
  'general',
  {
    timeoutMs: 5_000,
    onPhase: (phase) => roomJoinMetrics.record(phase),
  },
)
// result: { joined: boolean }
```

An event without `ack` cannot be passed to `request()` by type. A disconnected
client rejects immediately with `RealtimeRequestDisconnectedError`; an in-flight
disconnect uses the same error; an elapsed native acknowledgement timeout uses
`RealtimeRequestTimeoutError`. These are distinct stable classes and codes, so
never parse Socket.IO error text. An invalid acknowledgement still fires the
existing `onRejected` hook with phase `acknowledgement`, then rejects with
`RealtimeRequestInvalidAcknowledgementError`.

`timeoutMs` must be finite and greater than zero. Use acknowledgements only for
bounded request-response work. A job that runs for minutes, progress streaming,
or resumable delivery should use separate correlated events or the async
operation protocol; keeping one acknowledgement open is not a durable RPC/job
transport.

### Acknowledged-request phases

`createRealtimeClient` can expose the local boundary that a single Promise
normally hides:

```ts
const socket = createRealtimeClient(realtimeContract, {
  url,
  onRequestPhase: ({ requestId, event, phase, elapsedMs }) => {
    requestPhaseHistogram.record(elapsedMs, { requestId, event, phase })
  },
})
```

The hook is opt-in and each record has exactly four metadata fields: an opaque,
Kit-owned `requestId`, the contract event name, monotonic `elapsedMs`, and one
closed phase:

| Phase | Exact local boundary |
|-------|----------------------|
| `engine-handoff` | Engine.IO created the outbound message packet and accepted it into its write path |
| `engine-ack-received` | Engine.IO decoded the inbound acknowledgement message, before Socket.IO invokes the acknowledgement callback |
| `settled` | the acknowledgement callback ran and Stitchkit finished acknowledgement validation |
| `timeout` | the existing native acknowledgement timeout won |
| `disconnected` | the request began disconnected or an in-flight disconnect won |

Observation also works on non-localhost HTTP origins: identity generation uses
browser-compatible `crypto.getRandomValues`, not secure-context-only
`crypto.randomUUID`. A `requestId` is opaque local diagnostic identity, not a
promised UUID format, authentication token or transmitted field. Bun and Node
use the same mechanism; enabling observation adds no HTTPS requirement.

When a caller needs to join those phases to its own invocation, put `onPhase`
on that request's options and keep the caller identity in the hook's closure:

```ts
await socket.request('room:join', 'general', {
  timeoutMs: 5_000,
  onPhase: (phase) => recordPhase({ operationId, phase }),
})
```

The client-wide hook receives every observed request; a request hook receives
only its invocation. If the same function is supplied in both places it runs
once per phase. The closure is local: Stitchkit does not retain `operationId`,
add it to the event or transmit it to the peer. A request hook works without a
client-wide hook, and the no-hook path installs no phase listeners.

Engine handoff is not proof of a physical network write. Engine acknowledgement
receipt is not a remote clock, end-to-end RTT or proof that application
validation has run. The useful interval is local and monotonic:
`engine-ack-received → settled` isolates callback scheduling plus validation
from transport waiting.

Records never contain request arguments, acknowledgement values, raw packets,
credentials, URLs or query data. Concurrent requests are correlated internally
with Socket.IO acknowledgement ids, but those ids are never exposed. A timeout
or disconnect is terminal, a late packet cannot reopen the identity, and sync
or async observer failures are ignored so telemetry cannot change request
correctness. With no hook, no request identity, Engine.IO listener or correlation
map entry is created. The low-level `createSocketIOClient` implements the same
request option, so a non-owning `bindRealtimeClient` over that transport keeps
request-scoped observation without opening a second connection.

## Low-level transport

`createSocketIOClient` remains the low-level Socket.IO transport wrapper for
schema-agnostic infrastructure. Application wire events should use
`createRealtimeClient`; it adds the shared contract without replacing Socket.IO.
Use `bindRealtimeClient` when that low-level transport already exists.

### Durable subscriptions

`socket.on(...)` returns an unsubscribe and is **durable** — the handler is
re-attached to every socket the client builds, so it survives a reconnect. You
subscribe once; reconnection is the wrapper's problem, not yours.

`SocketIOClientConfig` takes `url`, `path`, `withCredentials` (cookies on the
handshake — default `true`), `auth`, `query`, `extraHeaders`, `transports`,
`reconnectionAttempts`, `reconnectionDelay`, `retain` (below), `onConnectError`
(handshake/connection failures — see the auth section) and `onDroppedEmit`
(observability for emits dropped while disconnected — see below).

### Honest emit — what happens while disconnected

`emit` has exactly three outcomes, in order:

1. **A local contract violation throws** (validated `RealtimeClient` only) —
   validation runs before the connection guard, even while disconnected.
2. **Disconnected → the emit is dropped**: `emit` returns `false` and the
   `onDroppedEmit` hook fires with the event name and wire arguments. This
   includes the short window right after `connect()` while the socket.io peer
   is still loading.
3. **Otherwise `emit` returns `true`** — handed to the transport, which is
   *not* a delivery guarantee.

The default is deliberately a drop, not a buffer: after a reconnect, durable
subscriptions and [sticky events](#sticky-events) replay current state
deterministically, instead of the server receiving an unordered backlog of
stale emits. What changed is that the drop is now observable — assert it
per-call (`if (!client.emit(...)) …`) or centrally:

```ts
const client = createSocketIOClient({
  url,
  onDroppedEmit: ({ event }) => metrics.count('realtime.dropped_emit', { event }),
})
```

Server-side emits (`realtime.emit`, `to(room).emit`, `connection.events.emit`)
always return `true` — a broadcast into an empty room is not a drop, and the
server has no disconnected state of this kind. For state that must survive
gaps, see [durability](#durability--idempotent--replay).

### Sticky events

A handler that subscribes **after** an event was emitted misses it — the UI stays
on stale state until the next emission. List those events in **`retain`** and the
client keeps each one's last payload and replays it to a handler the moment it
subscribes (and on the next subscribe after a re-render). It is the pub/sub
analogue of an MQTT *retained* message or an RxJS `BehaviorSubject`.

```ts
const client = createRealtimeClient(realtimeContract, {
  url,
  retain: ['presence:changed', 'job:state'],   // events to keep the last value of
})
client.connect()

// Later — even after the event already fired — this handler fires at once with
// the last value, then on every future change:
client.on('job:state', (s) => render(s))
```

The retained value survives a `disconnect()` / `connect()` cycle (the store lives
outside the socket). Only an event's **first** argument is retained.

For a pub/sub channel that is **not** Socket.IO (your own transport — see
[below](#bring-your-own-transport)), use the same memory directly:

```ts
import { createRetainedTopics } from 'stitchkit'

const topics = createRetainedTopics<{ 'job:state': JobState }>()
topics.record('job:state', state)                 // on every publish
topics.replay('job:state', (s) => render(s))      // for a late subscriber
```

### Handshake auth — cookie or token

By default the handshake carries cookies (`withCredentials: true`) — the right
fit for a browser app with a session cookie. A client that holds a token
explicitly (desktop, mobile, CLI, server-to-server) authenticates the
handshake with **`auth`** instead — the token reaches the server as
`socket.handshake.auth`:

```ts
// client — a function is re-read on every (re)connect, so a rotated token is
// picked up automatically; no need to recreate the client (or lose durable
// subscriptions). It may be async.
const socket = createRealtimeClient(realtimeContract, {
  url: 'https://api.example.com',
  auth: () => ({ token: getAccessToken() }),
})
```

```ts
// server — the typed identity gate: Zod-validate handshake.auth, verify,
// and the result lands in socket.data — typed all the way to onConnection.
import { verifyJwt } from 'stitchkit/server'

const socket = await createSocketIOServer({
  cors: { origin: 'https://app.example.com' },
  handshake: {
    schema: z.object({ token: z.string() }),
    verify: async ({ token }) => ({ user: await verifyJwt(token, secret) }),
  },
})

const realtime = bindRealtimeServer(realtimeContract, socket)
realtime.onConnection(({ raw }) => {
  raw.data.user // typed — no String(...) coercions, no casts
})
```

`verify` may be async (the wrapper runs it inside a settled promise chain —
raw async `io.use` middleware would leak an unhandled rejection); throwing or
returning `null` rejects the handshake **before** the connection handler and
before any event validation. A thrown error's raw message is logged
server-side and never reaches the unauthenticated peer — the wire always
carries the generic `handshake rejected` (the same never-leak policy as the
HTTP error normalizer). The schema itself must be synchronous (no async
refine/transform). Omit `verify` and the schema output itself is the
identity. The gate registers as the **first** middleware, so `socket.io.use(…)`
middlewares you add afterwards see the typed `socket.data` already in place.
Raw `io.use` remains available for anything beyond identity.

Type inference works on calls without explicit event generics (the
`bindRealtimeServer` lane above). With explicit generics TypeScript cannot
partially infer — pass the identity types too:
`createSocketIOServer<S, C, z.infer<typeof schema>, Identity>`.

A static object (`auth: { token }`) works too, but only the function form
re-reads on reconnect — prefer it for rotating tokens. `query` adds handshake
URL params (`socket.handshake.query`) — note its values are **strings** on the
wire, which is why the schema gate reads `auth`; `extraHeaders` adds handshake
headers, but in a browser those apply to the **polling** transport only (a
WebSocket upgrade cannot set request headers) — for browser WebSocket auth use
`auth`.

**A gate rejection is terminal for the client.** Unlike a transport-level
failure (which socket.io retries indefinitely), a middleware/handshake-gate
rejection stops the client: socket.io destroys its retry path and will not
reconnect on its own. The stitchkit client surfaces this through
**`onConnectError`** with `terminal: true` (and `data.code ===
'handshake_rejected'` for the built-in gate) and resets its connection intent —
so recovery is explicit: rotate the credential, call `connect()`, and the
function-form `auth` is re-read:

```ts
const client = createRealtimeClient(realtimeContract, {
  url: 'https://api.example.com',
  auth: () => ({ token: getAccessToken() }),
  onConnectError: ({ terminal }) => {
    if (terminal) refreshTokenThen(() => client.connect())
  },
})
```

If an auth producer throws or rejects, the wrapper sends an empty auth object —
the server gate then rejects it visibly (via `onConnectError`) instead of
leaving the handshake waiting forever.

## Cache bridge

**Using a validated realtime contract? Use `createRealtimeCacheBridge`.** A
realtime registry maps an event name to its *definition* (`{ args, ack }`),
while the plain bridge's event map expects the *handler function* at that
position. A validated socket satisfies the looser type structurally, so passing
one to `createCacheBridge` compiled and inferred every payload as `never` —
the error then landed on your own property access rather than on the seam.
`createRealtimeCacheBridge` performs the mapping; nothing runs differently.

```ts
import { createRealtimeCacheBridge } from 'stitchkit/react'

const bridge = createRealtimeCacheBridge<typeof contract.serverToClient>({
  socket: realtimeClient,
  queryClient,
  handlers: {
    noteUpdated: (note, { queryClient: qc }) => qc.setQueryData(noteKey(note.id), note),
  },
})
```

`createCacheBridge` syncs socket events into the TanStack Query cache — a server
push updates the UI with no refetch. It is transport-agnostic: it takes any
emitter with `on(event, handler) => unsubscribe`, which the
`createSocketIOClient` result satisfies.

```ts
import { createCacheBridge } from 'stitchkit/react'

const bridge = createCacheBridge({
  socket,
  queryClient,
  handlers: {
    'note:created': (note, ctx) => {
      if (ctx.isFresh(['notes'])) return   // skip the echo of our own mutation
      ctx.queryClient.invalidateQueries({ queryKey: ['notes'] })
    },
  },
})
bridge.connect()
```

### The echo problem

When the client makes a mutation, it updates the cache itself — and the server
also broadcasts the change back over the socket. Without care the UI updates
twice. `markFresh` plus a short freshness window solves it: mark a key fresh
right after a local mutation, and the bridge handler skips the echo.

```ts
// in the mutation:
onSuccess: () => bridge.markFresh(['notes'])
// in the handler:  if (ctx.isFresh(['notes'])) return
```

`createCacheBridge` is a convenience, not a requirement — any code can subscribe
to the socket and call `queryClient` directly. The bridge just centralises the
event-to-cache mapping and the echo guard.

### Entity cache handlers

The created / updated / deleted events of one entity almost always patch the
cache the same way: prepend to the list, replace by id, remove by id — plus the
detail query. `createEntityCacheHandlers` builds those three handlers from a
small config, so you wire them onto the bridge instead of hand-rolling the
updater per entity:

```ts
import { createEntityCacheHandlers } from 'stitchkit/react'

const widgetCache = createEntityCacheHandlers<Widget>({
  getId: (widget) => widget.id,
  getListItemId: (widget) => widget.id,
  toListItem: (widget) => widget,
  list: {
    key: ['widgets'],
    shape: 'paginated',
    createAt: 'start',
    updateMissing: 'skip',
  },
  detailKey: (event) => ['widgets', event.id],
})

createCacheBridge({ socket, queryClient, handlers: {
  widgetCreated: widgetCache.created,
  widgetUpdated: widgetCache.updated,
  widgetDeleted: widgetCache.deleted,
}})
```

The `list.shape` discriminant supports `array`, `paginated`, `infinite-array`
and `infinite-paginated`. Every mutation preserves the surrounding envelope,
page metadata and `pageParams`; an infinite create changes only the selected
edge page (`createAt: 'start' | 'end'`). Creates are deduplicated across every
cached page. `updateMissing` makes an absent update explicitly skip or insert.

Filtered query families can additionally declare membership per exact key and
evidence-aware total reconciliation:

```ts
list: {
  key: ['tickets'],
  shape: 'infinite-paginated',
  createAt: 'start',
  updateMissing: 'skip',
  membership: {
    evaluate: (event, queryKey) => membershipFor(event, queryKey),
    unknown: 'invalidate',
  },
  total: {
    mode: 'reconcile',
    unknown: 'invalidate',
    delta: ({ event, present, membership }) => provenDelta(event, present, membership),
  },
}
```

Membership is `include | exclude | unknown`. An excluded update removes an
existing row; an included one follows `updateMissing`. Unknown evidence never
guesses and either preserves or invalidates the exact query. The conservative
total policy increments only a non-duplicate create and decrements only a
delete/update whose membership is observed; unseen IDs are `unknown`. Supply
`delta` only when the event itself proves a stronger transition. Every page's
numeric `total` changes together while cursor metadata and `pageParams` remain
unchanged.

The event entity may be richer than a list row. Keep the full value in detail
cache, project it for lists, and provide the same comparator the backend uses:

```ts
const memberCache = createEntityCacheHandlers<Member, MemberListItem>({
  getId: (member) => member.id,
  getListItemId: (item) => item.id,
  toListItem: (member) => ({
    id: member.id,
    name: member.name,
    joinedAt: member.joinedAt,
  }),
  list: {
    key: (event) => {
      if (event.type !== 'deleted') {
        return ['workspaces', event.entity.workspaceId, 'members']
      }
      if ('workspaceId' in event.payload) {
        return ['workspaces', event.payload.workspaceId, 'members']
      }
      throw new Error('A scoped delete must carry its entity')
    },
    shape: 'array',
    createAt: 'start',
    updateMissing: 'skip',
    compare: (left, right) => left.joinedAt.localeCompare(right.joinedAt),
  },
  detailKey: (event) => ['members', event.id],
})
```

Static `QueryKey` values remain the short path. A key factory receives a typed
`created | updated | deleted` event, so scoped keys can use the full entity or
deleted payload without guessing. The same resolved detail key drives the
`isFresh` echo guard. Shape checks also leave neighbouring detail caches alone
when a list key is intentionally used as a partial query-key prefix.

The helper deliberately does **not** flatten pages, infer filter semantics,
derive a sort order or replace arbitrary `setQueryData` logic. Those remain
declared application policies; Stitchkit applies their generic cache mechanics.

## Raw binary lane (Bun)

For a high-throughput raw binary channel beside Socket.IO, use the orthogonal
composition boundary from
[ADR 0020](../decisions/0020-raw-websocket-lane.md).

`composeWebSocketHandlers` composes that one handler from several lanes. A raw
lane stamps its own marker onto `ws.data` at upgrade and is matched positively;
Socket.IO is the catch-all (`socketIoLane`, placed last) — so the engine's
opaque `ws.data` is never inspected, and the whole thing stays cast-free.

```ts
import {
  composeWebSocketHandlers,
  createServer,
  createSocketIOServer,
  socketIoLane,
  webSocketLane,
} from 'stitchkit/server'
import type { RawRoute } from 'stitchkit/server'
import type { ServerWebSocket, WebSocketHandler } from 'bun'

const socket = await createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
  cors: { origin: 'https://app.example.com' },
})

// 1. Discriminate the raw lane by a marker on ws.data (a type guard, cast-free
//    — the `in` operator narrows, no `as`).
interface PcmData { lane: 'pcm'; roomId: string }
function isPcm(ws: ServerWebSocket<unknown>): ws is ServerWebSocket<PcmData> {
  const data = ws.data
  return typeof data === 'object' && data !== null && 'lane' in data && data.lane === 'pcm'
}

// 2. Raw handlers — ws.data is typed PcmData, no casts.
const pcmHandlers: WebSocketHandler<PcmData> = {
  message(ws, frame) { ws.publish(ws.data.roomId, frame) },
}

// 3. An upgrade route stamps the marker (your auth + data live here).
const pcmRoute: RawRoute = {
  method: 'GET',
  path: '/ws/pcm',
  handler: (req, ctx) => {
    if (!ctx.server) throw new Error('needs a running Bun server')
    const ok = ctx.server.upgrade(req, { data: { lane: 'pcm', roomId: '…' } })
    return ok ? new Response(null) : new Response(null, { status: 400 })
  },
}

// 4. Compose — raw lane first, Socket.IO last. The tuning is server-wide, so
//    set maxPayloadLength to the most permissive lane (Socket.IO's default is
//    1 MB, its maxHttpBufferSize).
const websocket = composeWebSocketHandlers(
  [webSocketLane({ match: isPcm, handlers: pcmHandlers }), socketIoLane(socket.websocket)],
  { maxPayloadLength: 16 * 1024 * 1024 },
)

createServer({
  services,
  socket,
  websocket,
  rawRoutes: [pcmRoute],
})
```

Notes:

- **Bun-only.** On Node, Socket.IO attaches to the `node:http.Server` `upgrade`
  event (`serveNode({ socket })`); a raw lane there is a separate upgrade
  handler, not this composition. See [ADR 0020](../decisions/0020-raw-websocket-lane.md).
- The upgrade path must not collide with `/socket.io/*socketPath`.
- The tuning (`maxPayloadLength`, `idleTimeout`, `backpressureLimit`, …) is
  global — keep `idleTimeout` ≥ Socket.IO needs (> 2 × `pingInterval`).
- For high throughput, handle backpressure in the raw lane: `ws.send()` returns
  `-1` under pressure; resume on the `drain` callback.

## Bring-your-own transport

Sometimes the transport is neither HTTP nor Socket.IO — a desktop app whose UI
webview talks to its own local Bun sidecar over a raw WebSocket, an IPC channel,
a queue worker. You can still drive it from one `defineContract`: share the
contract's Zod schemas to validate each inbound frame, run your handlers, and
reuse the contract metadata below. You own **both** the wire (framing,
handshake, reconnect) *and* the per-call validate-run loop — stitchkit ships the
contract and its metadata, not a transport engine. A reliable-RPC-over-raw-
WebSocket engine would be a competing WebSocket transport
([ADR 0008](../decisions/0008-thin-wrappers.md)); the wire stays yours.

Two pieces of the contract carry straight over to a bring-your-own lane:

- **`source` is an open tag.** `TransportSource` is `'http' | 'mcp' | 'agent' |
  'cli' | (string & {})`, so a handler or hook can tell your transport's calls
  apart — tag them `source: 'local-ws'` and read `ctx.source`.
- **`idempotent` drives replay-on-reconnect** — see below.

### Durability — `idempotent` + replay

If the sidecar can restart mid-call, the client decides what to do with an
in-flight request on reconnect from the operation's **idempotency**, declared on
the contract:

```ts
export const runtimeContract = defineContract({ prefix: 'runtime' }, {
  'tasks.setDone': { method: 'POST', path: '/done', desc: '…',
    idempotent: true, input: taskDone, output: ok },     // re-send after reconnect — same result
  'capture.start': { method: 'POST', path: '/start', desc: '…',
    output: snapshot },                                   // unset → one-shot, do not re-send
})
```

`idempotent` rides through to `MethodDef.idempotent`; the core attaches no
behaviour. Your reconnect logic reads it: replay an idempotent call (the
durability guarantee — the user's action is not lost), reject a non-idempotent
one rather than fire a second side effect. Pair it with
[sticky events](#sticky-events) (`createRetainedTopics`) so a reconnected client
also catches up on the latest pushed state.

This is deliberately *not* a reliable-RPC engine — that would be a competing
WebSocket transport ([ADR 0008](../decisions/0008-thin-wrappers.md)). stitchkit
gives you the contract and the metadata (`idempotent`, the open `source` tag,
`createRetainedTopics`); the wire and the per-call execution stay yours. See
[ADR 0028](../decisions/0028-revert-contract-dispatcher.md).

## Authenticated room registry and replay

`bindSocketRegistry` composes over `bindRealtimeServer`; it never authenticates
a socket a second time and never creates another outbound validator. The
identity in `connection.raw.data` has already passed the Socket.IO handshake.

`rooms(identity)` names the rooms a connecting identity may be in; the registry
joins them and refuses a later `join` to any other. The disconnect listener is
attached before that lookup is awaited, so a socket that drops while its
permissions are still being resolved never becomes a member. `registry.room(name)` mints
the opaque `AuthorizedSocketRoom` for a name — the token proves the name came
through this registry, not that anyone is in the room, so a room with no open
tab is an ordinary `emitTo` target that reports zero recipients. The registry
owns join/leave, multiple sockets per identity, immutable snapshots and
listener cleanup.

Replay is revisioned: while a socket's snapshot is open, frames sent through
`emitTo` to its rooms are held back and delivered after the snapshot, so the
socket never sees a delta for state its snapshot already contains, nor a
snapshot that predates a delta it already received. A snapshot taken across a
`revision` change is retried up to `replayAttempts` (default 3). The hold-back buffer is
bounded by `maxBufferedFrames` (default 1000): past it the attempt is abandoned
and retried, and when the attempts are spent `onResyncRequired(socketId,
identity)` fires with nothing half-delivered — the application decides what a
resync means for that socket. A retry relies on the fresh snapshot carrying
what the abandoned frames carried, which holds when every emitted change also
moves `revision`; without a `revision` the registry has no way to tell, so
declare one wherever replay matters. Room tokens are recognised, not
remembered: a token the application keeps stays valid for the life of the
registry, and a name seen once does not live on in a map. This ordering exists only for frames that go
through `emitTo`; a broadcast through `realtime.to(room).emit` reaches the
socket immediately, replay or not, so keep room traffic whose order matters
relative to the snapshot on the registry.
