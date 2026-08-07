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
| `maxJsonBodyBytes` | optional JSON body cap (bytes); per-route value overrides; unset preserves existing behaviour |
| `port` / `hostname` | listen address — port defaults to `3000` |
| `cors` | CORS policy — `{ origin, credentials, methods, headers, exposeHeaders }` |
| `hooks` | lifecycle hooks (see below) |
| `logging` | `true` for built-in request logs, or a `LoggingConfig` (see below) |
| `traceId` | override per-request trace-id resolution — may return `undefined` to fall back |
| `wrapFetch` | compose wrappers around the finished handler (request context, audit) |
| `websocket` | Bun WebSocket handlers — e.g. from `createSocketIOServer` |
| `routes` / `development` / `bun` | passthrough to `Bun.serve` |

### Request logging

`logging: true` is shorthand for `logging: {}` — **any object turns logging
on**, and the fields tune it:

```ts
createServer({
  services,
  logging: {
    // What the built-in formatter writes. Omit it and it follows NODE_ENV.
    format: 'json',
    // Route lines into your stack instead of the built-in formatter.
    logger: myLogger,
    // Silence noise. Runs after the built-in filter (framework assets,
    // favicon, preflights), so it can only quieten more.
    skip: (_req, url) => url.pathname === '/health' || url.pathname.startsWith('/socket.io/'),
    // Extra fields on the completion line.
    enrich: (req, _url, { status }) => ({
      userAgent: req.headers.get('user-agent') ?? undefined,
      cacheable: status === 200,
    }),
  },
})
```

### Two formats, and who chooses

| `format` | What it writes | Carries `enrich` / context identity |
|---|---|---|
| `'pretty'` | two coloured lines per request — `→` on arrival, `←` on completion | no — a line sized for a terminal is not a record |
| `'json'` | one structured line per completed request | yes |

Unset, `format` follows `NODE_ENV`: `json` under `production`, `pretty`
otherwise. That default is read **per request** — not at import, not when this
package was built — so it reflects the environment your app actually runs in.
Set `format` and the environment stops being consulted at all.

**If your project validates its environment through a single door** — a Zod
schema, `@t3-oss/env-core`, anything of that shape — set `format` explicitly
from *your* value rather than leaning on the default. The library reads raw
`process.env`, which is a second source of truth: let the two disagree on one
deployment and production writes `pretty` without a word.

```ts
import { env } from '@/config'
createServer({ services, logging: { format: env.NODE_ENV === 'production' ? 'json' : 'pretty' } })
```

`format` applies to the **built-in** formatter only. With `logger` set, your
sink always receives the structured object, in every environment — the format
is not involved.

**Want the structured line in development?** Set `format: 'json'`. That is the
way to see what `enrich` and the request context actually put on the record;
changing `NODE_ENV` is not needed, and neither is deploying.

Three more things about `enrich`:

- It runs at close, when the request body is already consumed.
- The framework owns `traceId`, `method`, `path`, `status`, `durationMs`,
  `errorCode` and `ip` in both structured sinks; the built-in JSON line also
  owns `ts`, `level` and `msg`. Its value wins a collision, and a discarded key
  warns once per handler rather than disappearing silently.
- `errorCode` has one outcome-aware exception: enrichment may supply it for a
  `4xx`/`5xx` response when the framework derived no code, such as an error
  `Response` returned by a raw route. It cannot add one to a `2xx`/`3xx` or
  replace a framework-derived code.
- A throw in `skip` or `enrich` is swallowed; neither can fail a request.

With an observability context active, the structured line also carries `userId`,
`serviceName`, `action` and `dimensions` for free. See
[Observability](./observability.md).

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

**Trailing wildcard.** A contract path may end in `/*`. `/app/:slug/*` matches
both `/app/foo` and nested paths such as `/app/foo/a/b`; the collected params are
`{ slug: 'foo', '*': '' }` and `{ slug: 'foo', '*': 'a/b' }` respectively. Put
the quoted `'*'` field in the endpoint's `params` schema to keep it in typed
`ctx.params`. Each captured segment is URL-decoded before the remainder is
joined, so encoded spaces and reserved characters reach the handler as their
semantic values while `/` remains the segment boundary. Static and named-param
routes are matched before a catch-all, so a
more specific endpoint wins regardless of declaration order. The same matcher
drives `405 Allow` resolution.

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
    afterHandle(ctx, result, ep) { /* transform the result data */ },
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

## Signed JSON webhooks

A provider signs the original JSON text, not `JSON.stringify(ctx.input)`.
Declare `rawBody: true` to retain the same decoded text the router reads while
keeping normal Zod validation:

```ts
const webhooks = defineContract(
  { prefix: 'webhooks' },
  {
    receive: {
      method: 'POST', path: '/provider', desc: 'Receive a signed event',
      rawBody: true,
      maxJsonBodyBytes: 256 * 1024,
      input: ProviderEventSchema,
      output: z.object({ accepted: z.boolean() }),
    },
  },
)

receive: async (ctx) => {
  const signature = ctx.req.headers.get('x-signature')
  await verifyWebhookHmac(ctx.rawBody, signature) // guaranteed string
  return { accepted: true }
}
```

This endpoint is HTTP-only and cannot be multipart or exposed as a tool. The
router sets `ctx.rawBody` before JSON/Zod validation, so `onError` can inspect it
after malformed JSON or a schema failure. Endpoints without `rawBody: true` do
not retain the text. `maxJsonBodyBytes` may also be set once on `createServer` /
`createHandler`; a route value wins. Both limits are opt-in and abort an
oversized stream before it is fully buffered. → ADR 0051

## Typed JSON response metadata

A JSON endpoint that must attach dynamic HTTP headers while preserving typed
output declares `responseMeta`. The handler still returns ordinary data:

```ts
const auth = defineContract({ prefix: 'auth' }, {
  complete: {
    method: 'POST', path: '/complete', desc: 'Complete authentication',
    input: CompleteAuthSchema,
    output: AuthUserSchema,
    responseMeta: { status: 200 },
  },
})

complete: async ({ input, response }) => {
  const result = await authenticate(input.token)
  response.headers.append('Set-Cookie', session.set(result.sessionId))
  response.headers.append('Set-Cookie', preferences.set(result.preferencesId))
  return result.user
}
```

`ctx.response.headers` is a fresh Web Fetch `Headers` bag per request. `append`
preserves repeated `Set-Cookie` values on Bun and Node. The endpoint is
HTTP-only, but its typed client method still resolves to `AuthUser` — not
`Response` — and the final data still passes group/global `afterHandle` and the
declared `output` schema exactly once.

`responseMeta.status` is static contract metadata and OpenAPI publishes the same
2xx code. Without it, data keeps status `200` and no-data keeps `204`. Bodyless
`204`/`205` cannot be combined with `output`. Redirects, streams, files and
handler-owned status/body logic remain [`rawResponse: true`](#raw-response-endpoints).

Collected headers are merged only after the complete success pipeline. A
handler, hook or output-validation failure discards them. `Content-Type`,
`Content-Length`, `x-request-id` and every `Access-Control-*` header remain
framework-owned; trying to set one fails loudly with the endpoint identity.
→ [ADR 0052](../decisions/0052-typed-json-response-metadata.md)

## Raw-response endpoints

An endpoint that answers with **bytes rather than data** — a PDF download, a
file, an SSE stream — declares `rawResponse: true` and returns the `Response` itself:

```ts
// contract
export const documents = defineContract(
  { prefix: 'documents', scope: 'admin' },
  {
    download: {
      method: 'GET', path: '/:id/pdf', desc: 'Download a document as a PDF',
      params: z.object({ id: z.uuid() }),
      rawResponse: true, contentType: 'application/pdf',
    },
  },
)

// handler — no guard on the first line; `beforeHandle` already ran
download: (ctx) => serveFile(ctx.req, { path: pathFor(ctx.params.id),
                                        filename: 'offer.pdf' }),
```

The request half is untouched: `params`, `input` and `multipart` parse and
validate exactly as elsewhere, and the endpoint goes through `beforeHandle` — so
the **auth gate applies without a guard in the handler**. Only the response is
handed over, so there is no `output` schema, `afterHandle` is skipped (it
transforms data; there is none) and the endpoint is HTTP-only: never an MCP
tool, an agent tool or a CLI command. Declaring `output`, `toolName`, `ui`,
`annotations` or a non-HTTP `expose` alongside `rawResponse` is a type error, and throws
at definition time for a contract assembled at runtime.

On the typed client the method resolves to the untouched `Response` — the
filename lives in `Content-Disposition`, so a `Blob` alone would lose it:

```ts
const client = createClient(documents, http)
const res = await client.download({ id })          // Response
const name = res.headers.get('Content-Disposition')
const blob = await res.blob()
```

When the browser should navigate or assign the endpoint directly to `src`, use
[`createUrlBuilder`](./client.md#contract-url-builders). Raw-response GET methods
are included, while mutation and multipart methods are intentionally absent.

Cross-origin, remember that those headers are readable only because CORS exposes
them — see [`cors.exposeHeaders`](#serving-files--range-requests).

**Raw response or [raw route](#raw-routes)?** Both hand the `Response` to your
code. A raw-response *endpoint* stays in the contract: only its response is
raw — it is still routed, gated, typed and documented like every other endpoint.
A raw *route* is outside the contract entirely — no schemas, no auth gate, no
client — which is what you want for an OAuth redirect or a non-JSON webhook. A
signed JSON webhook can stay validated through
[`rawBody: true`](#signed-json-webhooks).

If an endpoint returns typed JSON and only needs an additional status/header,
use [`responseMeta`](#typed-json-response-metadata), not `rawResponse`: the raw
variant deliberately transfers response ownership and changes the client result
to `Response`.

⚠️ **Delete the old raw route when you move an endpoint into the contract.** Raw
routes are matched **first**, so a leftover one keeps serving the bytes and the
contract endpoint — with its auth gate — never runs. stitchkit warns at startup
when a raw route shadows a contract route, naming both and the scope being
bypassed; treat that warning as a bug.

⚠️ **A path built from user input needs a containment check.** `staticRoute`
enforces it; `serveFile` deliberately leaves it to the caller, so an endpoint
serving `/:filename` must not pass it through:

```ts
import { isWithinDir, serveFile } from 'stitchkit/server'
import { resolve } from 'node:path'

const ROOT = resolve('./uploads')

file: (ctx) => {
  const target = resolve(ROOT, ctx.params.filename)
  // `../../etc/passwd` resolves outside ROOT — reject before touching disk.
  if (!isWithinDir(ROOT, target)) throw notFound('File not found')
  return serveFile(ctx.req, { path: target })
},
```

`implementRemote` proxies a raw-response endpoint like any other — the remote
`Response` is forwarded verbatim. Request headers are not relayed, so a `Range`
sent to the proxy does not reach the origin and the full body comes back.
→ ADR 0038.

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

Cross-origin, the browser lets JavaScript read only the CORS-safelisted response
headers. stitchkit therefore exposes the download-relevant ones by default
(`Content-Disposition`, `Content-Range`, `ETag`, …) — without that a `fetch`-based
download cannot recover the file's name. Override with `cors.exposeHeaders`
(extend `DEFAULT_CORS_EXPOSE_HEADERS` rather than replacing it), or pass `[]` to
emit none.

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

`streamSSE` returns a `Response`, so its endpoint declares
[`rawResponse: true`](#raw-response-endpoints) — in a plain contract handler the response
would be serialized into `{}` (that now fails loudly instead of shipping silently).

```ts
import { streamSSE } from 'stitchkit/server'

// contract
stream: { method: 'GET', path: '/stream', desc: 'Stream tokens',
          rawResponse: true, contentType: 'text/event-stream' },

// handler
async function* tokens() { yield 'a'; yield 'b' }
stream: () => streamSSE(tokens()),    // → a text/event-stream Response
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

## OpenAPI

`generateOpenApiDocument` builds an OpenAPI 3.1 document straight from the
contracts — the contract *is* the spec, no decorators or hand-maintained
annotations (→ ADR 0018). `openApiRoute` serves it as a raw route:

```ts
import { generateOpenApiDocument, openApiRoute } from 'stitchkit/server'

const doc = generateOpenApiDocument({
  info: { title: 'My API', version: '1.0.0' },
  services: [users, orders],
})
createServer({ services: [users, orders], rawRoutes: [openApiRoute('/openapi.json', doc)] })
```

Only HTTP-exposed methods appear (an MCP/agent-only tool is skipped).

OpenAPI 3.1 has no standard multi-segment path parameter. For a contract path
ending in `/*`, Stitchkit keeps the literal runtime path, omits `*` from the
standard `in: path` parameter list, and emits
`x-stitchkit-trailing-wildcard` on the operation with its parameter name,
schema and semantics. A generic OpenAPI client therefore cannot invent
catch-all expansion; use Stitchkit's typed client or teach the generator that
extension.

### Curating the spec — `includeMethod`

To publish a **subset** — a public spec that advertises only some methods
without revealing the rest — pass `includeMethod`. It keeps the core generic:
*you* decide the policy, filtering on anything the method carries. The
recommended declarative allowlist marks endpoints with the existing `meta`
passthrough and keeps those:

```ts
// contract — declarative, one source of truth
getBalance: { method: 'GET', path: '/balance', desc: '…', scope: 'account',
              meta: { public: true }, output: BalanceSchema }

// generation — the app's policy
const publicDoc = generateOpenApiDocument({
  info: { title: 'Public API', version: '1.0.0' },
  services: [account],
  includeMethod: (m) => m.meta?.public === true,
})
```

An excluded method's whole entry — path *and* every schema inlined within it —
is simply never emitted, so nothing about a hidden endpoint leaks.

> **The filter advertises; it does not authorize.** Hiding a method from the
> spec does **not** protect it — it is still callable, and the auth `scope` gate
> is the only thing guarding it. And because `openApiRoute` closes over the
> document you hand it, the filter only matters if you feed it a filtered one:
> serve **two** documents — a full internal spec and a filtered public spec on
> separate routes — never one unfiltered `openApiRoute` on a public path.

```ts
const internal = openApiRoute('/internal/openapi.json', fullDoc)   // behind auth
const publicSpec = openApiRoute('/openapi.json', publicDoc)         // curated
```
