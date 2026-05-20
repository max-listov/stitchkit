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

const socket = createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
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
`pingInterval`.

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
handshake — default `true`), `transports`, `reconnectionAttempts` and
`reconnectionDelay`.

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
