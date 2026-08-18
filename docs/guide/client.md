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

Expected 401 policy is explicit and contract-driven. Select individual
operations with `contractEndpointMatchers(contract, ['login'])`, or omit the
second argument to select every HTTP operation in that contract. Pass the same
`ContractClientConfig` as the typed client when routes use a static or dynamic
`pathPrefix`; dynamic matchers require `stripPrefixKeys`, so the helper can
compile the prefix structure without a concrete tenant id. Matching is exact by
path segments, including params and trailing wildcards — a shared prefix never
suppresses a neighbouring protected endpoint.

### Unix domain sockets

The same typed client dials a local daemon's socket file
([server side](server.md#local-daemon-over-a-unix-socket)):

```ts
const http = createHttpClient({
  baseUrl: 'http://localhost', // required prefix source; its host is ignored
  unix: '/run/my-daemon.sock',
})
const daemon = createClient(daemonContract, http)
```

`baseUrl` stays required — it supplies the path prefix and the `Host` header,
while the connection itself goes through the socket file. Bun runtime only:
other runtimes ignore the option and dial `baseUrl` over TCP (Node's fetch
would need an undici dispatcher — out of scope). A missing socket file
surfaces as a normal `ApiError` and is not retried (transport retry stays
connection-refused-only).

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
mistaking their callback context for Stitchkit transport options:

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

For an endpoint without contract arguments, pass only the options object:

```ts
await api.health.withOptions({ signal: controller.signal })
```

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

## SSE

For a streaming endpoint, consume the response with `parseSSE`:

```ts
import { parseSSE } from 'stitchkit'

const res = await fetch('/api/chat/stream', { method: 'POST', body })
for await (const event of parseSSE(res)) {
  console.log(event.data)
}
```

The server side is [`streamSSE`](./server.md#sse-streaming).
