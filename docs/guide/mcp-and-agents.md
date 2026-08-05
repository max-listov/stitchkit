# MCP & AI agents

The same contract that drives the HTTP API also drives AI tooling. An endpoint
exposed on `MCP` becomes a [Model Context Protocol](https://modelcontextprotocol.io)
tool — callable from Claude, Cursor and other MCP clients. An endpoint exposed on
`AGENT` becomes a [Vercel AI SDK](https://sdk.vercel.ai) tool — callable from an
agent loop. No tool is hand-written; both come from the contract.

## Which endpoints become tools

By default every endpoint is a tool on every transport. `expose` narrows it:

```ts
{ method: 'GET', path: '/search', desc: 'Search the catalog' }                  // HTTP + MCP + AGENT
{ method: 'POST', path: '/sync', desc: 'Internal sync', expose: ['HTTP'] }       // HTTP only
{ method: 'GET', path: '/lookup', desc: 'Look up a price', expose: ['MCP'] }     // MCP tool only
```

`desc` is the tool description the model reads — write it for the model, not
just for a human. A `multipart` endpoint is never a tool. The tool name defaults
to a verb-aware name from the method + prefix (`list` → `list_widgets`, `get` →
`get_widget`); set `toolName` for an explicit one. Derivation normalises every
character outside `[a-zA-Z0-9_]` to `_` — the hyphen included, so `bot-status`
derives `get_bot_status` — while a name is *accepted* if it matches
`[a-zA-Z0-9_-]`, so a hyphen survives in an explicit `toolName`. A name that
still cannot be delivered (illegal explicit `toolName`, over 64 characters, or a
prefix with no usable character) throws at mount rather than at the first model
call —
→ [ADR 0035](../decisions/0035-tool-name-derivation-and-validation.md). See
[Contracts → transports](./contracts.md#transports).

### Pinning tool names — `listToolNames`

Derived tool names are part of your public surface — an MCP client config or an
agent prompt refers to them by string. `listToolNames(services)` resolves every
tool name your services expose (the exact resolver the mounts use), with its
`(service, method)` identity and transports, sorted — a stable shape to
snapshot:

```ts
import { listToolNames } from 'stitchkit/tools'

test('tool names have not drifted', () => {
  expect(listToolNames(services)).toMatchSnapshot()
})
```

A stitchkit upgrade (or a contract refactor) that would shift a derived name
now fails this test instead of silently breaking the clients that call the
tool. It is also the mechanical diff when migrating a service: run it before
and after, compare.

> **This is also the guard against a forgotten `expose`.** An endpoint that
> declares none is a tool on MCP **and** AGENT — the default is fail-open, and
> there is no contract-level `expose` to set once (→
> [ADR 0036](../decisions/0036-contract-level-meta.md)). A snapshot of
> `listToolNames` fails the build the moment an endpoint you meant to keep
> HTTP-only shows up in the list, which is the one check that catches it however
> many places the line was forgotten.

## MCP — `createMcpHandler`

`createMcpHandler` builds a complete Streamable-HTTP MCP server as a single
`Request → Response` handler. It owns the whole MCP lifecycle — the SSE event
store, per-session transports, the server instances — so your app never imports
`@modelcontextprotocol/sdk` itself.

```ts
import { createMcpHandler } from 'stitchkit/tools'

const handleMcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth: (req) => resolveApiKey(req),   // → an identity, or null for 401
  services: [usersService, catalogService],
})
```

Mount the returned handler on a raw route — typically `/mcp`:

```ts
createServer({
  services,
  rawRoutes: [{ method: 'ALL', path: '/mcp', handler: (req) => handleMcp(req) }],
})
```

### `McpHandlerConfig`

| Field | Purpose |
|-------|---------|
| `serverInfo` | MCP server identity — `{ name, version }` |
| `auth` | `(req) => identity \| null` — `null` rejects with 401 |
| `services` | the services to expose — an array, or `(auth) => ServiceDef[]` |
| `context` | `(auth) => {…}` — values merged into every tool handler's `ctx` |
| `lifecycle` | `beforeHandle` / `afterHandle` — the tool-side auth gate (see below) |
| `hooks` | tool-call observability hooks — `afterToolCall` fires on every result |
| `onIncompatibleSchema` | `'throw'` (default) · `'skip'` · `'warn'` — see below |
| `logger` | a `StitchLogger` for the `'warn'` policy |
| `nativeTools` | `(server, auth) => …` — register non-contract tools directly on the `McpServer`; receives the resolved identity, but is **not** a scope gate (`lifecycle` does not run for native tools) |
| `instructions` | a short host-facing usage hint, surfaced to MCP tool-search |

`services`, `context` and `nativeTools` all receive the resolved identity, so a
tenant can be shown only its own tools and every handler can read `ctx.tenantId`.

### Guarding tools — `lifecycle`

A tool call runs the same handler an HTTP request would. `lifecycle` makes it
run the same gate: a `beforeHandle` (throw to reject) and an `afterHandle`
(transform the result) — the tool-side twin of `createServer`'s hooks. Pass the
**same** [`createAuthHook`](./auth-and-errors.md#createauthhook) result you give
the HTTP server and tool calls are scope-checked by the identical rules:

```ts
createMcpHandler({ serverInfo, auth, services, lifecycle: { beforeHandle: authHook } })
```

Without it, a tool call bypasses the HTTP `beforeHandle` — the contract's
`scope` is not enforced on the MCP / agent surface. `mountMcp`, `mountAgent` and
`buildMcpServer` take `lifecycle` too.

The observability `hooks` are symmetric with the HTTP side too: `beforeToolCall`
and `afterToolCall` receive the resolved **`MethodDef`** as their last argument —
the tool-side twin of `afterHandle(ctx, result, endpoint)`. Read
`endpoint.serviceName` / `.key` / `.meta` directly for an audit row; you do not
need to rebuild a `toolName → identity` map:

```ts
hooks: {
  afterToolCall: (toolName, args, result, ms, ctx, endpoint) => {
    audit({ service: endpoint.serviceName, action: endpoint.key, ok: result.ok, ms })
  },
}
```

> **Tool-path identity.** A tool call has no `req`, so `createAuthHook` resolves
> identity through `resolveFromContext`, not `resolve`. Set it (read the
> identity your `auth` / `context` injected) — without it a scoped tool call
> has no identity and **fails closed**. See
> [Auth on the tool surface](./auth-and-errors.md#auth-on-the-tool-surface--resolvefromcontext).

### Incompatible schemas — `onIncompatibleSchema`

A contract schema that JSON Schema cannot represent (a `z.date()`, a `z.map()`)
cannot become a tool. `onIncompatibleSchema` decides what happens:

- `'throw'` (default) — fail the build, listing every offending tool. A static
  `services` array is checked when `createMcpHandler` is constructed, so a bad
  schema fails the deploy, not the first request. Better than a tool that
  silently vanishes from the surface.
- `'warn'` — log through `logger` and drop the tool.
- `'skip'` — drop the tool silently.

`validateMcpSchemas(services)` runs the same check on its own — useful in a
startup assertion or a test.

### Discriminated unions for weaker models — `flattenUnionInput`

A discriminated union in a tool's input becomes a JSON Schema `oneOf` / `anyOf`.
Capable models (Claude, Gemini, GPT) handle that; weaker / cheaper ones can drop
the field or mangle its strings. Set `flattenUnionInput: true` (on
`createMcpHandler` / `mountMcp` / `mountAgent`) to advertise each discriminated
union as a **single flat object** instead — the discriminator becomes an enum and
each variant's fields become optional with a `Required if <disc> = …` hint.

It is **deep**: unions are flattened at every depth — top level, object fields,
array items, and through `optional` / `nullable` / `default` / intersection
wrappers — so no `oneOf` survives anywhere (e.g. a `content.parts[]` that is an
array of a discriminated union). Schemas a transform cannot safely rebuild
(refined / piped / lazy / plain non-discriminated unions) are left as-is.

The flattened form is **lossy but never destructive**. Lossy: per-variant
strictness and object-level refinements are not advertised — the original schemas
enforce them in `executeToolMethod`. Not destructive: every object keeps its own
**key policy** (`.strict()` stays strict, `.loose()` / `.catchall()` still keep
extra keys), because the advertised schema is not advertised-only — the MCP and
AI SDKs parse the caller's arguments *with it* and hand the handler the parsed
result. An object advertised without its policy would silently delete keys the
contract would have rejected. → [ADR 0034](../decisions/0034-advertised-schema-key-policy.md).

A consequence worth knowing when you read logs: a `.strict()` violation is caught
by the SDK **before** the tool callback runs, so it comes back as an MCP
`InvalidParams` protocol error rather than a stitchkit `VALIDATION_ERROR`
envelope, and `beforeToolCall` / `afterToolCall` do not fire for it.

## `mountMcp`

If you already run an `McpServer` from the SDK, `mountMcp` adds contract tools
to it instead of owning the lifecycle:

```ts
import { mountMcp } from 'stitchkit/tools'

mountMcp(mcpServer, [usersService], { context: { source: 'mcp' } })
```

`createMcpHandler` is the batteries-included path; `mountMcp` is the building
block under it.

## MCP over stdio — `createStdioMcpServer`

`createMcpHandler` serves MCP over HTTP. `createStdioMcpServer` serves the same
contract tools over **stdio** — the server runs as a subprocess of the MCP
client (Claude Desktop, Claude Code, Cursor, Codex), on the user's machine, so
it can reach the local filesystem.

```ts
import { createStdioMcpServer } from 'stitchkit/tools'

await createStdioMcpServer({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth: resolveIdentity(),          // resolved once at startup, not per request
  services: [usersService],
})
```

A stdio server is a single process serving one client, so `auth` is a value (or
a promise of one) resolved once at startup — typically from an env var — rather
than a per-request `(req) => …`. Keep all logging on **stderr**: stdout is the
JSON-RPC channel.

Both transports build the server through the shared `buildMcpServer` — same
contract pipeline, same `services` / `context` / `hooks` / `nativeTools` /
`instructions`.

## OAuth 2.1 — a native remote connector

A remote MCP server is connectable from Claude (Desktop / web "custom
connector") only through the MCP authorization spec: OAuth 2.1 with PKCE, plus
the discovery documents (RFC 9728 / 8414), Dynamic Client Registration
(RFC 7591) and resource indicators (RFC 8707). A Bearer-only server returns a
bare `401` and the connector never establishes.

stitchkit ships the OAuth **protocol mechanics**; the app supplies only
**identity and storage**. Three pieces wire it together:

```ts
import { createMcpHandler, mountOAuthProvider, oauthProtectedResourceRoute } from 'stitchkit/tools'
import { createServer } from 'stitchkit/server'

const resource = 'https://api.example.com/mcp'
const issuer = 'https://api.example.com'

// 1. Resource server — the 401 now points at the metadata.
const handleMcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth: resolveOAuthToken,        // validate the Bearer JWT (verifyJwt + audience)
  services,
  protectedResource: { resource, authorizationServers: [issuer] },
})

// 2. Authorization server — DCR, /authorize (PKCE), /token.
const oauthRoutes = mountOAuthProvider({
  issuer,
  resource,
  signingSecret: env.OAUTH_SECRET,
  clients, codes, refreshTokens,  // your stores (DB or in-memory)
  authorizeUser,                  // your login + consent → { userId } | Response
})

createServer({
  services,
  rawRoutes: [
    { method: 'ALL', path: '/mcp', handler: (req) => handleMcp(req) },
    oauthProtectedResourceRoute({ resource, authorizationServers: [issuer] }),
    ...oauthRoutes,
  ],
})
```

Access tokens are signed HS256 JWTs (`signJwt`) whose `aud` is the resource and
whose `iss` is the issuer — validate both in `auth` with
`verifyJwt(token, secret, { audience: resource, issuer })`. `authorizeUser` is
where the app authenticates the user (reuse an existing session) and records
consent; return `{ userId }` to issue a code, or a `Response` to redirect the
browser to a login page first. The AS and resource server can co-locate or live
on separate origins. See
[ADR 0015](../decisions/0015-oauth-resource-server.md).

### Authorization hardening (MCP 2026-07-28)

- **`iss` on every authorization response (RFC 9207, SEP-2468).** Success *and*
  error redirects carry `iss`, and the AS metadata advertises
  `authorization_response_iss_parameter_supported: true`. A client that talks to
  several authorization servers validates `iss` before redeeming the code, which
  closes the **mix-up attack** — an attacker's server cannot pass its response
  off as this issuer's. Additive on the wire: a client that ignores `iss` is
  unaffected.
- **`application_type` on registration (SEP-837).** A client may declare
  `"native"` (desktop / CLI) or `"web"` in its DCR body. A **native** client may
  register an `http` loopback redirect (`http://127.0.0.1:…`, RFC 8252 §7.3); a
  **web** client is held to `https` only — that mismatch is the usual cause of
  the `redirect_uri` rejection CLI clients hit. Omit the field and registration
  behaves exactly as before (loopback allowed); an unknown value is rejected
  rather than silently defaulted.

> Dynamic Client Registration is **deprecated** in the 2026-07-28 spec in favour
> of Client ID Metadata Documents (CIMD), with a ≥12-month window. DCR keeps
> working and stays supported here; CIMD support is tracked separately.

## Proxying a remote API — `implementRemote`

`implement` binds a contract to local handlers. `implementRemote` binds it to a
remote HTTP API instead — every handler forwards the call to a deployed server
through the contract's typed client:

```ts
import { createHttpClient } from 'stitchkit'
import { createStdioMcpServer, implementRemote } from 'stitchkit/tools'

const http = createHttpClient({
  baseUrl: 'https://api.example.com',
  headers: () => ({ Authorization: `Bearer ${apiKey}` }),
})

await createStdioMcpServer({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth: null,
  services: contracts.map((c) => implementRemote(c, http)),
})
```

This is how you ship a thin **local** MCP server for an API that already runs in
the cloud: the local process owns only the transport and any filesystem-facing
native tools, while every contract tool proxies to the remote API. One contract,
no duplicated business logic.

`implementRemote(contract, http, { transformArgs })` takes an optional
`transformArgs` hook that rewrites a call's arguments before they are forwarded
— e.g. to upload a local file referenced in the args and swap in its URL.

## Structured output

When a contract endpoint declares an object `output`, its MCP tool registers
that as the tool `outputSchema` and the result carries `structuredContent`
alongside the text block — the structured payload an MCP App UI consumes.

## AI agents — `mountAgent`

`mountAgent` turns a service into a Vercel AI SDK `ToolSet`, ready for
`generateText` / `streamText`:

```ts
import { mountAgent } from 'stitchkit/tools'
import { generateText } from 'ai'

const tools = mountAgent(usersService, { context: { userId: 'agent-1' } })

const result = await generateText({
  model,
  tools,
  prompt: 'Create a user named Max',
})
```

Each contract endpoint exposed on `AGENT` becomes a tool whose input schema is
the merged `params` + `input`. `context` is merged into every tool handler's
`ctx`, alongside `source: 'agent'`.

### `AgentMountConfig`

| Field | Purpose |
|-------|---------|
| `context` | values merged into every tool handler's `ctx` |
| `lifecycle` | `beforeHandle` / `afterHandle` — the tool-side auth gate (see [Guarding tools](#guarding-tools--lifecycle)) |
| `hooks` | tool-call observability hooks — `afterToolCall` fires on every result |
| `extend` | add extra args resolved before the handler runs (see below) |

`lifecycle` works the same as on the MCP server — without it an agent tool call
bypasses the HTTP `beforeHandle` auth gate. Pass your `createAuthHook` result.

### Adding tool-only args — `extend`

`extend` adds **tool-only** arguments — fields the model fills that are resolved
into context, then stripped before the contract handler sees them. Use it when a
tool needs an argument the HTTP endpoint does not — the classic case being a
**multi-tenant** server reached by one API key, where the model passes `tenantId`
on every call. It is the same `ToolExtend` shape on `mountMcp`, `createMcpHandler`
and `mountAgent`:

```ts
interface ToolExtend {
  /** Extra Zod fields added to every matching tool's input schema. */
  schema: Record<string, z.ZodType>
  /** Turn the extra args into context merged into the handler's ctx. */
  resolve: (args: Record<string, unknown>) => Partial<Ctx> | Promise<Partial<Ctx>>
  /** Limit the extension to specific methods — default: every method. */
  filter?: (service: ServiceDef, method: MethodDef) => boolean
}
```

On the MCP server — add `tenantId` to each tool, validate access in `resolve`,
inject the resolved tenant into `ctx`, and `filter` to the tenant-scoped tools:

```ts
createMcpHandler({
  serverInfo, auth,
  services: [widgetsService],
  extend: {
    schema: { tenantId: z.string().describe('Tenant to act on') },
    resolve: async ({ tenantId }) => {
      const id = String(tenantId)
      if (!(await tenantExists(id))) throw new Error(`unknown tenant ${id}`)
      return { tenantId: id }          // merged into ctx → ctx.tenantId
    },
    filter: (_service, method) => method.scope === 'tenant',
  },
})
```

The model calls `widgets_list({ tenantId: 't_123' })`; `resolve` checks access and
puts `tenantId` on `ctx`; the contract handler reads `ctx.tenantId` (same place
as the HTTP prefix param — see
[Route groups → param prefixes](./server.md#param-prefixes-resource-scoped-paths)),
so one handler serves both surfaces. Pair `extend` with `lifecycle` (your
`createAuthHook`) so the tool call is still scope-gated.

## Native multimodal tools

Contract tools return JSON. For a tool that returns an image or other
multimodal content, register a native tool. `mountViewFile` is the built-in one
— it lets a model fetch and view a file (with SSRF and path-traversal
defenses):

```ts
import { createMcpHandler, mountViewFile } from 'stitchkit/tools'

const handleMcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth,
  services: [service],
  nativeTools: (server) => mountViewFile(server, { baseDir: '/srv/uploads' }),
})
```

## Logging tool calls — `createToolLogger`

Every tool mount fires an `afterToolCall` hook. `createToolLogger` is a ready
preset for it — one line logs each call (ok / failed, duration, which endpoint,
keyed by the endpoint's stable `serviceName` / `key` identity):

```ts
import { createToolLogger } from 'stitchkit/tools'

mountMcp(server, services, { hooks: createToolLogger() })
// [tool] ok list_widgets (widgets.list) 12ms
// [tool] warn get_widget (widgets.get) NOT_FOUND 4ms
```

Pass `log` to redirect the line, or `onRecord` to feed a metrics sink the
structured `ToolCallRecord`. For a boot-time picture of what is exposed where,
`summarizeTransports(services)` returns per-transport operation counts (HTTP /
MCP / AGENT / CLI) for you to log.

## One handler, three callers

A contract handler runs the same for an HTTP request, an MCP tool call and an
agent tool call. `ctx.source` (`'http'` · `'mcp'` · `'agent'`) tells it which —
the rest of the context (`params`, `input`, anything `context` injects) is
identical. Write the handler once; it serves every surface.
