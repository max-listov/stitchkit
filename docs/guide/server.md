# HTTP server

stitchkit serves contracts on `Bun.serve()` directly — no Hono, no Elysia, no
Express. You bind a contract to handlers with `implement()`, then mount the
result on `createServer()`.

## `implement`

`implement(contract, handlers)` type-checks each handler against its endpoint's
schemas and returns a `ServiceDef` to mount.

```ts
import { implement } from 'stitchkit/server'
import { users } from '../shared/contracts'

const usersService = implement(users, {
  list:   ()    => db.users.findMany(),
  create: (ctx) => db.users.create(ctx.input),       // ctx.input: typed
  get:    (ctx) => db.users.findById(ctx.params.id), // ctx.params: typed
  delete: (ctx) => db.users.delete(ctx.params.id),
})
```

A handler may be sync or async. Its return value is checked against the
endpoint's `output` schema; an endpoint without `output` returns nothing.

### The handler context

Every handler receives one `ctx` argument:

| `ctx` field | Type | Source |
|-------------|------|--------|
| `params` | inferred from `params` schema | parsed path params |
| `input` | inferred from `input` schema | parsed body / query |
| `file` | `File` | the `multipart` upload, if any |
| `source` | `'http' \| 'mcp' \| 'agent'` | the transport that invoked the handler |
| `traceId` | `string` | per-request trace id |
| `ipAddress` | `string` | caller IP |
| `userAgent` | `string` | caller user-agent |

The same handler runs for HTTP, MCP and agent calls — `ctx.source` tells you
which. Anything an auth hook attaches (e.g. the resolved user) is also on `ctx`.

### `createImplement` — a fixed context type

To type `ctx` with your app's extras (the user an auth hook injects), fix the
context type once:

```ts
import { createImplement } from 'stitchkit/server'

interface AppContext extends RuntimeContext { user: User | null }

export const implement = createImplement<AppContext>()
// every implement() call now has ctx.user typed
```

## `createServer`

`createServer(config)` builds the router and starts `Bun.serve()`. It returns
the Bun server instance.

```ts
import { createServer } from 'stitchkit/server'

createServer({
  services: [usersService, postsService],
  port: 3000,
  cors: { origin: 'https://app.example.com' },
  hooks: { /* … */ },
  logging: true,
})
```

`createHandler(config)` is the same router as a bare `(req) => Promise<Response>`
function — no `Bun.serve`. Use it in tests, or to embed stitchkit in another
server. See [Testing & deployment](./testing-and-deployment.md).

### `ServerConfig`

| Field | Purpose |
|-------|---------|
| `services` | `ServiceDef[]` mounted at the root |
| `groups` | route groups — a shared path prefix and hooks (see below) |
| `rawRoutes` | non-contract routes (see below) |
| `port` / `hostname` | listen address — port defaults to `3000` |
| `cors` | CORS policy — `{ origin, … }` |
| `hooks` | lifecycle hooks (see below) |
| `logging` | `true` for built-in request logs, or a custom `StitchLogger` |
| `traceId` | override per-request trace-id resolution |
| `websocket` | Bun WebSocket handlers — e.g. from `createSocketIOServer` |
| `routes` / `development` / `bun` | passthrough to `Bun.serve` |

## Route groups

A group gives a set of services a shared path prefix and its own hooks:

```ts
createServer({
  groups: [
    { pathPrefix: '/api',       services: [usersService, postsService] },
    { pathPrefix: '/api/admin', services: [adminService], hooks: { beforeHandle: adminAuth } },
  ],
})
```

Each service's own `prefix` is appended to the group prefix — `usersService`
above is served at `/api/users`.

## Lifecycle hooks

Four hooks wrap every contract request, in order:

```ts
createServer({
  services,
  hooks: {
    onRequest(req)               { /* logging, global rate limit — may return a Response to short-circuit */ },
    beforeHandle(ctx, endpoint)  { /* auth, scope checks — throw to reject */ },
    afterHandle(ctx, result, ep) { /* transform the result, set cache headers */ },
    onError(ctx, error, ep)      { /* custom error response — return a Response */ },
  },
})
```

- **`onRequest`** — runs first, with the raw `Request`. Return a `Response` to
  short-circuit (a rate-limit 429, a redirect); return nothing to continue.
- **`beforeHandle`** — runs after the context is built, before the handler.
  Throw an `AppError` to reject. This is where auth lives —
  [`createAuthHook`](./auth-and-errors.md#createauthhook) is a `beforeHandle`.
- **`afterHandle`** — receives the handler result; return a replacement to
  transform it.
- **`onError`** — receives any thrown error; return a `Response` to customise
  the error body. Without it, errors render through the standard envelope.

Hooks see `RuntimeContext` (loose types); handlers see `HandlerContext` (typed).
That split is deliberate — see [ADR 0003](../decisions/0003-two-context-types.md).

## Raw routes

Some routes cannot be a clean JSON contract — an OAuth redirect, a webhook with
signature verification, static files, the Socket.IO endpoint. `rawRoutes` are
plain `Request → Response` handlers, matched by the same router (shared CORS and
`onRequest`) but with no schema parsing and no `beforeHandle` gate — a raw route
authorises itself.

```ts
createServer({
  services,
  rawRoutes: [
    {
      method: 'GET',
      path: '/health',
      handler: () => Response.json({ status: 'ok' }),
    },
    {
      method: 'POST',
      path: '/webhooks/:provider',
      handler: (req, ctx) => handleWebhook(ctx.params.provider, req),
    },
  ],
})
```

A path may be exact, carry `:param` segments, or end in `/*` for a prefix
wildcard. `staticRoute()` builds a raw route that serves a directory.

## Server primitives

`stitchkit/server` also exports the primitives most APIs need. Each is a small,
focused helper — not a sub-framework.

| Helper | Does |
|--------|------|
| `streamSSE()` | turn an `AsyncGenerator` into a Server-Sent-Events `Response` |
| `parseMultipart()` | parse a `multipart/form-data` request with a size cap |
| `createRateLimiter()` | per-key token-bucket rate limiting |
| `createCache()` + `cacheHeaders()` | in-memory TTL cache; `Cache-Control` builder |
| `createEventBus<EventMap>()` | typed in-process pub/sub |

### SSE streaming

```ts
import { streamSSE } from 'stitchkit/server'

async function* tokens() { yield 'a'; yield 'b' }
return streamSSE(tokens())            // → a text/event-stream Response
```

The client side is [`parseSSE`](./client.md#sse).

### Multipart

```ts
import { parseMultipart } from 'stitchkit/server'

const { file, fields } = await parseMultipart(req, { maxBytes: 10_000_000 })
```

When an endpoint declares `multipart`, the framework parses the upload for you
and the file arrives as `ctx.file` — call `parseMultipart` directly only from a
raw route.

### Rate limiting

```ts
import { createRateLimiter } from 'stitchkit/server'

const limiter = createRateLimiter({ capacity: 60, refillPerSecond: 1 })
// in onRequest: if (!limiter.take(ip)) return new Response('Too many', { status: 429 })
```

### Event bus

```ts
import { createEventBus } from 'stitchkit/server'

const bus = createEventBus<{ 'user.created': { id: string } }>()
bus.on('user.created', ({ id }) => sendWelcome(id))
bus.emit('user.created', { id: '1' })
```

A typed in-process pub/sub — decouple a handler from the side effects of its
write without reaching for an external queue.
