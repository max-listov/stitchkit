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
to `prefix_key`; set `toolName` for an explicit one. See
[Contracts → transports](./contracts.md#transports).

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
| `nativeTools` | register non-contract tools directly on the `McpServer` |
| `instructions` | a short host-facing usage hint, surfaced to MCP tool-search |

`services` and `context` receive the resolved identity, so a tenant can be
shown only its own tools and every handler can read `ctx.tenantId`.

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

`extend` adds tool-only arguments — fields the model fills that are resolved
into context, then stripped before the contract handler sees them. Use it when a
tool needs an argument the HTTP endpoint does not.

`lifecycle` works the same as on the MCP server — without it an agent tool call
bypasses the HTTP `beforeHandle` auth gate. Pass your `createAuthHook` result.

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

## One handler, three callers

A contract handler runs the same for an HTTP request, an MCP tool call and an
agent tool call. `ctx.source` (`'http'` · `'mcp'` · `'agent'`) tells it which —
the rest of the context (`params`, `input`, anything `context` injects) is
identical. Write the handler once; it serves every surface.
