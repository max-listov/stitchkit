# Auth & errors

Client-side login/session operations may legitimately answer `401`. Declare
that policy with contract-owned matchers instead of path strings:

```ts
const http = createHttpClient({
  baseUrl,
  suppressUnauthorizedFor: contractEndpointMatchers(publicAuth, ['login', 'verify']),
})
```

Only the selected operations suppress the global `unauthorized` event; a 401
from any neighbouring protected route still signals session expiry.

stitchkit carries no domain model — it does not know what a user is. What it
provides is the *control flow*: a scope on every endpoint, one hook that
enforces it, and one error model shared by every transport. The identity and
the scope vocabulary are yours.

## Scopes

An endpoint declares a `scope` — a free string. The contract `meta.scope` is the
default for endpoints that declare none. (Authored through
[`createContractFactory<Scope>()`](./contracts.md#scope), both the contract's
scope and any endpoint override are held to your own union instead.)

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

`createAuthHook` builds one scope gate that can run in both HTTP and tool
lifecycles. On HTTP it belongs in `hooks.authorize`: Stitchkit validates path
params, resolves identity and scope, and rejects `401`/`403` **before reading a
JSON or multipart body**. On MCP, agent and CLI surfaces it belongs in
`lifecycle.beforeHandle`, because those transports have already received their
arguments before the common tool runner starts.

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

createServer({ services, hooks: { authorize: authHook } })
```

### `AuthRule`

The value of each `rules` entry, keyed by scope:

- **`'public'`** — always passes; the identity is attached if present.
- **`'authenticated'`** — any resolved identity passes; no identity ⇒ 401.
- **a function** `(identity, ctx) => boolean | contribution`, sync or async — a custom
  check. It receives request metadata and validated path params, so a
  resource-scoped rule can do a DB lookup. It cannot read `input` or files: the
  body has deliberately not been consumed yet. `false` denies, `true` passes,
  and a returned plain object passes and contributes inferred handler fields.

#### Resource-scoped rule — reading a path/prefix param

For a multi-tenant API (`pathPrefix: '/tenants/:tenantId'`, see
[Route groups → param prefixes](./server.md#param-prefixes-resource-scoped-paths)),
the rule gates access to the tenant in the path. A `:param` from the group prefix
or the endpoint is on the **context root** as `ctx.<name>` (a raw `string`):

```ts
const authHook = createAuthHook<User>({
  resolve: sessionResolver,
  rules: {
    public: 'public',
    // gate the tenant in the path — ctx.tenantId comes from the group prefix
    tenant: async (user, ctx) => userCanAccessTenant(user.id, String(ctx.tenantId)),
  } satisfies Record<Scope, AuthRule<User>>,
  // derive per-request facts onto ctx for handlers (role within this tenant, …)
  inject: async (ctx, user) => {
    ctx.user = user
    if (user) ctx.tenantRole = await roleInTenant(user.id, String(ctx.tenantId))
  },
})
```

`inject` runs on every request (identity may be `null`) — use it to put the
identity *and* any derived values (role, parent-id) on `ctx` for handlers. Read
them back as `ctx.tenantRole` (typed `unknown` — narrow at the read site). The
endpoints under the group declare `scope: 'tenant'`.

When the async authorization lookup already produced handler data, return it
instead of repeating the lookup in `inject` and a handwritten scope map:

```ts
const auth = createAuthHook({
  resolve: sessionResolver,
  rules: {
    project: async (user, ctx) => {
      const membership = await findMembership(user.id, String(ctx.projectId))
      return membership
        ? { userId: user.id, projectId: membership.projectId, role: membership.role }
        : false
    },
  },
})

const implementFor = createScopedImplement<AuthScopes<typeof auth>>()
```

Contributions are merged only after full validation. Runtime-owned context keys,
arrays, class instances, accessors, symbols, unsafe prototypes and partial proxy
reads fail without mutating context. `false | object` contributes required
fields; `true | object` correctly makes them optional.

### `AuthHookConfig`

| Field | Purpose |
|-------|---------|
| `resolve` | `(ctx) => identity \| null` — HTTP identity from `ctx.req` (cookie / bearer + lookup) |
| `resolveFromContext` | `(ctx) => identity \| null` — identity on a tool call (no `req`) |
| `rules` | access rule per scope; `endpoint.scope` is the key |
| `defaultScope` | scope applied when an endpoint declares none |
| `inject` | write the resolved identity onto `ctx` for handlers |
| `onAnonymous` | thrown when a scope needs an identity and there is none (default 401) |
| `onForbidden` | thrown when an identity is present but the rule rejects it (default 403) |

Annotate `rules` with `satisfies Record<MyScope, AuthRule<User>>` so the compiler
catches a scope you forgot to cover. With the scoped rule objects below, widen
the annotation to
`satisfies Record<MyScope, AuthRule<User> | ScopedAuthRule<User, AuthRuleContribution>>`
— it keeps the coverage check and does not disturb the derivation. (When every
scope comes from the derived map, the check is already implicit: a scope missing
from `rules` is no key of the map, and a contract using it fails to compile.)

### Scoped rules — the map `createScopedImplement` consumes

A rule may take an object form, `{ rule, inject }`, where `inject` **returns**
the fields this scope contributes. That return type is a declaration the hook
derives a scope→context map from — feed it to
[`createScopedImplement`](./server.md#per-scope-handler-context--createscopedimplement)
and the map can never drift from the hook, because it is computed from it:

```ts
const authHook = createAuthHook({
  resolve: sessionResolver,             // no explicit generic — let it infer
  rules: {
    public: { rule: 'public', inject: (user) => ({ userId: user.id }) },
    user: { rule: 'authenticated', inject: (user) => ({ userId: user.id }) },
    admin: {
      rule: (user) => user.admin,
      inject: (user) => ({ userId: user.id, isAdmin: user.admin }),
    },
  },
})

export const implementFor = createScopedImplement<AuthScopes<typeof authHook>>()
```

- A `'public'` rule's fields come out **optional**: public admits the anonymous
  caller, it does not refuse to know the logged-in one — `resolve` and `inject`
  still run, so a public `me` / `logout` handler reads `ctx.userId` as
  `string | undefined` and narrows, instead of being pushed toward a cast by a
  `public: object` map.
- Any other rule's fields are required — the rule rejected the request before
  the handler if no identity resolved.
- A scope with no rule is no key of the derived map, so a contract using it
  fails to compile — the type-level mirror of the hook's fail-closed
  `no rule for scope` throw.

The per-rule `inject` runs after the shared one, only when an identity
resolved, and **before** the rule check — it may run for an identity the rule
then rejects, so keep it pure and synchronous (an async `inject` is a compile
error, and a runtime one for untyped callers: merging a Promise would merge
nothing). Write rule objects inline in `rules` — a hoisted, annotated rule
widens its inject and degrades that scope's fields to `object`.

Derivation needs the identity generic to be **inferred** (write no explicit
`createAuthHook<User>` — TypeScript has no partial inference); with an explicit
generic, or fields injected outside the hook, keep the hand-written map.
→ ADR 0078

### Multiple auth domains — `composeAuthHooks`

Independent identity domains should keep separate resolvers and rules. Compose
their canonical hooks and derive one handler context without a manual dispatcher
or scope-map intersection:

```ts
const userAuth = createAuthHook({
  resolve: resolveUser,
  resolveFromContext: resolveToolUser,
  rules: {
    user: (user) => ({ userId: user.id }),
    workspace: (user) => ({ userId: user.id }),
  },
})

const workspaceAuth = createAuthHook({
  resolve: resolveMembership,
  resolveFromContext: resolveToolMembership,
  rules: {
    workspace: (membership) => ({ workspaceId: membership.workspaceId }),
  },
})

export const auth = composeAuthHooks({
  hooks: [userAuth, workspaceAuth],
  defaultScope: 'user',
})
export const implementFor = createScopedImplement<AuthScopes<typeof auth>>()
```

Only hooks that declare the selected scope run. An unknown scope fails closed;
when several hooks own one scope, every owner must pass in declaration order.
Each owner evaluates on an isolated shadow context. Stitchkit validates all
changed fields, rejects reserved/unsafe fields and cross-owner key collisions,
then commits the combined contribution once. A rejected or cancelled composite
therefore exposes no partial fields to the handler.

Isolation is per-key, not deep: a contribution is the set of context keys whose
descriptor changed. Mutating an existing value **in place**
(`ctx.user.role = 'admin'`) edits the object every owner already shares, so it
is neither reported as a contribution nor checked for collisions — contribute
new fields instead of editing another owner's object. External side effects
likewise remain consumer-owned and are not rolled back.

The composite's `defaultScope` is the only implicit scope. A child hook's own
default must be absent or equal to it, so reordering hooks cannot change which
scope protects an endpoint.

### Auth on the tool surface — `resolveFromContext`

The same hook guards every transport, but the lifecycle slot and identity
source differ:

- **HTTP** — `hooks.authorize` calls `resolve(ctx)` from `ctx.req` (a cookie or
  bearer token) before body parsing.
- **Tool calls (MCP / agent)** — there is no `req`. The transport authenticated
  the caller (an MCP API key) and `buildMcpServer`'s `context` injected the
  identity into `ctx`. `lifecycle.beforeHandle` calls
  `resolveFromContext(ctx)` to locate it.

```ts
const authHook = createAuthHook<User>({
  resolve: (ctx) => resolveSession(ctx),          // HTTP — from ctx.req
  resolveFromContext: (ctx) => ctx.user ?? null,  // tool — from injected ctx
  rules: { public: 'public', user: 'authenticated', admin: (u) => u.isAdmin },
})
```

The **scope check is identical** on both surfaces — only identity resolution
differs. If you omit `resolveFromContext`, a scoped tool call has no identity
and **fails closed** (rejected by `onAnonymous`) — the hook never silently
passes a tool call it cannot authenticate. → [ADR 0014](../decisions/0014-tool-http-parity.md)

```ts
createServer({ services, hooks: { authorize: authHook } })
createMcpHandler({ services, lifecycle: { beforeHandle: authHook } })
```

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
import { env } from './env'

const token = extractToken(req)           // from Authorization, or a cookie name
if (!token) throw unauthorized('Bearer token is required')
const payload = await verifyJwt(token, env.JWT_SECRET)
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

To set a cookie from a schema-validated JSON endpoint without losing its typed
client result, declare [`responseMeta`](./server.md#typed-json-response-metadata)
and append the generated value:

```ts
complete: async ({ response }) => {
  response.headers.append('Set-Cookie', session.set('abc123'))
  return authenticatedUser
}
```

Append once per cookie; Stitchkit preserves separate `Set-Cookie` fields through
both Bun and Node. Cookie/session policy remains application logic.

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

You can subclass `AppError` for a domain error model (`class FeatureLocked extends
AppError`). `AppError.is(err)` identifies any instance — a direct one, a subclass,
even a copy from another bundle chunk or realm — by a global brand rather than
`instanceof`, so a domain error keeps its `code` / `details` / `hint` on every
transport (HTTP, MCP, agent). → ADR 0032.

### The error envelope

`AppError.toJSON()` renders the public envelope every transport returns:

```json
{ "error": { "code": "NOT_FOUND", "message": "Note not found" } }
```

`details` and `hint` are included when present. On HTTP this is the response
body with the matching status; for an MCP or agent call the same `code` and
`details` come back as a tool error. A schema-validation failure on the request
is turned into a `400 VALIDATION_ERROR` automatically — and it carries the
offending fields as structured `details.issues`, so a machine client matches on
them instead of parsing the text `message`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "name: Invalid input\nage: Invalid input",
    "details": {
      "issues": [
        { "path": "name", "code": "invalid_type", "message": "Invalid input" },
        { "path": "age",  "code": "invalid_type", "message": "Invalid input" }
      ]
    }
  }
}
```

Use the exported `zodIssues(error)` to build the same structured list from a
`ZodError` in your own hook.

### On the client

The client parses that envelope back into an `ApiError` with the same `code`,
`status`, `details` and `hint`, plus the response `x-request-id` as optional
readonly `traceId` — see [Typed client → ApiError](./client.md#apierror). The
error round-trips without adding correlation data to the response body.

### Stitch codes vs your codes

A `code` is a free string — your app codes (`BOT_NOT_FOUND`, …) are yours and the
core never models them (ADR 0002). But stitchkit itself emits a fixed set:
`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`,
`CONFLICT`, `RATE_LIMITED`, `VALIDATION_ERROR`, `INTERNAL_SERVER_ERROR`. They are
published as **`STITCH_ERROR_STATUS`** (the `code → status` map) and
**`StitchErrorCode`** (its `keyof`), with **`isStitchErrorCode()`** (→ ADR 0026).

If you translate stitch's framework errors into your own wire codes in an
`onError` hook, key the map by `StitchErrorCode` so it stays exhaustive — a code
stitch adds or renames becomes a compile error, not a silent `500`:

```ts
const STITCH_TO_APP: Record<StitchErrorCode, AppCode> = {
  NOT_FOUND: 'NOT_FOUND', METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  BAD_REQUEST: 'VALIDATION_ERROR', VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED', FORBIDDEN: 'FORBIDDEN', CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED', INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
}
onError: (ctx, err) => {
  if (AppError.is(err) && isStitchErrorCode(err.code)) {
    return jsonError(STITCH_TO_APP[err.code], err.status)   // keep stitch's status
  }
  // … your own AppError / normalizeError path
}
```

## Domain errors — `defineErrors`

Declare each domain code, HTTP status, default message and optional
structured-details schema in one immutable registry. The generated functions
construct typed branded `AppError` instances; ordinary `throw` remains explicit
at the call site:

```ts
import { z } from 'zod'

export const { errors, codes, definitions, isCode } = defineErrors({
  SESSION_NOT_FOUND: { status: 404, message: 'No such session' },
  QUOTA_EXCEEDED: {
    status: 429,
    message: 'Monthly quota exhausted',
    details: z.object({ retryAfterSeconds: z.number().int().positive() }),
  },
})

throw errors.SESSION_NOT_FOUND()                      // uses the declared message
throw errors.QUOTA_EXCEEDED({
  message: 'Try later',                               // overrides it here only
  details: { retryAfterSeconds: 30 },
  hint: 'Wait for the current window to expire',
})

// Construction without throwing is useful for composition or inspection.
const error = errors.QUOTA_EXCEEDED({ details: { retryAfterSeconds: 30 } })
definitions.QUOTA_EXCEEDED.status  // 429 — same source, no copied status map
definitions[code].message          // the declared text, by a `code` variable

// client — match the code, never a magic string
if (err instanceof ApiError && err.code === codes.SESSION_NOT_FOUND) { … }
```

`message` is optional: declare it once instead of repeating the sentence at every
`throw`, and a per-call `message` still wins. A code without one keeps the
existing fallback — `AppError.message` is the code itself. An empty declared
message is rejected when the registry is declared, not when the error is thrown.

**The tool envelope has no `message` field**, and what the model sees depends on
whether the code declares `details`:

| | HTTP / typed client | MCP / agent / CLI |
|---|---|---|
| code **with** a `details` schema | the declared message | no text at all — only `details` and `hint` |
| code **without** one | the declared message | the same text, delivered as `details.message` |

The model-facing envelope is `{ error, details?, _hint? }`; for a code with no
details schema the framework fills `details` with `{ message }`, so declaring a
message changes what the model reads there — it used to be the code itself. Put
anything the model must reliably read in `details` or `hint`, not in `message`.

With no `details` schema, the options object forbids `details`. A required
`z.object` makes `details` required; `z.object(...).optional()` makes it
optional. Supplied details are parsed when the error is constructed, before any
transport sees them. `code` remains literal and the parsed details type is
retained on the returned `AppError`.

HTTP renders the complete code/status/message/details/hint. Tool transports keep
their established model-facing projection (code/details/hint, without HTTP
status), while `invokeOrThrow` recovers the exact normalized `AppError`. The
codes and schemas remain application-owned; Stitchkit stays domain-free.

## `createErrorHook`

`createErrorHook` is the code-map above, packaged — you supply the exhaustive
`codeMap` and the envelope shape, it does the normalisation (including the
never-leak-an-internal-message rule for a raw throw):

```ts
const onError = createErrorHook({
  codeMap: {
    BAD_REQUEST: 'bad_request', VALIDATION_ERROR: 'bad_request',
    UNAUTHORIZED: 'unauthenticated', FORBIDDEN: 'forbidden',
    NOT_FOUND: 'not_found', METHOD_NOT_ALLOWED: 'not_found',
    CONFLICT: 'conflict', RATE_LIMITED: 'rate_limited',
    INTERNAL_SERVER_ERROR: 'internal',
    REALTIME_CONTRACT_VIOLATION: 'internal',
  } satisfies Record<StitchErrorCode, string>,
  // `ctx` is the request's RuntimeContext — read `ctx.traceId` for a
  // correlation id in the envelope. Declaring it is optional.
  render: (info, ctx) => ({
    ok: false,
    error: { code: info.code, message: info.message },
    traceId: ctx.traceId,
  }),
})

createServer({ services, hooks: { onError } })
```

Codes you threw yourself (not stitchkit's) pass through `codeMap` unchanged; the
`satisfies Record<StitchErrorCode, …>` keeps the map exhaustive across upgrades.

Both `onError` and `render` may be asynchronous and receive the matched endpoint
as their final argument. The observer is awaited before rendering, so it can
resolve identity or enrich the request context even for failures raised before
`beforeHandle`:

```ts
const onError = createErrorHook({
  onError: async (_error, _info, ctx, endpoint) => {
    await attributeFailedRequest(ctx, endpoint)
  },
  render: (info, ctx) => ({
    error: { code: info.code },
    actorId: ctx.actorId,
  }),
})
```

`endpoint` is `undefined` when the failure happened before route resolution.
Synchronous callbacks and renderers that declare fewer parameters continue to
work normally.

Invalid input (a `ZodError`) is classified as `VALIDATION_ERROR` 400 before it
reaches `render` — a client fault is an honest 400, not a 500 — and the
offending fields arrive as structured `info.details.issues`, so your `render`
can surface them to a machine client without parsing the message.

If you write a **bespoke** `onError` instead of using `createErrorHook`, run the
thrown value through the exported `normalizeError` to get the same classification
(a raw `ZodError` reaches your hook untouched, so the framework can inspect it —
call `zodIssues(err)` yourself if you want the structured fields):

```ts
import { normalizeError } from 'stitchkit/server'

onError: (ctx, err) => {
  const e = normalizeError(err)   // ZodError → VALIDATION_ERROR 400, else generic 500
  return jsonError(e.code, e.status, e.message)
}
```
