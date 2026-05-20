# Typed client

From a contract, `createClient` builds a fully-typed client — one method per
endpoint, arguments and result inferred from the schemas. There is no codegen
step: the types come straight from the contract import.

## `createHttpClient`

The HTTP client is the transport. It wraps [`ky`](https://github.com/sindresorhus/ky)
and adds cookie auth, SSR cookie forwarding, error parsing into `ApiError`, a
`401 → unauthorized` event stream and safe transport retry.

```ts
import { createHttpClient } from 'stitchkit'

const http = createHttpClient({ baseUrl: '/api' })
```

### `HttpClientConfig`

| Field | Default | Purpose |
|-------|---------|---------|
| `baseUrl` | — | URL prefix for every request |
| `timeout` | `30000` | request timeout, ms |
| `credentials` | `'include'` | fetch credentials mode |
| `retry` | 2× GET, network errors only | transport retry policy |
| `headers` | — | extra headers — an object, or a function re-run per request |
| `authEndpoints` | `['auth/']` | paths that should **not** emit `unauthorized` on 401 |
| `parseError` | built-in | map an error body to `{ code, message, details, hint }` |

`headers` as a function is the hook for runtime tokens — a bearer token or any
short-lived credential — re-evaluated on every request.

Retry is deliberately conservative: only a connection that never landed (a
network error), only on idempotent `GET`. A server that *responded* with a 5xx
is the data layer's call (TanStack Query), not the transport's — retrying in
both places multiplies attempts.

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

Each call takes one argument object. The client routes each field by the
contract:

- a **path param** (`:id`) is substituted into the URL,
- for `GET` / `DELETE`, the remaining fields become the **query string**
  (arrays become repeated keys),
- for `POST` / `PUT` / `PATCH`, they become the **JSON body**,
- a `multipart` field must be a `Blob` and is sent as `form-data`.

### Many contracts at once

```ts
import { createClients } from 'stitchkit'

export const api = createClients({ users, posts, billing }, http)
await api.users.list()
await api.posts.create({ title: 'Hi' })
```

`createClients` builds one typed client per contract from a registry — list the
contracts once, get the whole API typed.

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
  }
}
```

The error model is shared with the server — see [Auth & errors](./auth-and-errors.md).

## Auth events

The HTTP client emits events your app can react to globally:

```ts
const unsubscribe = http.subscribe((event) => {
  if (event.type === 'unauthorized') redirectToLogin()  // a 401 outside authEndpoints
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

A third argument, `ContractClientConfig`, supports a dynamic URL `pathPrefix`
(e.g. a per-tenant segment) and the argument keys it consumes.

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
