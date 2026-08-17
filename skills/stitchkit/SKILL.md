---
name: stitchkit
description: Build or change a backend with stitchkit — the contract-first framework where one defineContract() becomes an HTTP API, MCP tools, AI-agent tools, a CLI and a typed client. Use this whenever working in a project that depends on stitchkit: defining or editing a contract, implementing handlers, exposing endpoints as MCP or agent tools, wiring the typed client or the React data layer, Socket.IO realtime, auth/scopes, the error model, file/multipart serving, or deploying on Bun/Node. Use it even when the user just says "add an endpoint", "wire up the API", "expose this as an MCP tool", "make a typed client", or mentions defineContract / createServer / createClient / createMcpHandler / implement — even if they don't say "stitchkit". Do NOT use it for modifying the stitchkit framework's own source (that's AGENTS.md in the stitchkit repo).
---

# Building with stitchkit

stitchkit is **contract-first**: you describe each operation once with
`defineContract()` (method, path, Zod `params`/`input`/`output`, `scope`, which
transports it's exposed on), and the same contract drives the HTTP route, the MCP
tool, the agent tool, the CLI command and a fully-typed client. **One source of
truth — the transports cannot drift.** Your job is to keep that property: change
the contract, never hand-maintain a parallel type or a second copy of a route.

## Read the docs — they ship in the package

The full guide and API reference travel with the package:

- **`node_modules/stitchkit/llms.txt`** — a curated index of every guide page +
  the API reference (one line each). Start here to find the right page.
- **`node_modules/stitchkit/llms-full.txt`** — the entire guide + reference
  inlined. Read the relevant section in full before writing non-trivial code;
  don't guess an API's shape.

Pull the matching section before each task — the map below says which.

## The build flow

Work in this order; each step links a contract field to a transport.

1. **Define the contract** (`defineContract`) — usually in a shared package so
   front and back share it. Zod schemas are the source of truth; `scope` is a
   free string you'll gate on — or your own typed union via
   `createContractFactory<Scope>()`. → `llms-full.txt` § Contracts.
2. **Implement handlers** (`implement` / `createImplement<Ctx>` for a typed
   context, `createScopedImplement<Scopes>` when each scope guarantees different
   context fields). A handler is a pure `(ctx) => result`; `ctx.input` /
   `ctx.params` are typed from the schemas. → § HTTP server.
3. **Serve** — `createServer({ services })` on Bun, or `serveNode(...)` on Node
   ≥ 22. Add lifecycle hooks (`beforeHandle` for auth, `afterHandle`,
   `onError`). → § HTTP server.
4. **Consume** — `createClient(contract, createHttpClient({ baseUrl }))` for a
   typed client; `createCursorQuery` for the React data layer. → § Typed client.
5. **Expose to AI** (optional) — `createMcpHandler` (MCP) and `mountAgent` (AI
   SDK). The *same* handlers run; guard them with the same `createAuthHook` via
   `lifecycle`. → § MCP & agents.
6. **Realtime / errors / auth / deploy** as needed — see the map below.

## Rules that keep a consumer clean

- **Zod-first, never duplicate a type.** Types come from `z.infer` / the
  contract. If you're hand-writing an interface that mirrors a schema, stop and
  infer it.
- **Don't fight the framework.** Use the provided wrappers — `createSocketIOServer`
  / `createSocketIOClient` for WebSockets, `createCursorQuery` for React. Don't
  bolt on a second WebSocket engine or data layer.
- **`scope` drives auth (and optionally paths).** One `createAuthHook` guards
  every transport at once — don't re-check auth per handler. For resource-scoped
  APIs, `scopePrefixes` maps a scope to a URL prefix.
- **Tool names**: a tool name must match `[a-zA-Z0-9_-]`, ≤64 chars. Derivation
  normalises everything outside `[a-zA-Z0-9_]` to `_` — hyphen included, so
  `bot-status` ⇒ `get_bot_status`; a hyphen survives only in an explicit
  `toolName`. A name that still cannot be delivered throws at mount.
- **One error model.** Throw `AppError` (`badRequest`, `notFound`, …). It renders
  the same envelope on HTTP and as a tool error, and the client parses it back
  into `ApiError`. To map stitch's own framework codes to your app codes, key off
  the exported `StitchErrorCode` / `STITCH_ERROR_STATUS` registry — don't
  hand-copy code strings.
- **Install the optional peer for each feature you use** — they don't auto-install
  (see the matrix below). A missing one fails with an actionable "install X".
- **Upgrading stitchkit?** Read `docs/guide/upgrading.md`: scan each version's
  `### ⚠️ Breaking changes` between your current and target version. A version
  without that section is purely additive.

## Optional peers — install per feature

`ky` is bundled. Everything else is an optional peer your app installs:

| Feature | Install |
|---------|---------|
| validation (always) | `zod` |
| `serveNode` (Node ≥ 22) | `srvx` (+ `@types/bun` dev) |
| MCP server/tools | `@modelcontextprotocol/server` |
| MCP host/client tests | `@modelcontextprotocol/client` |
| MCP Apps | `@modelcontextprotocol/ext-apps` |
| agent tools | `ai` |
| React data layer | `@tanstack/react-query` `react-query-kit` |
| Socket.IO server on Bun | `socket.io` `@socket.io/bun-engine` |
| Socket.IO server on Node | `socket.io` |
| Socket.IO client | `socket.io-client` |

## Task → which doc section

| You're doing… | Read (`llms-full.txt` §) |
|---------------|--------------------------|
| a new/edited endpoint, schema, scope, meta, multipart | Contracts |
| handlers, hooks, raw routes, `serveFile`, `scopePrefixes`, multipart limits | HTTP server |
| the typed client, scoped client, SSE | Typed client |
| MCP / agent tools, tool auth, `extend`, identity | MCP & agents |
| a CLI from the contract | CLI |
| Socket.IO, cache bridge, raw WebSocket lane | Realtime |
| scopes, auth hooks, JWT/cookies, error model + code registry | Auth & errors |
| request/tool-call logging, trace context, audit | Observability |
| testing, deploy on Bun/Node | Testing & deployment |
| `/tenants/:id/…` multi-tenant wiring end-to-end | Multi-tenant |
| moving across stitchkit versions | Upgrading |

When in doubt, open `llms.txt`, pick the page, read that section of
`llms-full.txt` in full, then write the code.
