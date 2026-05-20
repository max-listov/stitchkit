# Auth & errors

stitchkit carries no domain model — it does not know what a user is. What it
provides is the *control flow*: a scope on every endpoint, one hook that
enforces it, and one error model shared by every transport. The identity and
the scope vocabulary are yours.

## Scopes

An endpoint declares a `scope` — a free string. The contract `meta.scope` is the
default for endpoints that declare none.

```ts
export const posts = defineContract({ prefix: 'posts', scope: 'user' }, {
  list:   { method: 'GET',    path: '/',    desc: 'List posts', scope: 'public', output: /* … */ },
  create: { method: 'POST',   path: '/',    desc: 'Create',     /* inherits 'user' */ },
  remove: { method: 'DELETE', path: '/:id', desc: 'Delete',     scope: 'admin' },
})
```

The framework attaches no meaning to the strings — `'public'`, `'user'`,
`'admin'` mean whatever your auth hook decides.

## `createAuthHook`

`createAuthHook` builds a `beforeHandle` hook that enforces `endpoint.scope`.
Every request runs the same three steps — resolve the identity, read the scope,
allow / 401 / 403 — so the flow lives in the framework and you supply only
`resolve` and a `rules` map.

```ts
import { createAuthHook, createServer } from 'stitchkit/server'

const authHook = createAuthHook<User>({
  resolve: (ctx) => resolveSession(ctx),     // → a User, or null
  rules: {
    public: 'public',                        // always pass
    user:   'authenticated',                 // any resolved identity passes
    admin:  (user) => user.isAdmin,          // custom predicate
  },
  inject: (ctx, user) => { ctx.user = user },
})

createServer({ services, hooks: { beforeHandle: authHook } })
```

### `AuthRule`

The value of each `rules` entry, keyed by scope:

- **`'public'`** — always passes; the identity is attached if present.
- **`'authenticated'`** — any resolved identity passes; no identity ⇒ 401.
- **a function** `(identity, ctx) => boolean | Promise<boolean>` — a custom
  check. It receives the full context, so a resource-scoped rule can read
  `ctx.params` and do a DB lookup. May be async.

### `AuthHookConfig`

| Field | Purpose |
|-------|---------|
| `resolve` | `(ctx) => identity \| null` — cookie / bearer + lookup |
| `rules` | access rule per scope; `endpoint.scope` is the key |
| `defaultScope` | scope applied when an endpoint declares none |
| `inject` | write the resolved identity onto `ctx` for handlers |
| `onAnonymous` | thrown when a scope needs an identity and there is none (default 401) |
| `onForbidden` | thrown when an identity is present but the rule rejects it (default 403) |

Annotate `rules` with `satisfies Record<MyScope, AuthRule<User>>` so the compiler
catches a scope you forgot to cover.

Because the hook runs in `beforeHandle`, it guards **every transport** — HTTP,
MCP and agent calls all pass through it.

## `createBearerResolver`

For API-key or bearer-token auth (the usual MCP case), `createBearerResolver`
strips `Authorization: Bearer <token>` and hands the raw token to your lookup:

```ts
import { createBearerResolver } from 'stitchkit/server'

const resolve = createBearerResolver<User>({
  lookup: (token, req) => db.apiKeys.resolve(token),   // → User, or null
})
```

Use it as `createMcpHandler`'s `auth`, or inside `createAuthHook`'s `resolve`.

## JWT

`verifyJwt(token, secret)` verifies an HS256 JWT and returns its payload, or
throws `unauthorized`. It pins the algorithm (the token's own `alg` can never
pick the scheme), and checks `exp` and `nbf`.

```ts
import { verifyJwt, extractToken } from 'stitchkit/server'

const token = extractToken(req)           // from Authorization, or a cookie name
const payload = await verifyJwt(token, process.env.JWT_SECRET!)
```

`extractToken(req, cookieName?)` reads a bearer token from the `Authorization`
header, or from the named cookie.

## Cookies

```ts
import { defineCookie } from 'stitchkit/server'

const session = defineCookie({ name: 'sid', httpOnly: true, secure: true, sameSite: 'Lax', path: '/' })

session.get(req)        // string | undefined
session.set('abc123')   // → a Set-Cookie header value
session.clear()         // → a Set-Cookie value that expires it
```

`defineCookie` bundles a cookie's name and options into a typed handle, so the
config is not repeated at every call site. `parseCookies(header)` and
`serializeCookie(name, value, opts)` are the lower-level primitives.

## The error model

One error type, `AppError`, is shared by the contract, the server and the
client. It carries a stable `code`, an HTTP `status`, and optional structured
`details` and a `hint`.

### Throwing errors

Throw `AppError` directly, or use a typed helper — the idiomatic path:

| Helper | Status | Code |
|--------|--------|------|
| `notFound(message?)` | 404 | `NOT_FOUND` |
| `badRequest(message, details?)` | 400 | `BAD_REQUEST` |
| `unauthorized(message?)` | 401 | `UNAUTHORIZED` |
| `forbidden(message?)` | 403 | `FORBIDDEN` |
| `conflict(message?, details?)` | 409 | `CONFLICT` |
| `rateLimited(message?)` | 429 | `RATE_LIMITED` |
| `appError(code, message?, details?)` | mapped, else 500 | any `code` |

```ts
import { notFound, badRequest } from 'stitchkit/server'

const note = db.get(ctx.params.id)
if (!note) notFound('Note not found')
if (ctx.input.title.length > 200) badRequest('Title too long', { max: 200 })
```

Each helper has a `never` return type — TypeScript knows execution stops, so the
code after it is correctly narrowed.

### The error envelope

`AppError.toJSON()` renders the public envelope every transport returns:

```json
{ "error": { "code": "NOT_FOUND", "message": "Note not found" } }
```

`details` and `hint` are included when present. On HTTP this is the response
body with the matching status; for an MCP or agent call the same `code` and
`details` come back as a tool error. A schema-validation failure on the request
is turned into a `400 VALIDATION_ERROR` automatically.

### On the client

The client parses that envelope back into an `ApiError` with the same `code`,
`status`, `details` and `hint` — see [Typed client → ApiError](./client.md#apierror).
The error round-trips: one model, server to client.
