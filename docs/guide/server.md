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
| `files` | inferred `File` map or receiver values | the endpoint's typed multipart fields |
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

### Per-scope handler context — `createScopedImplement`

`createImplement<Ctx>()` gives every handler the **same** context type. In an app
where each scope guarantees different injected fields, that single type is a
superset: a `public` handler is told it has a `userId` the runtime never injects
there. `createScopedImplement` types each handler by its endpoint's **effective**
scope instead — the endpoint's own `scope`, else the contract's:

```ts
import { createScopedImplement } from 'stitchkit/server'

export const implementFor = createScopedImplement<{
  public: object                                 // no extra fields
  user: { userId: string }
  admin: { userId: string; isAdmin: boolean }
}>()

implementFor(postsContract, {
  list: (ctx) => listPosts(ctx.userId),          // contract scope 'user'
  purge: (ctx) => (ctx.isAdmin ? purge() : []),  // endpoint scope 'admin'
  ping: () => ({ ok: true }),                    // endpoint scope 'public'
})
```

The map is **type-only** — scope fields are types, so there is no runtime
argument and no `{} as UserFields` at the call site. `'public'` must be a key:
a contract without a `scope` is `'public'`. A scope outside the map is a compile
error on that endpoint, naming the scope.

Three boundaries worth knowing:

- A field of another scope is not a compile error on access — `RuntimeContext`
  keeps its `[key: string]: unknown` index signature (transports write through
  it). It degrades to `unknown`, so it can no longer pose as a `string`; using it
  in a typed position fails.
- The map states what **your** `beforeHandle` / `createAuthHook.inject` puts on
  the context. The framework does not verify a hand-written claim (→ ADR 0075) —
  so prefer not to write one: scoped auth rules declare their contribution by
  performing it, and `createScopedImplement<AuthScopes<typeof hook>>()` derives
  the map from the hook
  ([details](./auth-and-errors.md#scoped-rules--the-map-createscopedimplement-consumes),
  → ADR 0078).
- An endpoint hoisted out of the contract literal widens its `scope` to `string`,
  which is no key of any map, and lands in the error branch. An endpoint whose
  `scope` is added by a conditional spread is optional, so it resolves to **both**
  scopes and is typed against what they guarantee in common. Write endpoints
  inline for the precise type.
- Scope keys are string literals. A map declared as an index signature
  (`Record<string, …>`) makes every scope valid and disables the check.

The same map has a registry form and a streaming form:

```ts
// one contract registry, handlers still typed per endpoint scope
const implementAll = createScopedImplementRegistry<Scopes>()
export const services = implementAll(apiContractRegistry, { posts, users })

// a service FILE declares its handlers typed but unbound — binding happens
// once, in the registry. Curried out of necessity: one call cannot both take
// the contract and contextually infer the handlers from it.
export const posts = implementFor.declare(postsContract)({
  list: (ctx) => listPosts(ctx.userId),          // ctx typed per endpoint scope
  purge: (ctx) => (ctx.isAdmin ? purge() : []),
})

// a streaming multipart handler that reads its scope's fields. The endpoint
// must declare its own `scope`, and only that literal is accepted: an endpoint
// inheriting the contract's scope cannot be verified from here, and guessing it
// would rebuild the superset this factory removes.
implementFor(mediaContract, {
  upload: implementFor.stream('admin', mediaContract.endpoints.upload, {
    files: { file: receiveFile },
    handler: ({ files, userId }) => store(files.file, userId),
  }),
})
```

Outside a scoped app, `createMultipartStream<Ctx>()` does for streaming handlers
what `createImplement<Ctx>()` does for ordinary ones. Plain
`defineMultipartStream` still gives the loose `RuntimeContext`.

### `implementRegistry` — one backend registry

When contracts already live in one literal registry, bind the backend from that
same source instead of maintaining a parallel `services` list:

```ts
import { implementRegistry } from 'stitchkit/server'

export const apiServices = implementRegistry(apiContractRegistry, {
  users: usersHandlers,
  posts: postsHandlers,
})
```

Every registry key is required, extra keys fail, and each handler map is checked
against its own contract. The returned service order follows the contract
registry order — and the same services ride along under `.byKey`, so a consumer
whose registry keys are load-bearing (filtering a tool surface per caller) never
rebuilds a prefix lookup by hand:

```ts
const services = implementRegistry(apiContractRegistry, handlers)
createServer({ services })                       // the array, as before
const visible = [services.byKey.users]           // the same objects, by key
```

`createImplementRegistry<AppContext>()` fixes the application
context once, like `createImplement` does for a single contract. Runtime callers
also fail first on missing/extra keys and on a duplicate prefix **within one
scope** — the same prefix under two different group scopes is legal (their URLs
are separated by `scopePrefixes`, and a genuine path clash is the router's own
construction error).

The registry is intentionally flat: every key must point to one concrete
`defineContract()` result. Composed namespace arrays are mounted explicitly with
`implement()` because they do not have a one-key-to-one-handler-map boundary.

## `createServer`

`createServer(config)` builds the router and starts `Bun.serve()`. It returns a
managed handle with `url`, `port`, the concrete server under `runtime`, live
`status`, and one idempotent `shutdown()` lifecycle.

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
| `maxJsonBodyBytes` | optional JSON body cap (bytes); per-route value overrides; unset preserves existing behaviour |
| `port` / `hostname` | listen address — port defaults to `3000` |
| `unix` | listen on a unix domain socket instead of TCP — `'/run/app.sock'` or `{ path, mode }` (see below) |
| `cors` | CORS policy — `{ origin, credentials, methods, headers, exposeHeaders }`. `origin` is **required** when `cors` is present: pass an explicit origin (or list), or `'*'` to deliberately allow every origin — an origin-less config is a construction error, never a silent wildcard. Omit `cors` entirely to emit no CORS headers. |
| `hooks` | lifecycle hooks (see below) |
| `logging` | `true` for built-in request logs, or a `LoggingConfig` (see below) |
| `traceId` | override per-request trace-id resolution — may return `undefined` to fall back |
| `wrapFetch` | compose wrappers around the finished handler (request context, audit) |
| `socket` | full Stitchkit Socket.IO handle; route, default WebSocket handler and shutdown are mounted once |
| `websocket` | custom Bun WebSocket handler; with `socket`, this is the explicit composed handler |
| `development` / `bun` | passthrough to `Bun.serve` |

Native Bun `routes` are intentionally not accepted: Bun matches them before
`fetch`, so they could bypass shutdown admission. Use `rawRoutes`; they retain
the Fetch `Request → Response` model and participate in lifecycle tracking.

### Local daemon over a unix socket

A local daemon whose door is a socket file needs no TCP port at all:

```ts
const server = createServer({
  services,
  unix: { path: '/run/my-daemon.sock', mode: 0o600 },
})
```

`unix` is mutually exclusive with `port`/`hostname` (construction error). The
handle stays honest: `server.url` is `unix:///run/my-daemon.sock` — an
identifier, **not** a fetchable address (dial the path with
`createHttpClient({ unix })`, [client guide](client.md#unix-domain-sockets)) —
and `server.port` is `0`.

Socket-file hygiene is built in. A stale file left by a killed process is
reclaimed automatically: the path is probed, and only a socket that is owned by
the current user **and** answers no live listener is removed before binding
(best-effort — two processes racing the same path resolve through the loud
bind error of the loser). A regular file at the path, another user's socket, or
a live listener each fail with a specific error instead of being unlinked. A
clean `server.shutdown()` removes the file.

`mode` tightens the socket file permissions after listen. Bun creates the file
`0755` under a normal umask — since `connect(2)` requires *write* permission
that is already owner-only in practice — but when access to the socket **is**
the credential, set `mode: 0o600` explicitly and let the filesystem be the
policy. The Socket.IO lifecycle (`socket`) cannot mount on a unix listener
(socket.io clients dial TCP only — construction error); Bun's own WebSocket
client cannot dial a unix path either. Unix listeners are Bun-only: `srvx`
resolves a numeric port unconditionally, so `stitchkit/node` does not offer
`unix` (no half-support).

### Managed shutdown

```ts
const server = createServer({ services, socket })

const result = await server.shutdown({
  gracePeriodMs: 30_000,
  forceTimeoutMs: 5_000,
  retryAfterSeconds: 5,
  signal: shutdownController.signal,
})
```

The first call closes HTTP and Socket.IO admission, then gives the complete
graceful request/realtime/runtime chain one `gracePeriodMs` budget. If that
budget or the external signal forces destructive teardown, `forceTimeoutMs`
bounds physical completion separately. Repeated calls return the same Promise;
the first options win. New
ordinary HTTP work receives `503`, `Retry-After` and `Connection: close` outside
`wrapFetch`. `result.outcome` is `clean` or `forced`; a forced result preserves
the pending snapshot and reason while final pending counters describe the
post-close transport state. A graceful phase error still runs forced cleanup and
then rejects with the original error; a forced transport that cannot confirm
completion before `forceTimeoutMs` rejects instead of reporting a false zero.
`runtime` is a diagnostics escape hatch, not a second canonical stop path.

### Trusted HTTPS in development

Stitchkit does not own local certificate generation or a frontend development
server. When a device or browser feature requires a secure context, generate a
trusted certificate outside the application (for example with `mkcert`) and pass
its files through the Bun server boundary:

```ts
import { readFileSync } from 'node:fs'
import { createServer } from 'stitchkit/server'

createServer({
  services,
  hostname: '0.0.0.0',
  bun: {
    tls: {
      cert: readFileSync('./certs/dev.pem'),
      key: readFileSync('./certs/dev-key.pem'),
    },
  },
})
```

Trust the certificate authority on each test device and configure the frontend's
HTTPS mode in that frontend project. Certificate renewal, interface discovery
and device onboarding remain application infrastructure rather than framework
or starter behavior.

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

Status `499` has one framework-wide meaning: the client closed the request. It
is logged at `info`, not under the ordinary `4xx → warn` rule. A confirmed
disconnect is not sent through project `onError`, `normalizeError` or the
request-error recorder; an `AbortError` while the request signal is still active
remains an internal failure. A runtime abort reason may be preserved by identity
through at most eight cycle-safe standard `cause` links; error messages and codes
are never classifiers. The same rule applies when the disconnect happens while
Stitchkit is reading a JSON upload body: bounded reads race every pending stream
read against the request signal and never parse a cancelled partial body. `499`
is transport telemetry, not a response declared in the contract or generated
OpenAPI document.

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
    { pathPrefix: '/api/admin', services: [adminService], hooks: { authorize: adminAuth } },
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
    { pathPrefix: '/tenants/:tenantId', services: [widgetsService], hooks: { authorize: auth } },
  ],
})
// widgetsService (prefix 'widgets') → /tenants/:tenantId/widgets/...
```

**Where the prefix param lands.** The router matches the *full* path (group
prefix + service prefix + endpoint path) and collects every `:param` — from the
prefix and from the endpoint alike — into one set. Each is spread onto the
context root, so it is available as **`ctx.tenantId`** (a raw `string`) in the
`authorize` hook, handler and later lifecycle hooks:

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

**Trailing wildcard.** A contract path may end in a named wildcard.
`/app/:slug/*filePath` matches
both `/app/foo` and nested paths such as `/app/foo/a/b`; the collected params are
`{ slug: 'foo', filePath: '' }` and `{ slug: 'foo', filePath: 'a/b' }`
respectively. Put `filePath` in the endpoint's `params` schema to keep it in
typed `ctx.params`. Each captured segment is URL-decoded before the remainder is
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
Scope stays a free string (unless the contract is authored through
`createContractFactory<Scope>()`); the core attaches no meaning beyond this lookup
(→ ADR 0024). When each scope needs a different handler-context shape, use
[`createScopedImplement`](#per-scope-handler-context--createscopedimplement)
rather than a single superset context.

## Lifecycle hooks

Five hooks wrap every contract request. Route matching and path-param
validation happen before authorization; body/query parsing happens only after
authorization succeeds:

```ts
createServer({
  services,
  hooks: {
    onRequest(req)               { /* logging, global rate limit — may return a Response to short-circuit */ },
    authorize(ctx, endpoint)     { /* identity + scope, before body reads — throw to reject */ },
    beforeHandle(ctx, endpoint)  { /* validated-input preconditions */ },
    afterHandle(ctx, result, ep) { /* transform the result data */ },
    onError(ctx, error, ep)      { /* custom error response — return a Response */ },
  },
})
```

- **`onRequest`** — runs first, with the raw `Request`. Return a `Response` to
  short-circuit (a rate-limit 429, a redirect); return nothing to continue.
- **`authorize`** — runs after route matching and validated path params, but
  before query, JSON or multipart parsing. It receives request metadata and
  params, with `input: undefined` and no files. This is the HTTP home of
  [`createAuthHook`](./auth-and-errors.md#createauthhook).
- **`beforeHandle`** — runs after the complete context has been parsed and
  validated, immediately before the handler. Put input-dependent application
  preconditions here, not authentication.
- **`afterHandle`** — receives the handler result; return a replacement to
  transform it.
- **`onError`** — receives any thrown error; return a `Response` to customise
  the error body. Without it, errors render through the standard envelope. A
  confirmed client disconnect is a transport cancellation rather than an
  application error and deliberately bypasses this hook.

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

### Choosing an HTTP boundary

| Need | Contract declaration | What remains framework-owned |
|------|----------------------|------------------------------|
| Typed JSON request/response | ordinary `input` / `output` | routing, auth, schemas, hooks, client, OpenAPI |
| HMAC-signed JSON | `rawBody: true` + `input` / `output` | the same pipeline plus the exact decoded request text |
| File upload | typed `multipart` descriptor | file cardinality/limits, text input validation and client form encoding |
| File, stream or redirect response behind contract auth | `rawResponse: true` | request parsing, route identity, auth and typed URL/client surface |
| Transport that cannot be expressed as the contract pipeline | `RawRoute` | only raw routing, CORS, request hook and error normalisation |

`rawBody` is for JSON signatures: verify `ctx.rawBody` against the signature
header, then use the already validated `ctx.input`. A provider-specific binary
signature protocol, OAuth callback or WebSocket upgrade can be a real raw route,
but it must own its validation and authorization explicitly.

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
2xx code. Without it, an endpoint with `output` uses `200`; an endpoint without
`output` uses `204`. A nullable output returns JSON `null` with status `200` —
the runtime value never turns a declared response body into no content.
`undefined` violates a declared output, while returning non-null data without an
output schema is also a server fault. Bodyless `204`/`205` cannot be combined
with `output`. Redirects, streams, files and handler-owned status/body logic
remain [`rawResponse: true`](#raw-response-endpoints).

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

A path may be exact, carry `:param` segments, or end in `/*filePath` for a prefix
wildcard — and the two combine: `/app/:slug/*filePath` matches `/app/x/a/b` with
`ctx.params.slug === 'x'` and the remainder in `ctx.params.filePath` (a SPA
deep-link fallback). List more specific routes before the wildcard — the first
match wins. `staticRoute()` builds a raw route that serves a directory.

At startup Stitchkit rejects exact duplicates, equivalent parameter shapes
(`/users/:id` vs `/users/:userId`) and any later raw route completely hidden by
an earlier raw route. Partial overlap stays legal, including the recommended
specific-before-wildcard order. `GET` and `HEAD` remain independent because that
is how the actual raw matcher dispatches them. Raw-vs-contract overlap remains a
startup diagnostic naming the bypassed contract identity and scope.

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
import { defineContract } from 'stitchkit/contract'
import { implement, serveFile } from 'stitchkit/server'
import { z } from 'zod'

const MediaParams = z.object({ id: z.string() })
const media = defineContract({ prefix: 'media' }, {
  download: {
    method: 'GET', path: '/:id', desc: 'Download media',
    params: MediaParams, rawResponse: true, contentType: 'video/mp4',
  },
  inspect: {
    method: 'HEAD', path: '/:id', desc: 'Inspect media',
    params: MediaParams, rawResponse: true, contentType: 'video/mp4',
  },
})

const mediaService = implement(media, {
  download: ({ req, params }) =>
    serveFile(req, { path: pathForId(params.id), filename: 'clip.mp4' }),
  inspect: ({ req, params }) =>
    serveFile(req, { path: pathForId(params.id), filename: 'clip.mp4' }),
})
```

GET and HEAD are separate operations deliberately: declaring GET never creates
a hidden HEAD alias. Both travel through the normal contract router, params,
lifecycle/RBAC and request logging. A HEAD handler may inspect the raw query via
`ctx.req.url`, but cannot declare a request input schema or body.

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
| `parseMultipart()` | parse a typed buffered/streaming multipart descriptor |
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

The contract owns one descriptor for buffered and streaming delivery:

```ts
const uploads = defineContract({ prefix: 'uploads' }, {
  create: {
    method: 'POST', path: '/', desc: 'Upload media',
    input: UploadMetadataSchema,
    output: UploadedMediaSchema,
    multipart: {
      maxRequestBytes: 220 * 1024 * 1024,
      maxFieldBytes: 64 * 1024,
      files: {
        cover: { required: false, maxBytes: 10 * 1024 * 1024, contentTypes: ['image/*'] },
        media: { multiple: true, maxFiles: 4, maxBytes: 50 * 1024 * 1024 },
      },
    },
  },
})
```

Buffered delivery is the default. Each file becomes a Web `File`; single,
optional and multiple cardinality is inferred on `ctx.files`. The request cap
defaults to **25 MB** when omitted. The parser measures actual bytes including
boundaries and headers instead of trusting `Content-Length`; per-file bytes,
file count, text-field bytes and declared MIME policy are enforced while
reading. Text fields remain strings until the endpoint's Zod `input` parses
them.

For large files, set `delivery: 'stream'` and define receivers. A receiver gets
a Web `ReadableStream<Uint8Array>` and writes directly to consumer-owned
storage; Stitchkit holds only bounded parser state:

```ts
const streamingUploads = defineContract({ prefix: 'uploads' }, {
  create: {
    method: 'POST', path: '/', desc: 'Upload media',
    input: UploadMetadataSchema,
    output: UploadedMediaSchema,
    multipart: {
      delivery: 'stream',
      maxRequestBytes: 260 * 1024 * 1024,
      files: { media: { maxBytes: 250 * 1024 * 1024, contentTypes: ['video/*'] } },
    },
  },
})

const service = implement(streamingUploads, {
  create: defineMultipartStream(streamingUploads.endpoints.create, {
    files: {
      media: async ({ metadata, stream, signal }) => {
        const stored = await storage.write({ metadata, stream, signal })
        return {
          value: stored,
          cleanup: () => storage.remove(stored.key),
        }
      },
    },
    handler: ({ input, files }) => mediaService.attach(input, files.media),
  }),
})
```

Receivers run sequentially in multipart order. A multiple receiver runs once
per part and the handler gets an ordered value array. `cleanup` is registered
as soon as a receiver materialises external state. Disconnect, size/policy
failure, a later receiver/text validation failure or handler failure rolls
accepted handles back exactly once in reverse order. After handler success,
ownership transfers to the application.

Authorization always completes before the multipart parser or any receiver is
started. The receiver signal is tied to the request abort. The core does not
provide filesystem/S3 adapters, retries, antivirus or a distributed
storage/database transaction; those policies belong to the application.

`parseMultipart(req, descriptor, fieldsSchema?, receivers?)` is also exported
for a custom raw transport. It uses the same descriptor and returns
`{ files, fields, rollback }`; contract endpoints should prefer the automatic
dispatcher path.

### Rate limiting

```ts
import { createRateLimiter } from 'stitchkit/server'

const limiter = createRateLimiter()
// in onRequest:
if (!limiter.check(ip, { window: 60_000, max: 60 })) {
  return new Response('Too many', { status: 429 })
}
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
ending in a named wildcard such as `/*filePath`, Stitchkit keeps the literal
runtime path, omits `filePath` from the
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
