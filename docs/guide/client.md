# Typed client

From a contract, `createClient` builds a fully-typed client — one method per
endpoint, arguments and result inferred from the schemas. There is no codegen
step: the types come straight from the contract import.

## `createHttpClient`

The HTTP client is the transport. It wraps [`ky`](https://github.com/sindresorhus/ky)
and adds cookie auth, SSR cookie forwarding, error parsing into `ApiError`, a
`401 → unauthorized` event stream and safe transport retry.

```ts
import { contractEndpointMatchers, createHttpClient } from 'stitchkit'
import { publicAuth } from '../shared/contracts'

const http = createHttpClient({
  baseUrl: '/api',
  suppressUnauthorizedFor: contractEndpointMatchers(publicAuth, ['complete', 'verify']),
})
```

The returned `ConfiguredHttpClient` keeps that `baseUrl` as a readonly public
field. Besides executing requests, it can therefore seed contract URL builders
without repeating transport configuration.

### `HttpClientConfig`

| Field | Default | Purpose |
|-------|---------|---------|
| `baseUrl` | — | URL prefix for every request |
| `timeout` | `30000` | request timeout, ms |
| `credentials` | `'include'` | fetch credentials mode |
| `retry` | 2 retries after the initial GET; network errors only | transport retry policy |
| `headers` | — | extra headers — an object, or a function re-run per request |
| `suppressUnauthorizedFor` | `[]` | exact contract-derived operation matchers whose expected 401 does not emit `unauthorized` |
| `parseError` | built-in | map an error body to `{ code, message, details, hint }` |
| `trace` | `false` | emit a W3C `traceparent` header on every request |
| `unix` | — | dial a unix domain socket instead of TCP (Bun only, see below) |

`headers` as a function is the hook for runtime tokens — a bearer token or any
short-lived credential — re-evaluated on every request.

Expected 401 policy is explicit and contract-driven. Name the operations you
mean with `contractEndpointMatchers(contract, ['login'])`, or omit the second
argument to select every HTTP operation in that contract. Pass the same
`ContractClientConfig` as the typed client when routes use a static or dynamic
`pathPrefix`; dynamic matchers require `stripPrefixKeys`, so the helper can
compile the prefix structure without a concrete tenant id.

**Matching is by PATH, not by operation.** Each named operation compiles to its
path pattern, matched exactly by segments including params and trailing
wildcards — so a shared *prefix* never suppresses a neighbour, but two
operations on the **same path** are one matcher. If `login` is `POST /session`
and `session` is `GET /session`, naming `login` suppresses the expected-401
signal for both, and a real expired session stops raising `unauthorized`. Give
an operation you must distinguish a path of its own, or narrow the policy with
your own `(pathname) => boolean`.

### Unix domain sockets

The same typed client dials a local daemon's socket file through an explicit,
owned Bun/Node transport ([server side](server.md#local-daemon-over-a-unix-socket)):

```ts
import { createHttpClient } from 'stitchkit'
import { createUnixClientTransport } from 'stitchkit/server' // or stitchkit/node

const transport = createUnixClientTransport({
  socketPath: '/run/my-daemon.sock',
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
})
const http = createHttpClient({
  baseUrl: 'http://my-daemon', // URL/Host source; never dialled as TCP
  fetch: transport.fetch,
  retry: { limit: 0 },
})
const daemon = createClient(daemonContract, http)

// At application shutdown:
await transport.close()
```

`baseUrl` stays required because it supplies the URL and `Host` header. The
adapter structurally owns dispatch: relative and absolute redirects use the same
socket, and a missing socket cannot fall through to that host over TCP. Defaults
are 16 MiB request/response bodies, 64 KiB headers, 30 s to response headers,
eight connections and five redirects.

`maxHeaderBytes` is enforced before exposing a response. Bun's owned parser
counts the complete response head in wire bytes, including the status line and
terminating blank line. Node passes the same configured integer unchanged to
`http.request({ maxHeaderSize })`, so its native parser's documented header-size
accounting is authoritative there. Exceeding either ceiling yields
`UNIX_HEADERS_TOO_LARGE` with `delivery: 'response-received'`. A stalled body
pauses its socket, and resuming preserves the exact chunked body.

`UnixClientTransportError` carries a stable `code` and `delivery`:
`not-dispatched`, `possibly-dispatched` or `response-received`. Only the first
proves that the remote operation did not begin; Stitchkit never silently retries
an ambiguous write. Response consumption/cancellation belongs to the operation,
and `close()` interrupts active work and destroys owned connections.

**A caller's cancellation reaches the server on both lanes.** The transport picks
a raw-socket lane under Bun and `node:http` elsewhere, and both propagate
`AbortSignal` the same way: aborting the request tears the connection down, and
the handler's `ctx.signal` fires — measured at roughly 300 ms for a 200 ms abort
over either lane, matching plain TCP. `close()` is a different thing: it ends the
*transport*, not one request, and a request-level abort does not close it.

The one way to see cancellation appear not to work is to pass the signal to the
plain callable — `api.thing(args, { signal })` — where options are ignored in
silence. See [per-call cancellation](#per-call-cancellation): `withOptions` is the
only door.

The response total is a unary-body policy, not a stream-buffer measurement. A
long-lived NDJSON/SSE client opts into streaming explicitly instead of choosing
an arbitrarily large integer:

```ts
const streamTransport = createUnixClientTransport({
  socketPath: '/run/my-daemon.sock',
  responseBodyMode: 'streaming',
})
const streamClient = createClient(streamContract, {
  baseUrl: 'http://my-daemon',
  fetch: streamTransport.fetch,
})
```

`streaming` removes only the cumulative lifetime response limit. It cannot be
combined with `maxResponseBytes`; request/header/connection bounds, socket
pause/resume, cancellation and strict HTTP framing remain active. The stream
descriptor's `maxFrameBytes` bounds each protocol frame, and the application
still owns any queue it builds after consuming those frames. Use a separate
default transport for finite calls that must retain the 16 MiB unary ceiling.
The adapter never infers this policy from `Content-Type`. → ADR 0125.

The legacy `createHttpClient({ unix: '/absolute/path' })` spelling remains a
Bun-only convenience. On a non-Bun runtime it now refuses before dispatch
instead of ignoring the selection and dialing TCP. `unix` and an injected
`fetch` are mutually exclusive; use `createUnixClientTransport` for portable,
explicit lifecycle ownership. → ADR 0116.

`trace: true` mints a fresh root trace per request. The stitchkit server
[continues an inbound `traceparent`](./observability.md#trace-context), so the
browser call, the HTTP handler and every nested tool call share one trace id
end-to-end. A `traceparent` you set yourself (via `headers`) always wins.

Retry is deliberately conservative: only a connection that never landed (a
network error), only on idempotent `GET`. A server that *responded* with a 5xx
is the data layer's call (TanStack Query), not the transport's — retrying in
both places multiplies attempts. `retry.limit` counts retries after the initial
attempt, so the default `2` permits at most three total attempts. The default
`statusCodes: []` does not replay HTTP responses; explicit `methods` or
`statusCodes` expand that policy when a project has a proven idempotent case.

Inside Next.js 16 server rendering, the first attempt still uses Next's normal
request memoization. If Ky authorizes a retry after a network rejection,
Stitchkit passes that retry's current `Request.signal` in the second fetch
argument and materializes the current Request as URL + init. Next 16.3 otherwise
merges `init` into a Request before its dedupe layer and loses the explicit
signal opt-out. The retry therefore performs a new network attempt instead of
returning the cached rejection. This adapter does not broaden retry policy: POST, unconfigured HTTP
statuses, cancellation and exhausted budgets retain the rules above.

## `createClient`

```ts
import { createClient } from 'stitchkit'
import { users } from '../shared/contracts'

export const api = createClient(users, http)

await api.list()                   // GET    /users
await api.create({ name: 'Max' })  // POST   /users      body: { name }
await api.get({ id: '1' })         // GET    /users/1
await api.update({ id: '1', name: 'M' })  // PUT /users/1  body: { name }
await api.delete({ id: '1' })      // DELETE /users/1
```

The client follows response presence from the contract, not from the HTTP
status or a truthy runtime value. An endpoint with nullable `output` resolves
JSON `null` as `null`; an endpoint without `output` resolves `undefined`,
including an explicitly declared empty `200` or `205`. A missing body for a
declared output, or a body for an endpoint with no output, fails loudly instead
of changing the typed result.

Validation runs in one direction. The response is checked against the endpoint's
`output` schema before it reaches the caller; arguments are **not** checked
against `input` or `params` before the request is sent. A value the contract
forbids travels to the server and comes back as a `VALIDATION_ERROR` — `400`,
naming every offending field in the `message` and again in `details.issues` as
`{ path, code, message }`. That holds for a JSON body, a query string and a path
parameter alike, so a rejected argument always costs a round trip.

An application that needs a local refusal can parse the schema itself before
calling — `contract.endpoints.<name>.input` is the same Zod object the server
validates with:

```ts
const parsed = contract.endpoints.create.input.safeParse(args)
if (!parsed.success) return refuse(parsed.error)
await api.create(args)
```

It then owns a second error shape beside this one, so make the local refusal name
the offending fields too. A caller who receives a bare code with no text cannot
tell which gate refused or why — and reads it as a refusal of permission.

An explicit contract `HEAD` operation is exposed like any other typed method.
Because HEAD endpoints are `rawResponse`, it resolves to the untouched
`Response`, giving the caller direct access to status and headers without JSON
parsing:

```ts
const response = await assets.head({ name: 'clip.mp4' })
console.log(response.headers.get('content-length'))
```

Each call takes one argument object. The client routes each field by the
contract:

- a **path param** (`:id`) is substituted into the URL,
- a named terminal wildcard (`/*filePath`) consumes that field and preserves its
  path segments (`{ filePath: 'a/b' }` → `/a/b`, not `/%2Fa%2Fb` or a query field),
- for `GET` / `DELETE`, the remaining fields become the **query string**
  (arrays become repeated keys),
- for `POST` / `PUT` / `PATCH`, they become the **JSON body**,
- a single `multipart.files` field is a `Blob` (web / Bun) or platform
  `FileDescriptor` (`{ uri, name, type }`, React Native / Expo); a multiple
  field is an array and is appended under the same form field name in order.
  The exported `MultipartFile` / `FileDescriptor` types let you annotate your
  own upload helpers.

### Per-call cancellation

Every endpoint callable exposes a `withOptions` method accepting required
`ClientRequestOptions`. The ordinary callable contains only contract arguments,
so it can be passed directly to callback APIs such as `react-query-kit` without
mistaking their callback context for Stitchkit transport options.

**That safety has a cost worth knowing before it bites you.** `api.thing(args,
{ signal })` — the shape everyone reaches for first — is not an error: the second
argument is ignored, in silence, and the request runs to completion while the
caller believes it was cancelled or bounded. TypeScript refuses the extra
argument at a typed call site and says nothing at an untyped one, which is where
the mistake actually happens. Nothing can catch it at runtime **on the bare
callable**: probing its second argument is exactly what the callback safety above
forbids, since reading a foreign object's `signal` may execute someone else's
getter. So the rule is simply this — **per-call options only ever go through
`withOptions`**, and a cancellation that appears to do nothing is the first thing
to check.

`withOptions` itself is guarded, because there the count settles it without
reading anything. Its arity depends on the endpoint — one argument when there is
no contract input, two when there is — and a call carrying more throws a
`TypeError` naming the endpoint and the correct shape. That guard exists because
the silent version of this mistake is expensive: the options are dropped, the
request goes out uncancelled, the caller still receives `REQUEST_ABORTED`
(cancellation is decided from the signal it was handed, not from what the
transport did), and the server runs the operation to its own deadline. Every
symptom then points at the transport, and the investigation goes there.

```ts
const controller = new AbortController()

const pending = api.upload.withOptions(
  { file: selectedFile, title: 'Draft' },
  { signal: controller.signal },
)

controller.abort()
await pending
```

Caller cancellation and the endpoint/client timeout are composed; whichever
fires first owns the result. Both the bare-fetch and Ky-backed clients expose
the same client-only errors:

| Failure | `ApiError.code` | `status` |
|---------|-----------------|----------|
| caller `AbortSignal` | `REQUEST_ABORTED` | `0` |
| endpoint/client timeout | `REQUEST_TIMEOUT` | `0` |
| other transport failure | `UNKNOWN_ERROR` | `0` |

Abort and timeout do not emit `network_error` and are not retried. The same
options work for query, JSON, multipart and raw-response calls. Stitchkit does
not expose upload progress: Fetch has no portable upload-progress primitive.

An injected transport failure is normalized to `UNKNOWN_ERROR` while its exact
object remains available as `ApiError.cause`. This is how a bounded adapter can
preserve facts the generic client cannot invent — for example a Unix transport's
`not-dispatched`, `possibly-dispatched` or `response-received` state. Never replay
an effect from `UNKNOWN_ERROR` alone; inspect the owned adapter's cause and retry
only when it proves that dispatch did not happen.

For an endpoint without contract arguments, pass only the options object:

```ts
await api.health.withOptions({ signal: controller.signal })
```

### Injected delivery adapters

`ClientFetch` is the narrow composition seam for application-owned delivery.
The contract still owns operation identity, request serialization and response
validation; the adapter owns I/O, bounds and dispatch certainty:

```ts
import { type ClientFetch, createClient } from 'stitchkit'

const delivery: ClientFetch = async (input, init) => {
  // Fixed deployment destination and policy are chosen here, not by caller data.
  return boundedFetch(input, { ...init, signal: init?.signal })
}

const query = createClient(queryContract, {
  baseUrl: 'https://service.internal',
  fetch: delivery,
})
const work = createClient(requestWorkContract, {
  baseUrl: 'https://service.internal',
  fetch: delivery,
})
```

The same adapter accepts unrelated contract shapes without learning their DTOs
or operation inventory. `createClient` chooses method/path from the contract,
serializes only the declared arguments, forwards `.withOptions(..., { signal })`
and validates the response through the endpoint's output schema. A caller payload
cannot replace the configured base URL or reserved operation path.

Contract metadata describes an effect; it does not authorize one. Authentication,
scope and destination policy remain in the application/server boundary. A schema
mismatch is an explicit validation failure and is not retried automatically. A
timeout means the caller stopped waiting, not that the remote effect did not run.

Published declarations are checked from a clean tarball under both bundler and
NodeNext resolution. The HTTP-only NodeNext proof uses `skipLibCheck: false` and
installs no Socket.IO peer. → ADR 0120.

### Many contracts at once

```ts
import { createClients } from 'stitchkit'

export const api = createClients({ users, posts, billing }, http)
await api.users.list()
await api.posts.create({ title: 'Hi' })
```

When contracts use different path-prefix rules, route the same registry by the
scope already declared in each contract. An array composes contracts with
different scopes into one logical namespace:

```ts
const api = createScopedClients(
  { auth: [publicAuth, authenticatedAuth], widgets },
  http,
  {
    public: {},
    user: {},
    tenant: {
      stripPrefixKeys: ['tenantId'],
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    },
  },
)

await api.auth.login()
await api.auth.me()
await api.widgets.list({ tenantId: 't1' })
```

Every scope present in the registry needs a config. Unknown/missing scopes and
duplicate method names inside a composed namespace fail before a request runs.

`createClients` builds one typed client per contract from a registry — list the
contracts once, get the whole API typed. It accepts the same optional scoped
config as `createClient`, so a whole registry can share one resource prefix:

```ts
const tenantApi = createClients({ users, posts }, http, {
  stripPrefixKeys: ['tenantId'],
  pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
})
```

Every method now requires `tenantId`, and the callback sees it as a `string`.
The batch form delegates to the same single-contract client runtime, including
HTTP exposure filtering, multipart, raw responses and output validation.

## Contract URL builders

Browser-native consumers such as `<img src>`, downloads and navigation need a
URL, not a fetched response. `createUrlBuilder` derives those URLs from the same
contract path planner used by both typed-client transports:

```ts
import { createScopedUrlBuilders, createUrlBuilder, createUrlBuilders } from 'stitchkit'

const mediaUrls = createUrlBuilder(media, http, {
  stripPrefixKeys: ['tenantId'],
  pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
})

const src = mediaUrls.file({
  tenantId: 't_123',
  fileId: 'f_456',
  thumbnail: true,
})

// Body and multipart fields are intentionally absent: only the URL-bound
// params are accepted by URL functions.
const formAction = mediaUrls.replace({ tenantId: 't_123', fileId: 'f_456' })
const beaconUrl = mediaUrls.track({ tenantId: 't_123' })

const urls = createUrlBuilders({ media, exports }, http)
```

When contracts use different dynamic prefixes, route the registry by the same
literal `contract.meta.scope` model as `createScopedClients`:

```ts
const urls = createScopedUrlBuilders(
  {
    assets: publicAssets,
    media: [tenantFiles, tenantMetadata], // one composed namespace
  },
  http,
  {
    public: {},
    tenant: {
      stripPrefixKeys: ['tenantId'],
      pathPrefix: ({ tenantId }) => `tenants/${tenantId}`,
    },
  },
)

urls.assets.logo()
urls.media.file({ tenantId: 't1', fileId: 'f' })
```

Every reachable scope needs a config. A missing config or duplicate method in a
composed namespace fails while the registry is built; URL generation itself
continues to use the same request planner as `createClient`.

Every HTTP-exposed endpoint appears on a URL builder, including body, multipart
and raw-response operations. Path and scoped-prefix keys are consumed by the
path. `GET` and `DELETE` input becomes the query string, including repeated keys
for arrays; body-method input and multipart files are not URL arguments and are
never serialized into the URL. Passing such a field through an untyped boundary
fails before a URL is returned.

Building a URL is synchronous and performs no request, auth event, header
resolution or output validation. A `ConfiguredHttpClient` created by
`createHttpClient` supplies its base URL; custom transports can pass an explicit
`{ baseUrl: 'https://api.example.com' }` instead. Relative bases produce relative
URLs.

## `ApiError`

A non-2xx response is thrown as an `ApiError`:

```ts
import { ApiError } from 'stitchkit'

try {
  await api.get({ id: 'missing' })
} catch (err) {
  if (ApiError.is(err)) {
    err.code     // 'NOT_FOUND'
    err.status   // 404
    err.message  // 'Note not found'
    err.details  // structured details, if any
    err.hint     // optional hint
    err.traceId  // x-request-id — correlate this failure with backend logs
    err.cause    // concrete injected transport failure, when delivery failed
  }
}
```

`traceId` is present when the server returned `x-request-id`. A network error,
timeout or abort without an HTTP response cannot carry one. Cross-origin
browser code can read it through Stitchkit's default CORS expose list; a custom
`cors.exposeHeaders` policy must keep `x-request-id` exposed.

The error model is shared with the server — see [Auth & errors](./auth-and-errors.md).

## Auth events

The HTTP client emits events your app can react to globally:

```ts
const unsubscribe = http.subscribe((event) => {
  if (event.type === 'unauthorized') redirectToLogin()  // a non-suppressed 401
  if (event.type === 'network_error') showOfflineBanner()
})

http.logout()            // mark logged out — suppresses further unauthorized events
http.resetLogoutState()  // clear it after a fresh login
```

## Server-side rendering

For SSR, forward the incoming request's cookies so the API call runs as the
logged-in user:

```ts
http.setServerContext(request.headers.get('cookie') ?? '')
```

## A bare fetch client

If you do not need cookie auth, retry or the event stream, pass a plain config
instead of an `HttpClient` — `createClient` then builds a minimal `fetch`-based
client:

```ts
const api = createClient(users, {
  baseUrl: 'https://api.example.com',
  headers: () => ({ Authorization: `Bearer ${token()}` }),
  onError: (status, body) => console.warn(status, body),
})
```

## `ContractClientConfig` — per-tenant / resource-scoped clients

`createClient` takes an optional **third** argument that prepends a dynamic
segment to every URL — the client half of a multi-tenant API
([Route groups → param prefixes](./server.md#param-prefixes-resource-scoped-paths)):

```ts
interface ContractClientConfig {
  /** Prepended to every request URL. A function is called per request with the
   *  call's argument object, so the prefix can depend on the arguments. */
  pathPrefix?: string | ((args: { [K in ConsumedKey]: string }) => string)
  /** Argument keys consumed by `pathPrefix` — stripped from the query/body so
   *  they are not also sent there (the endpoint's own path `:params` are
   *  stripped automatically; list any *extra* keys here). */
  stripPrefixKeys?: string[]
}
```

A per-tenant client — `tenantId` goes into the URL, not the body:

```ts
const widgets = createClient(widgetsContract, http, {
  stripPrefixKeys: ['tenantId'],
  pathPrefix: ({ tenantId }) => `tenants/${tenantId}/`,
})

widgets.list({ tenantId: 't_123' })            // GET  /tenants/t_123/widgets
widgets.create({ tenantId: 't_123', name: 'A' }) // POST /tenants/t_123/widgets  body: { name }
```

"Keys it consumes" = a key the `pathPrefix` function reads (here `tenantId`).
List it in `stripPrefixKeys` so it lands in the URL **and is removed from the
query/body** — otherwise it would be sent twice. Endpoint path `:params` are
stripped for you; only extra prefix keys need listing.

## React data layer

stitchkit does not ship a hook engine. Pair the typed client with
[`react-query-kit`](https://github.com/liaoliao666/react-query-kit) — wrap the
client methods directly:

```ts
import { createQuery, createMutation } from 'react-query-kit'
import { api } from './api'

export const useUsers      = createQuery({ queryKey: ['users'], fetcher: () => api.list() })
export const useCreateUser = createMutation({ mutationFn: api.create })
```

Generated methods intentionally keep their ordinary call signature limited to
contract variables. Use `api.create.withOptions(variables, { signal })` only for
an imperative call that needs per-request cancellation.

### Cursor pagination

For a cursor-paginated list, `createCursorQuery` is the canonical helper:

```ts
import { createCursorQuery } from 'stitchkit/react'
import { api } from './api'

export const useFeed = createCursorQuery({
  queryKey: ['feed'],
  endpoint: api.feed,     // the contract method
})
```

It injects `cursor` from the page param and bakes in `getNextPageParam` /
`initialPageParam` — an infinite hook is just `queryKey + endpoint`. The page
size is the server's call (the contract's `limit` default); the client never
sends one. The result keeps the full `react-query-kit` surface (`.getKey()`,
`useSuspenseInfiniteQuery`, every option). The endpoint must return the
`{ items, nextCursor }` envelope — see [Contracts → pagination](./contracts.md#pagination).

## Contract-first streams

When an endpoint declares `stream`, `createClient` returns a schema-derived
owned iterator rather than an untyped `Response`:

```ts
const Progress = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), text: z.string() }),
  z.object({ kind: z.literal('complete'), count: z.number().int() }),
])

const contract = defineContract({ prefix: 'reports' }, {
  watch: {
    method: 'GET', path: '/:id/watch', desc: 'Watch one report',
    params: z.object({ id: z.string() }),
    stream: {
      item: Progress,
      format: 'ndjson',                 // default; `sse` is also supported
      maxFrameBytes: 64 * 1024,         // default 256 KiB
      terminal: z.object({ kind: z.literal('complete') }).loose(),
    },
  },
})

const stream = await createClient(contract, http).watch({ id: 'r-1' })
for await (const item of stream) console.log(item) // inferred from Progress
```

The iterator validates every frame and item. Normal completion requires the
wire `end` frame and, when declared, at least one matching terminal item; EOF is
`STREAM_TRUNCATED`, and a missing terminal is `STREAM_TERMINAL_MISSING`.
`return()`/`break`, caller abort, producer failure and optional `lifetimeMs`
converge on the request operation. See the
[server half](./server.md#contract-first-streams). → ADR 0117.

The request deadline bounds the wait for response headers. Once headers arrive,
that timer is cleared, while the caller signal remains attached to the response
body until it ends or is cancelled. This is the same for a Fetch-config client,
`createHttpClient`, the Bun-only `unix` convenience and an injected portable
Unix transport. Cancelling a quiet stream therefore releases its server source
and transport connection instead of only settling the local iterator.

An established NDJSON protocol may keep its item schema as the complete wire
frame. This mode requires a terminal item because an unwrapped response has no
separate safe error/end envelope:

```ts
stream: {
  item: Progress,
  framing: 'item',
  completion: 'terminal',
  terminal: z.object({ kind: z.literal('complete') }).loose(),
  finalLine: 'require-newline',
}
```

The matching terminal item ends the operation. Before `next()` returns that
item, the client aborts the owned request and cancels its body reader; trailing
frames are not read. EOF first is `STREAM_TERMINAL_MISSING`. The defaults remain
`framing: 'envelope'`, `completion: 'stream-end'` and `finalLine: 'allow'`.
→ ADR 0126.

## SSE

For a streaming endpoint, consume the response with `parseSSE`:

```ts
import { parseSSE } from 'stitchkit'

const res = await fetch('/api/chat/stream', { method: 'POST', body })
for await (const event of parseSSE(res)) {
  console.log(event.data)
}
```

The server side is [`streamSSE`](./server.md#sse-streaming), or
[`sseRoute`](./server.md#long-lived-subscriptions) for a subscription that stays
open. One line is bounded by `maxLineBytes` (default 1 MiB), UTF-8 is decoded
strictly and malformed input throws. Supply `onParseError` only when
skip-and-report is an explicit application policy.

## NDJSON

`parseNDJSON` reads a newline-delimited JSON body — the client half of
[`ndjsonRoute`](./server.md#long-lived-subscriptions):

```ts
import { parseNDJSON } from 'stitchkit'

const subscription = new AbortController()
const res = await fetch('/api/events/subscribe', { signal: subscription.signal })
for await (const event of parseNDJSON(res)) {
  console.log(event)
}

// ...to unsubscribe:
subscription.abort()
```

**Use the `AbortController` for a subscription.** Leaving the loop with `break`
cancels the body, and on a stream that ends that is enough — but it is not a
reliable way to tell the *server* you are gone: measured against Bun today, the
source stayed alive for seconds after a client-side cancel. Aborting the request
reaches [`context.signal`](./server.md#long-lived-subscriptions) on the other
end at once, which is what actually ends the work.

**Blank lines are skipped**, and that is the contract rather than a
convenience: a long-lived stream must send something while it is idle or
intermediaries drop it, and an empty line is the natural pulse for this framing.
Writing the rule down on both sides is what stops it being a verbal agreement —
the server's keep-alive and the reader's skip are one decision with two
implementations. One line is bounded by `maxLineBytes` (default 1 MiB), UTF-8 is
decoded strictly and malformed input throws. Passing `onParseError` explicitly
selects tolerant skip-and-report behaviour.

Set `finalLine: 'require-newline'` when the final newline is part of the
protocol's truncation proof. The default `allow` continues to accept one valid
final JSON document without a newline.

## Resumable streams

A stream that survives a dropped connection needs four things beyond opening it:
re-open, back off before retrying, resume from where it stopped rather than
restart, and stop for good on a terminal item. `resumableIterator` owns those
four; your code keeps every decision that is about your data.

```ts
import { resumableIterator } from 'stitchkit'

for await (const event of resumableIterator<Event, string>({
  async open(cursor) {
    const url = cursor ? `/api/events?after=${cursor}` : '/api/events'
    return parseNDJSON(await fetch(url, { signal }))
  },
  advance: (event) => event.id,          // what "where it stopped" means
  isTerminal: (event) => event.done,     // which item ends the stream
  retry: { minDelayMs: 500, maxDelayMs: 30_000, jitter: 0.5 },
  signal,
  onAttempt: ({ number, delayMs, error }) => log.warn({ number, delayMs, error }),
})) {
  render(event)
}
```

`open` receives the cursor produced by the last **delivered** item, so a source
that fails after three items re-opens after the third, not from the beginning.
A source that simply ends without a terminal item is treated as a dropped
connection — that is the case a hand-written loop usually mistakes for
completion, and it is why the stream stops resuming.

**Jitter is not a detail.** Without it every consumer that lost the same server
retries at the same instant and the fleet arrives together on a server that has
just come back. The randomisation only ever *shortens* a delay, so `maxDelayMs`
stays a real ceiling. `createBackoff({ minDelayMs, maxDelayMs, jitter })` is the
same policy as a standalone value — `next()` and `reset()` — when you need the
delays without the iterator.

A delivered item resets the backoff, so a stream that reconnects, works for an
hour and drops again starts its next retry at `minDelayMs` rather than the
ceiling it reached last time. Aborting the signal ends the iteration promptly,
including in the middle of a wait.
