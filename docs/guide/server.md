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
| `scopePrefixes` | `scope → path prefix` map — mount `services` by `service.scope` (see below) |
| `rawRoutes` | non-contract routes (see below) |
| `maxUploadBytes` | default multipart upload cap (bytes); per-route `EndpointDef.maxUploadBytes` overrides |
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

### Param prefixes (resource-scoped paths)

A group `pathPrefix` may contain `:param` segments — the spine of a multi-tenant
or resource-scoped API:

```ts
createServer({
  groups: [
    { pathPrefix: '/tenants/:tenantId', services: [widgetsService], hooks: { beforeHandle: auth } },
  ],
})
// widgetsService (prefix 'widgets') → /tenants/:tenantId/widgets/...
```

**Where the prefix param lands.** The router matches the *full* path (group
prefix + service prefix + endpoint path) and collects every `:param` — from the
prefix and from the endpoint alike — into one set. Each is spread onto the
context root, so it is available as **`ctx.tenantId`** (a raw `string`) in both
the handler and `beforeHandle`/`afterHandle`/`onError`:

```ts
beforeHandle: (ctx) => {
  const tenantId = ctx.tenantId   // string — from the group prefix
}
```

`ctx.tenantId` is typed `unknown` (it rides the context index signature) — narrow
it (`String(ctx.tenantId)` / a guard) at the read site.

**Relation to the endpoint `params` schema.** `ctx.params` is the endpoint's
`params` schema **parsed against all collected path params** (prefix + endpoint).
So to get the prefix param *inside* typed `ctx.params`, add it to that schema:

```ts
// endpoint under /tenants/:tenantId
{ method: 'GET', path: '/:widgetId', desc: 'Get a widget',
  params: z.object({ tenantId: z.string(), widgetId: z.string() }) }
// → ctx.params.tenantId and ctx.params.widgetId both typed
```

⚠️ A **`z.strictObject`** params schema that omits the prefix param **rejects the
request** (the extra `tenantId` key fails the strict parse). Either include every
prefix param in the schema, use a non-strict `z.object` (extra keys are dropped
from `ctx.params`, but `ctx.tenantId` still works), or read the param off the
context root.

### Scope-driven mounting (`scopePrefixes`)

With several scopes, hand-partitioning services into `groups` duplicates the
scope↔prefix mapping. Instead, map `scope → prefix` once and pass the flat
`services` list — each entry mounts under `scopePrefixes[service.scope]`:

```ts
createServer({
  services,   // mixed scopes, listed once
  scopePrefixes: { tenant: 'tenants/:tenantId', project: 'projects/:projectId' },
})
// scope 'tenant'  → /tenants/:tenantId/<prefix>/...
// scope 'project' → /projects/:projectId/<prefix>/...
// unmapped scope  → mounted flat
```

A prefix may carry `:param` segments (they land on the context exactly as above).
Services listed under explicit `groups` are unaffected — the group prefix wins.
Scope stays a free string; the core attaches no meaning beyond this lookup
(→ ADR 0024). When each scope needs a different handler-context shape, declare one
`createImplement<Ctx>()` per scope rather than a single superset context.

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
wildcard — and the two combine: `/app/:slug/*` matches `/app/x/a/b` with
`ctx.params.slug === 'x'` and the remainder in `ctx.params['*']` (a SPA
deep-link fallback). List more specific routes before the wildcard — the first
match wins. `staticRoute()` builds a raw route that serves a directory.

### Raw-route helpers

A raw route gives up the contract pipeline, so three things get re-implemented in
every one. `stitchkit/server` ships them — conveniences, not a second pipeline
(no auth, no schema gate beyond `parseBody`):

```ts
import { respondJson, errorResponse, parseBody, badRequest } from 'stitchkit/server'

handler: async (req) => {
  try {
    const body = await parseBody(req, MySchema)      // typed value, or null (no throw)
    if (!body) throw badRequest('invalid body')      // helpers THROW an AppError
    return respondJson(await myService(body))         // JSON; 204 when null/undefined
  } catch (err) {
    return errorResponse(err)                         // same envelope as a contract route
  }
}
```

The error helpers (`badRequest`, `notFound`, …) **throw** an `AppError`, so raise
them inside the `try` and let `errorResponse(err)` render it — that runs any
thrown value through the framework's `normalizeError`, so a raw route returns the
**identical** `{ error: { code, message, … } }` shape (and `x-request-id`) a
contract route does.

### Serving files & Range requests

`staticRoute` is basic on purpose — it reads the whole file into memory and has
no `Range` or conditional support; put a CDN in front, or use it for small web
assets. To serve **media** (video / audio / large downloads) that a browser must
seek and cache, use **`serveFile`** (Bun) — it streams the requested byte range
and speaks the conditional-request half of RFC 7233 / 9110:

```ts
import { serveFile } from 'stitchkit/server'

createServer({
  services,
  rawRoutes: [
    {
      // `ALL` — so a HEAD probe also reaches serveFile (raw routes match the
      // method exactly, and `HEAD` is not a contract `HttpMethod`); serveFile
      // itself handles GET + HEAD and answers 405 for anything else.
      method: 'ALL',
      path: '/media/:id',
      handler: (req, ctx) =>
        serveFile(req, { path: pathForId(ctx.params.id), filename: 'clip.mp4' }),
    },
  ],
})
```

`serveFile` returns `206` (range, with `Content-Range` + `Content-Length`), `200`
(full), `416` (unsatisfiable, `Content-Range: bytes */size`), `304`
(`If-None-Match` / `If-Modified-Since`), `404` (missing) or `405` (non GET/HEAD).
It always sets `Accept-Ranges: bytes`, a weak `ETag` and `Last-Modified` (so
`If-Range` keeps a changing file from being stitched from stale + fresh bytes),
and `nosniff`. `Content-Type` is auto-detected from the path — override it, or
pass `disposition` / `cacheControl` / `etag: false`, via the options.

`serveFile` takes an explicit `path` and trusts it — **the caller owns
containment**. For a URL-derived path use `staticRoute` (which enforces it) or
`isWithinDir` first. The byte-range parser is exported on its own as
`parseByteRange(header, size)` for direct use and testing. → ADR 0023.

## Server primitives

`stitchkit/server` also exports the primitives most APIs need. Each is a small,
focused helper — not a sub-framework.

| Helper | Does |
|--------|------|
| `serveFile()` | serve a file with `Range` / `304` / `HEAD` (media seeking) |
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

The upload cap defaults to **25 MB**. Raise it per route with
`EndpointDef.maxUploadBytes`, or set a server-wide default with
`createServer({ maxUploadBytes })` — a per-route value wins over the global:

```ts
// contract
upload: { method: 'POST', path: '/', desc: 'Upload a video',
          multipart: 'file', maxUploadBytes: 200 * 1024 * 1024 }

// server — default for every multipart route that declares no own cap
createServer({ services, maxUploadBytes: 50 * 1024 * 1024 })
```

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
