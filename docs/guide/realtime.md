# Realtime

stitchkit's realtime layer is [Socket.IO](https://socket.io) — `polling`
fallback, heartbeats, acks, a mature client. stitchkit does not ship its own
WebSocket engine; it ships thin, typed wrappers over Socket.IO and a bridge that
syncs socket events into the TanStack Query cache. See
[ADR 0008](../decisions/0008-thin-wrappers.md).

## Typed events

Declare the event maps once, in the shared module — both sides import them:

```ts
// shared/contracts.ts
export interface ServerToClientEvents {
  'note:created': (note: Note) => void
  'note:deleted': (id: string) => void
}
export interface ClientToServerEvents {
  'room:join': (room: string) => void
}
```

Every `emit` and `on` on both the server and client wrapper is typed against
these maps.

## Server — `createSocketIOServer`

```ts
import { createServer, createSocketIOServer } from 'stitchkit/server'

const socket = await createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
  cors: { origin: 'https://app.example.com' },
})

socket.io.on('connection', (s) => {
  s.on('room:join', (room) => s.join(room))   // rooms, handshake auth — your logic
})
```

It returns a handle with three pieces, all wired into `createServer`:

```ts
createServer({
  services,
  websocket: socket.websocket,   // → Bun.serve websocket handlers
  rawRoutes: [socket.route],     // ready-made /socket.io/* route
})

// elsewhere — broadcast:
socket.io.emit('note:created', note)
```

| Handle field | Purpose |
|--------------|---------|
| `io` | the typed Socket.IO server — attach `connection` handlers, broadcast |
| `websocket` | Bun WebSocket handlers — pass to `createServer({ websocket })` |
| `route` | the `/socket.io/*` raw route — pass to `createServer({ rawRoutes })` |

`SocketIOServerConfig` also takes `path`, `transports`, `pingTimeout` and
`pingInterval`. For anything else socket.io's `ServerOptions` exposes, use the
typed **`serverOptions`** passthrough — most often `maxHttpBufferSize` to lift the
1 MB default for large emits:

```ts
await createSocketIOServer({
  cors: { origin: 'https://app.example.com' },
  serverOptions: { maxHttpBufferSize: 5 * 1024 * 1024 }, // 5 MB
})
```

The wrapper-owned fields (`cors` / `path` / `transports` / `ping*`) take
precedence over the same keys in `serverOptions`. On Bun the engine-level options
(`maxHttpBufferSize`, the ping heartbeat, `upgradeTimeout`) are forwarded to
`@socket.io/bun-engine` too — so a configured `maxHttpBufferSize` actually applies
instead of silently truncating at 1 MB.

## Client — `createSocketIOClient`

```ts
import { createSocketIOClient } from 'stitchkit'

const socket = createSocketIOClient<ServerToClientEvents, ClientToServerEvents>({
  url: 'https://api.example.com',
})

socket.connect()
socket.on('note:created', (note) => { /* typed note */ })
socket.emit('room:join', 'general')   // typed
```

### Durable subscriptions

`socket.on(...)` returns an unsubscribe and is **durable** — the handler is
re-attached to every socket the client builds, so it survives a reconnect. You
subscribe once; reconnection is the wrapper's problem, not yours.

`SocketIOClientConfig` takes `url`, `path`, `withCredentials` (cookies on the
handshake — default `true`), `auth`, `query`, `extraHeaders`, `transports`,
`reconnectionAttempts`, `reconnectionDelay` and `retain` (below).

### Sticky events

A handler that subscribes **after** an event was emitted misses it — the UI stays
on stale state until the next emission. List those events in **`retain`** and the
client keeps each one's last payload and replays it to a handler the moment it
subscribes (and on the next subscribe after a re-render). It is the pub/sub
analogue of an MQTT *retained* message or an RxJS `BehaviorSubject`.

```ts
const client = createSocketIOClient<ServerEvents, ClientEvents>({
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
const socket = createSocketIOClient<ServerToClientEvents, ClientToServerEvents>({
  url: 'https://api.example.com',
  auth: () => ({ token: getAccessToken() }),
})
```

```ts
// server — the gate is your logic, on socket.handshake.auth
import { verifyJwt } from 'stitchkit/server'

socket.io.use(async (s, next) => {
  const token = s.handshake.auth.token
  if (typeof token !== 'string') return next(new Error('unauthorized'))
  try {
    s.data.user = await verifyJwt(token, secret)
    next()
  } catch {
    next(new Error('unauthorized'))
  }
})
```

A static object (`auth: { token }`) works too, but only the function form
re-reads on reconnect — prefer it for rotating tokens. `query` adds handshake
URL params (`socket.handshake.query`); `extraHeaders` adds handshake headers,
but in a browser those apply to the **polling** transport only (a WebSocket
upgrade cannot set request headers) — for browser WebSocket auth use `auth`.
If an auth producer throws or rejects, the wrapper sends an empty auth object so
the server gate can reject it instead of leaving the handshake waiting forever.

On a hard auth failure Socket.IO emits `connect_error` and keeps retrying
(`reconnectionAttempts` defaults to `Infinity`) — set a finite value if a
rejected token should stop hammering the server.

## Cache bridge

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

## Raw binary lane (Bun)

Socket.IO carries binary fine — for most streams a binary event (`pcm(frame)`)
is enough. But a *truly* high-throughput binary channel (video, large
transfers) may want a raw WebSocket with no Socket.IO framing, on the **same**
port. On Bun that is awkward: `Bun.serve` has a single `websocket` handler, and
`createSocketIOServer().websocket` claims it.

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
  websocket,
  rawRoutes: [socket.route, pcmRoute],
})
```

Notes:

- **Bun-only.** On Node, Socket.IO attaches to the `node:http.Server` `upgrade`
  event (`serveNode({ socket })`); a raw lane there is a separate upgrade
  handler, not this composition. See [ADR 0020](../decisions/0020-raw-websocket-lane.md).
- The upgrade path must not collide with `/socket.io/*`.
- The tuning (`maxPayloadLength`, `idleTimeout`, `backpressureLimit`, …) is
  global — keep `idleTimeout` ≥ Socket.IO needs (> 2 × `pingInterval`).
- For high throughput, handle backpressure in the raw lane: `ws.send()` returns
  `-1` under pressure; resume on the `drain` callback.

## Bring-your-own transport

Sometimes the transport is neither HTTP nor Socket.IO — a desktop app whose UI
webview talks to its own local Bun sidecar over a raw WebSocket, an IPC channel,
a queue worker. You still want one contract: a `defineContract` with typed
client/server, Zod validation and a typed error envelope, not a hand-rolled
method registry alongside it.

stitchkit ships the **executor**, not the transport. `createContractDispatcher`
runs a contract method by its key through the *same* core as the MCP / agent
mounts — same validation, the same `{ ok, data } | { ok: false, code, … }`
envelope, the same hooks and `beforeHandle` scope gate. You own the wire (framing,
handshake, reconnect) and call `dispatch` per inbound frame.

```ts
import { createContractDispatcher } from 'stitchkit/tools'
import { implement } from 'stitchkit/server'

const service = implement(runtimeContract, { 'tasks.setDone': (ctx) => doIt(ctx.input), … })

const dispatcher = createContractDispatcher(service, { source: 'local-ws' })

// In your raw-WebSocket server, per `{ id, method, params }` frame:
ws.onmessage = async (frame) => {
  const { id, method, params } = JSON.parse(frame.data)
  const result = await dispatcher.dispatch(method, params)   // validates + runs
  ws.send(JSON.stringify({ id, ...result }))                 // { ok, data } | { ok:false, code, … }
}
```

`dispatch` never throws for a normal call — a handler error becomes a failed
result, and an unknown method is a `NOT_FOUND` result. Pass `hooks`
(`beforeToolCall` / `afterToolCall`) and `lifecycle.beforeHandle` to audit and
scope-guard exactly like the other transports. Tag calls with your own
`source` — `TransportSource` is an open union.

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
gives you the executor and the metadata; the wire stays yours. See
[ADR 0027](../decisions/0027-transport-neutral-contract-execution.md).
