---
name: stitchkit
description: Build or change a backend with stitchkit — the contract-first framework where one defineContract() becomes an HTTP API, MCP tools, AI-agent tools, a CLI and a typed client. Use this whenever working in a project that depends on stitchkit: defining or editing a contract, implementing handlers, exposing endpoints as MCP or agent tools, wiring the typed client or the React data layer, Socket.IO realtime, auth/scopes, the error model, file/multipart serving, the optional durable agent runtime (`stitchkit/agent-runtime`), the optional managed application kernel (`stitchkit/application`), or deploying on Bun/Node. Use it even when the user just says "add an endpoint", "wire up the API", "expose this as an MCP tool", "make a typed client", or mentions defineContract / createServer / createClient / createMcpHandler / implement — even if they don't say "stitchkit". Do NOT use it for modifying the stitchkit framework's own source (that's AGENTS.md in the stitchkit repo).
---

# Building with stitchkit

stitchkit is **contract-first**: you describe each operation once with
`defineContract()` (method, path, Zod `params`/`input`/`output`, `scope`, which
transports it's exposed on), and the same contract drives the HTTP route, the MCP
tool, the agent tool, the CLI command and a fully-typed client. **One source of
truth — the transports cannot drift.** Your job is to keep that property: change
the contract, never hand-maintain a parallel type or a second copy of a route.

## Read the docs — they ship in the package

The guide and API reference travel with the package, cut into slices of at most
50 KB — one per entrypoint:

- **`node_modules/stitchkit/llms.txt`** — the index: every slice, its parts and
  their sizes. Start here.
- **`node_modules/stitchkit/llms/<entrypoint>.txt`** — the slice for what you
  import: its API reference section and the guide pages that belong to it. Each
  guide lives in one slice only; a slice that also needs a guide from another one
  opens with "Also read: see `llms/<other>.txt` for the … guide" — follow it.
  `stitchkit/server` → `llms/server.txt`, `stitchkit/agent-runtime/sqlite/bun` →
  `llms/agent-runtime-sqlite-bun.txt`, the root `stitchkit` → `llms/stitchkit.txt`.
  A longer slice continues in `llms/<entrypoint>.2.txt`, `.3.txt`…; every part
  lists which guide page sits in which part, so load the part you need.
- **Moving across versions?** Load `llms/upgrading.txt` and the range slices it
  lists between your installed version and the target.

Load the slice of each entrypoint the code you touch imports before writing
non-trivial code; don't guess an API's shape. Do not read `llms-full.txt` — it
inlines everything and is far larger than your context.

## The build flow

Work in this order; each step links a contract field to a transport.

1. **Define the contract** (`defineContract`) — usually in a shared package so
   front and back share it. Zod schemas are the source of truth; `scope` is a
   free string you'll gate on — or your own typed union via
   `createContractFactory<Scope>()`. → `llms/contract.txt`, § Contracts.
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
  normalises **per half**: the service half turns everything outside
  `[a-zA-Z0-9_]` into `_` (`bot-status` ⇒ `get_bot_status`), the method half
  keeps its hyphen (`get-user` ⇒ `get-user_notes`). An explicit `tool.name` is
  verbatim. A name that still cannot be delivered throws at mount.
- **Tools want a card, the UI wants the record?** Don't add a second endpoint on
  the same path or branch on `ctx.source`. Wrap the endpoint in `withToolView(
  endpoint, { defaults, output, project })`: HTTP keeps the full answer, MCP /
  agent / CLI get the projected one with its own schema, and `defaults` (e.g.
  `include: []`) reach the one handler before parsing, so it loads less.
- **One error model.** Throw `AppError` (`badRequest`, `notFound`, …). It renders
  the same envelope on HTTP and as a tool error, and the client parses it back
  into `ApiError`. To map stitch's own framework codes to your app codes, key off
  the exported `StitchErrorCode` / `STITCH_ERROR_STATUS` registry — don't
  hand-copy code strings.
- **Install the optional peer for each feature you use** — they don't auto-install
  (see the matrix below). A missing one fails with an actionable "install X".
- **Upgrading stitchkit?** Ask the package, in the project you are upgrading:
  `bunx stitchkit@latest upgrade` (or `npx`) prints every `### ⚠️ Breaking
  changes` section between the installed version and the latest, oldest first,
  each with its **Who must act** line. It reads the installed version from
  `node_modules` and the changelog from inside the package, so there is nothing
  to clone and nobody to ask; `--from` / `--to` set a different range.
  `docs/guide/upgrading.md` expands the sections into migrations. A version with
  no such section is purely additive.

## Optional peers — install per feature

`ky` is bundled. Everything else is an optional peer your app installs:

`zod` is needed for anything. **The full feature → package table lives in the
getting-started guide** (`llms/stitchkit.txt`, *Dependencies*) — it is
not restated here, because a second copy is a copy that drifts: the two that
existed had already lost `srvx` from one and `@socket.io/component-emitter` from
both. Read it there; the four that come up most:

- `serveNode` on Node ≥ 22 → `srvx`
- MCP / agent tools → `@modelcontextprotocol/server`, `ai`
- Socket.IO server → `socket.io`, plus `@socket.io/bun-engine` on Bun
- React data layer → `@tanstack/react-query`, `react-query-kit`

## Task → which doc section

| You're doing… | Guide page | In slice |
|---------------|------------|----------|
| a new/edited endpoint, schema, scope, meta, multipart | Contracts | `llms/contract.txt` |
| handlers, hooks, raw routes, `serveFile`, `scopePrefixes`, multipart limits | HTTP server | `llms/server.txt` |
| the typed client, scoped client, SSE | Typed client | `llms/stitchkit.txt` |
| MCP / agent tools, tool auth, `extend`, identity | MCP & agents | `llms/tools.txt` |
| a CLI from the contract | CLI | `llms/cli.txt` |
| Socket.IO, cache bridge, raw WebSocket lane | Realtime | `llms/server.txt` |
| scopes, auth hooks, JWT/cookies, error model + code registry | Auth & errors | `llms/server.txt` |
| request/tool-call logging, trace context, audit | Observability | `llms/observability.txt` |
| testing, deploy on Bun/Node | Testing & deployment | `llms/testing.txt` |
| `/tenants/:id/…` multi-tenant wiring end-to-end | Multi-tenant | `llms/server.txt` |
| durable agent runs, history, models, fencing, recovery | Agent runtime | `llms/agent-runtime.txt` |
| process-local resources, readiness, admission, schedules, shutdown | Managed application kernel | `llms/application.txt` |
| cutting an existing poller, queue or DB bootstrap over to the kernel | Application migration recipes | `llms/application.txt` |
| moving across stitchkit versions | Upgrading | `llms/upgrading.txt` + its range slices |
| what a repository says about itself: identity, roles, build, release steps, the names of the values a deployment supplies | Project declaration | `llms/declaration.txt` |
| visitor tracking: the outbox, the visit lease, the page-leave beacon, visible time, clicks, attribution, and the server-side decisions | Visitor tracking | `llms/tracking.txt` |
| the page reloads onto the release it was built for: build marker, `X-Build-Id`, socket event, reload policy | Release | `llms/release.txt` |

Some of those surfaces are declared **evolving** — `stitchkit/declaration`,
`stitchkit/tracking`, `stitchkit/release`, `stitchkit/live`, `stitchkit/agent-runtime` and `stitchkit/application` may be redefined in any minor, always with a marked
breaking change and a migration section. The Entrypoints table in the
getting-started guide is the authoritative list of which is which; read
`Upgrading` before crossing a minor on an evolving one.

When in doubt, open `llms.txt`, pick the slice of the entrypoint you import,
read the part holding that guide page, then write the code.
