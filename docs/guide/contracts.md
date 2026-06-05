# Contracts

A **contract** describes a set of operations once — method, path, schemas,
scope, which transports each is exposed on. From it stitchkit derives the HTTP
route, the MCP tool, the agent tool and the typed client. One declaration; the
surfaces cannot drift.

## `defineContract`

```ts
import { defineContract } from 'stitchkit'

const contract = defineContract(meta, endpoints)
```

- **`meta`** — `{ prefix: string }`, or `{ prefix: string, scope: string }` to
  give every endpoint a default scope.
- **`endpoints`** — a map of `key → endpoint definition`. The key becomes the
  client method name and the handler name.

`defineContract` throws at definition time if two endpoints declare the same
`toolName` on the same transport — a tool-name clash is a bug, caught early.

## An endpoint

```ts
export const users = defineContract({ prefix: 'users' }, {
  list: {
    method: 'GET',
    path: '/',
    desc: 'List all users',
    output: z.array(UserSchema),
  },
  create: {
    method: 'POST',
    path: '/',
    desc: 'Create a user',
    input: CreateUserSchema,
    output: UserSchema,
  },
  get: {
    method: 'GET',
    path: '/:id',
    desc: 'Get a user by id',
    params: z.object({ id: z.string() }),
    output: UserSchema,
  },
})
```

### Fields

| Field | Required | Purpose |
|-------|----------|---------|
| `method` | yes | `GET` · `POST` · `PUT` · `PATCH` · `DELETE` |
| `path` | yes | route path under the contract `prefix`; `:name` marks a path param |
| `desc` | yes | human description — also the MCP / agent tool description |
| `params` | no | Zod schema for **path params** (`:id`, …) |
| `input` | no | Zod schema for the **request body** (or query, for GET/DELETE) |
| `output` | no | Zod schema for the **response body** |
| `scope` | no | access scope for this endpoint — see [Auth & errors](./auth-and-errors.md) |
| `expose` | no | which transports carry this endpoint — see [below](#transports) |
| `toolName` | no | explicit MCP / agent tool name (defaults to `prefix_key`) |
| `multipart` | no | field name of a file upload — see [below](#file-uploads) |
| `timeout` | no | per-endpoint client timeout in ms, for slow endpoints |
| `idempotent` | no | safe to call twice with the same input (like `PUT`/`DELETE`); a retrying transport reads it — see [Realtime](./realtime.md#bring-your-own-transport) |
| `meta` | no | opaque app metadata — read in hooks / on tool mounts, never in OpenAPI ([below](#endpoint-metadata-meta)) |

## `params` vs `input` vs `output`

The three schemas are distinct on purpose:

- **`params`** — values in the URL path. `path: '/:id'` ⇒
  `params: z.object({ id: z.string() })`. The client takes them from the call
  argument and substitutes them into the URL.
- **`input`** — the request payload. For `POST` / `PUT` / `PATCH` it is the JSON
  body; for `GET` / `DELETE` it is the query string. The handler reads it as
  `ctx.input`.
- **`output`** — the response shape. When set, the client parses the response
  through it; the handler's return value is type-checked against it.

The typed client merges `params` and `input` into one argument object — the
caller passes a single flat object, the client routes each field to the path or
the body.

```ts
// path: '/:id', params: { id }, input: { text }
await api.update({ id: '1', text: 'new' })   // PUT /users/1  body: { text: 'new' }
```

### Input vs. output types

For the client, an endpoint's argument type is the schema's **input** type
(pre-parse). A field with `.default()` is therefore optional for the caller but
present (required) in the handler's parsed `ctx.input`. The contract handles the
two type views; you do not.

## Transports

By default an endpoint is exposed on **every** surface — HTTP, MCP and agent
tools. Narrow it with `expose`:

```ts
{
  method: 'POST', path: '/', desc: 'Internal sync',
  expose: ['HTTP'],            // HTTP only — not an MCP or agent tool
}
{
  method: 'GET', path: '/search', desc: 'Search the catalog',
  expose: ['HTTP', 'MCP', 'AGENT'],   // explicit — all three
}
```

- `expose: ['HTTP']` — HTTP only. The endpoint never becomes a tool.
- `expose: ['MCP', 'AGENT']` — a tool only; no HTTP route.
- omit `expose` — all transports.

Tool transports (`MCP`, `AGENT`) skip `multipart` endpoints automatically — a
file upload is not a tool call.

## `toolName`

When an endpoint is exposed as a tool, its name defaults to `prefix_key`
(`users` + `create` ⇒ `users_create`). Set `toolName` for an explicit, stable
name:

```ts
{ method: 'POST', path: '/', desc: 'Create a user', toolName: 'create_user', /* … */ }
```

## Endpoint metadata (`meta`)

`meta` is an **opaque, app-defined** bag the core attaches no meaning to — the
same escape-hatch spirit as `scope` being a free string ([ADR 0002](../decisions/0002-generic-core.md) /
[ADR 0021](../decisions/0021-endpoint-meta-passthrough.md)). Declare app concerns
the generic core does not model — a feature gate, a rate tier, a cache hint, a
doc/owner tag — right next to the endpoint:

```ts
broadcast: {
  method: 'POST', path: '/broadcast', desc: 'Send a broadcast',
  input: BroadcastInput, output: Broadcast,
  meta: { requiredFeature: 'broadcasts' },   // opaque to the core
}
```

It rides through to `MethodDef.meta`, readable in lifecycle hooks (the second
argument is the endpoint) and on tool mounts. The consumer narrows the type when
reading:

```ts
beforeHandle: (ctx, endpoint) => {
  const feature = endpoint.meta?.requiredFeature
  if (typeof feature === 'string' && !ctx.user?.features?.includes(feature)) {
    throw forbidden('feature not enabled')
  }
}
```

`meta` is **app-private** — it is never serialized into the OpenAPI document.

> **Declare a meta type as a `type`, an inline literal, or with `satisfies` — not
> an `interface`.** A TS `interface` has no implicit index signature (it can be
> augmented by declaration merging), so it is not assignable to `meta`'s
> `Record<string, unknown>` — and on the overloaded `defineContract` the error
> misleadingly surfaces as a `scope` mismatch. Use
> `type EndpointMeta = { requiredFeature?: PlanFeature }`, or
> `meta: { requiredFeature: 'x' } satisfies EndpointMeta`. The read side is
> unchanged — `endpoint.meta?.x` is `unknown`, narrow it in the hook.

## File uploads

`multipart` names the form field carrying a file. The handler receives it as
`ctx.file`:

```ts
upload: {
  method: 'POST',
  path: '/avatar',
  desc: 'Upload an avatar',
  multipart: 'file',
  output: z.object({ url: z.string() }),
}
```

The client sends a `multipart/form-data` request; the field value must be a
`Blob`. See [HTTP server → multipart](./server.md#multipart).

## Pagination

Every list endpoint should return the cursor envelope — one shape, one infinite-
query helper:

```ts
import { paginatedSchema } from 'stitchkit'

feed: {
  method: 'GET',
  path: '/',
  desc: 'Paginated feed',
  input: z.object({ limit: z.coerce.number().default(20) }),
  output: paginatedSchema(PostSchema),   // { items: Post[], nextCursor: string | null }
}
```

`paginatedSchema(itemSchema)` produces `{ items, nextCursor }`. The page size
default lives in the contract (`limit`'s `.default()`), never on the client —
the two cannot diverge. The client side is [`createCursorQuery`](./client.md#cursor-pagination).

The **format** of `nextCursor` is the server's choice — keep it opaque. For the
usual keyset cursor (resume after the last row's `(sortValue, id)`), encode it
with **`encodeCursor`** and read it back with **`decodeCursor`** (Zod-validated;
a missing or garbage cursor decodes to `null`, i.e. "start from the top"):

```ts
import { encodeCursor, decodeCursor } from 'stitchkit'

const Cursor = z.object({ v: z.string(), id: z.string() })   // your keyset shape

const after = decodeCursor(ctx.input.cursor, Cursor)         // { v, id } | null
const rows = await db.list({ after, take: limit + 1 })        // your keyset WHERE
const nextCursor =
  rows.length > limit ? encodeCursor({ v: last.createdAt, id: last.id }) : null
```

The codec is base64url over UTF-8 (`btoa`/`atob`, not Node `Buffer`) — server,
client and browser safe, and a non-ASCII sort value round-trips. The keyset
WHERE clause is yours (it's ORM-specific); stitchkit only carries the string.

## Scope

An endpoint may carry a `scope` string; the contract `meta.scope` is the default
for every endpoint that declares none. Scopes are free strings — the framework
attaches no meaning, your auth hook does. See
[Auth & errors](./auth-and-errors.md).

## One source of truth

A contract is plain data — no classes, no decorators, no codegen. It is imported
by the server (to `implement`), by the client (to `createClient`) and by the
tool layer (to `mountMcp` / `mountAgent`). Change an endpoint and every surface
is re-typed by the compiler at once.
