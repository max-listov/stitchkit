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

Two kinds of endpoint are **never** tools, whatever `expose` says: a `multipart`
upload (not a tool call), and a
[`rawResponse`](./server.md#raw-response-endpoints) endpoint (its answer is
bytes — a tool result cannot carry them, and it would reach the model as `{}`).
Pin the full list with `listToolNames` in a snapshot test.

`desc` is the tool description the model reads — write it for the model, not
just for a human. The tool name defaults
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
`Request → Response` handler. It owns the SDK server and transport lifecycle, so
your app never imports `@modelcontextprotocol/sdk` itself.

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
| `extend` | extra advertised arguments resolved into handler context |
| `schemaValidation` | compatibility policy, typed-property guard and portable-format guard |
| `logger` | a `StitchLogger` for the `'warn'` policy |
| `nativeTools` | `({ registerTool, rawServer }, auth) => …` — protected native registration plus an explicit raw SDK escape hatch |
| `resources` | MCP Apps `ui://` resources mounted on every server |
| `instructions` | a short host-facing usage hint, surfaced to MCP tool-search |
| `coerceJsonArgs` | coerce JSON-stringified object/array arguments (default `true`) |
| `flattenUnionInput` | advertise discriminated unions as one object (default `false`) |
| `errorHint` | add a project-owned hint to failed tool results |
| `onOutputStrip` | observe output keys removed by contract validation |
| `protectedResource` | RFC 9728 metadata used by HTTP `401` responses |
| `sessionMode` | `'stateless'` (default) or explicit `'stateful'` session/SSE continuity |

`services`, `context` and `nativeTools` all receive the resolved identity, so a
tenant can be shown only its own tools and every handler can read `ctx.tenantId`.

### Stateless by default; stateful only when required

The default `sessionMode: 'stateless'` creates a fresh SDK server, transport,
resolved auth/context and runner for each HTTP request. Static contract schemas
are still prepared once when the handler is constructed. There is no session
map, event store, sweep timer or `Mcp-Session-Id`, so process replacement and
load balancing cannot strand a client on an in-memory session.

Opt into `sessionMode: 'stateful'` only when the client needs server-initiated
messages, cross-request progress or resumable SSE. That mode issues a server
session id and retains the bounded session/event stores until idle expiry.

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
and `afterToolCall` receive the resolved **`MethodDef`** as `endpoint` —
the tool-side twin of `afterHandle(ctx, result, endpoint)`. Read
`endpoint.serviceName` / `.key` / `.meta` directly for an audit row; you do not
need to rebuild a `toolName → identity` map:

```ts
hooks: {
  afterToolCall: ({ result, durationMs, endpoint }) => {
    audit({
      service: endpoint.serviceName,
      action: endpoint.key,
      ok: result.ok,
      ms: durationMs,
    })
  },
}
```

> **Tool-path identity.** A tool call has no `req`, so `createAuthHook` resolves
> identity through `resolveFromContext`, not `resolve`. Set it (read the
> identity your `auth` / `context` injected) — without it a scoped tool call
> has no identity and **fails closed**. See
> [Auth on the tool surface](./auth-and-errors.md#auth-on-the-tool-surface--resolvefromcontext).

### MCP schema validation profile

A contract schema that JSON Schema cannot represent (a `z.date()`, a `z.map()`)
cannot become a tool. `schemaValidation.policy` decides what happens:

- `'throw'` (default) — fail the build, listing every offending tool. A static
  `services` array is checked when `createMcpHandler` is constructed, so a bad
  schema fails the deploy, not the first request. Better than a tool that
  silently vanishes from the surface.
- `'warn'` — log through `logger` and drop the tool.
- `'skip'` — drop the tool silently.

`validateMcpSchemas({ services })` runs the same check on its own — useful in a
startup assertion or a test.

For a static `services` array, collection, schema conversion and every enabled
validation guard run once when the handler is created. Each HTTP request or
stateful session still receives a fresh `McpServer`, runner, context and native
registration over that immutable prepared surface. A `services(auth)` factory
is deliberately prepared after resolving each identity because its tool set may
change by tenant.

#### Is every property actually usable by a model?

A tool schema is the only instruction a model gets about the shape of its
arguments. A property that carries a `description` and no `type` / `enum` /
`anyOf` / `$ref` tells it nothing — and nothing fails: the schema converts, the
mount succeeds, the tool is advertised, and the model then guesses, retrying the
same wrong guess because the error does not say what the right one would be.

```ts
validateMcpSchemas({
  services,
  policy: 'throw',
  logger,
  extend,
  flattenUnionInput: true,
  requireTypedProperties: true,
  allowUntyped: ['docs_create.payload'],   // deliberately free-form
  requirePortableFormats: true,
  allowFormats: [],
})
```

Off by default, because a contract may legitimately declare `z.unknown()`.
`allowUntyped` takes dotted `tool.property` paths — an entry there is a decision,
anything else is a finding. On `createMcpHandler`, put the policy under
`schemaValidation`; the handler supplies its real `extend` and
`flattenUnionInput`, so the check cannot vet a different document from the one
advertised.

`requirePortableFormats` rejects custom `format` values common MCP/AJV clients
do not know, such as the `cuid2` emitted by `z.cuid2()`. Use a portable
schema/pattern, or list it in `allowFormats` only when every client supports it.
stitchkit never removes or rewrites the keyword.

`findUntypedProperties(jsonSchema)` is the same walk, exported on its own if you
want to assert on a schema you built elsewhere.

### Discriminated unions for weaker models — `flattenUnionInput`

A discriminated union in a tool's input becomes a JSON Schema `oneOf` / `anyOf`.
Capable models (Claude, Gemini, GPT) handle that; weaker / cheaper ones can drop
the field or mangle its strings. Set `flattenUnionInput: true` (on
`createMcpHandler` / `mountMcp` / `mountAgent`) to advertise each discriminated
union as a **single flat object** instead — the discriminator becomes an enum and
each variant's fields become optional with a `Required if <disc> = …` hint.

**A field several variants declare keeps its type.** Flattening puts every
variant's fields side by side, so a key two variants share has to be advertised
as one thing. Where they agree, that is what you get; where they disagree — a
`.refine()` only one of them carries, two different bounds on the same number, an
enum against a free string — the *constraint* is dropped and the **type** is not.
A field that is a number in every variant is advertised as a number, not as a
bare description. Only genuinely different kinds (a string in one variant, a
number in another) fall back to unconstrained. → ADR 0044

It is **deep** because the projection walks the generated JSON Schema document,
including objects, arrays, tuples and schema-definition nodes. Structurally
identifiable discriminated object unions are flattened wherever they occur.
Plain unions and unions hidden behind unresolved external references remain
unions because Stitchkit cannot soundly invent a discriminator.

The flattened form is **lossy but never executable**. Per-variant refinements
and incompatible constraints are widened in the presentation document; the
original Zod contract enforces them exactly once inside `executeToolMethod`.
MCP and AI adapters forward the raw argument object unchanged, so defaults,
coercions and transforms cannot run before Stitchkit. Strict violations return
the normal `VALIDATION_ERROR` tool envelope and fire `beforeToolCall` /
`afterToolCall`. → [ADR 0050](../decisions/0050-presentation-schema-is-not-a-parser.md).

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

Contract tools return JSON. A native tool can return MCP text/image/audio/
resource content directly while still using stitchkit's input/output validation,
isolated per-call context, lifecycle/RBAC and tool hooks:

```ts
import { createMcpHandler } from 'stitchkit/tools'
import { z } from 'zod'

const handleMcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth,
  services: [service],
  lifecycle: { beforeHandle: authHook },
  hooks: audit.toolCall,
  nativeTools: ({ registerTool }, identity) => {
    registerTool({
      name: 'render_preview',
      description: 'Render and inspect a preview',
      identity: {
        serviceName: 'mediaTools',
        action: 'renderPreview',
        scope: 'admin',
        method: 'POST',
      },
      input: z.object({ prompt: z.string() }),
      output: z.object({ assetId: z.string() }),
      handler: async ({ input, traceId }) => ({
        content: [
          { type: 'image', data: await renderBase64(input.prompt), mimeType: 'image/png' },
          { type: 'text', text: `trace: ${traceId}` },
        ],
        structuredContent: { assetId: await saveAsset(identity) },
      }),
    })
  },
})
```

The configured identity becomes the hook/lifecycle `OperationIdentity` and the
tool `RequestEvent` (`serviceName`, `action`, `httpMethod`). A native operation
has no HTTP route, so no fake `path` is added to that identity. If `output` is
declared, stitchkit parses `structuredContent` with it after `afterHandle`; all
other MCP fields and content blocks are preserved.

The MCP registration uses an identity carrier: the SDK advertises the compiled
JSON Schema but forwards the raw object into Stitchkit. Input failures therefore
use the same validation, lifecycle and hook path as contract tools.

### Explicit raw SDK registration

`rawServer` is deliberately named as an escape hatch. A tool registered there
does **not** receive stitchkit schema policy, lifecycle, per-call context or
hooks. The built-in `mountViewFile` helper remains raw for callers that choose
that boundary; it fetches media with SSRF and path-traversal defenses:

```ts
import { createMcpHandler, mountViewFile } from 'stitchkit/tools'

const handleMcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth,
  services: [service],
  nativeTools: ({ rawServer }) =>
    mountViewFile(rawServer, { baseDir: '/srv/uploads' }),
})
```

Use raw registration only when opting out is intentional. For a protected
`view_file`, define it through `registerTool` and call the exported
`resolveMedia` core from its handler.

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
structured `ToolCallRecord`. That record carries `traceId` whenever an
observability context is active, so a tool call made inside an HTTP request
joins that request's log line on one key — see
[Observability](./observability.md). For a boot-time picture of what is exposed where,
`summarizeTransports(services)` returns per-transport operation counts (HTTP /
MCP / AGENT / CLI) for you to log.

## One handler, three callers

A contract handler runs the same for an HTTP request, an MCP tool call and an
agent tool call. `ctx.source` (`'http'` · `'mcp'` · `'agent'`) tells it which —
the rest of the context (`params`, `input`, anything `context` injects) is
identical. Write the handler once; it serves every surface.
