<p align="center">
  <strong>Contract-first backend framework for Bun and Node.</strong><br/>
  Define your API once — get an HTTP API, MCP tools, AI-agent tools, a CLI and a typed client.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/stitchkit"><img src="https://img.shields.io/npm/v/stitchkit?color=2563eb" alt="npm version" /></a>
  <a href="https://github.com/max-listov/stitchkit/actions/workflows/ci.yml"><img src="https://github.com/max-listov/stitchkit/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/stitchkit?color=2563eb" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=000" alt="Bun" />
  <img src="https://img.shields.io/badge/runtime-Node%20%E2%89%A522-339933?logo=nodedotjs&logoColor=fff" alt="Node >= 22" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/max-listov/stitchkit/master/assets/infographic-hero.jpg" alt="One contract becomes an HTTP API, MCP tools, AI-agent tools and a typed client" width="100%" />
</p>

<p align="center">
  <em>One <code>defineContract()</code> → an HTTP API, MCP tools, AI-agent tools and a CLI on the server — plus a fully-typed client to call them.</em>
</p>

---

## Why

- **One contract, five surfaces.** Define your API once — get HTTP routes, MCP tools (for Claude/Cursor), AI SDK tools (for agents), a [CLI](./docs/guide/cli.md) (for scripts & Skills), and a typed client.
- **Zero HTTP framework deps.** Built on `Bun.serve()` (Bun) or `srvx` (Node). No Hono, no Elysia, no Express.
- **Fullstack type safety.** Server handlers, client calls, MCP tools — all typed from the same contract.
- **Inspectable.** A focused core with explicit adapters. No generated
  application code or framework build step in your app.
- **Thin over what you already use.** WebSocket = Socket.IO (`createSocketIOClient` / `createSocketIOServer`). React data layer = `react-query-kit` (`createCursorQuery`). stitchkit owns the contract and the transport — not its own competing WebSocket or hook engine.

### The problem it solves

A modern backend exposes the *same* operations several ways — an HTTP API for the
app, MCP tools for assistants like Claude and Cursor, tool definitions for AI
agents, and a CLI for scripts and Skills. Written by hand, that is one surface
described many times: many places to drift, many places to keep in sync.
stitchkit collapses them into a single contract — change it once, every surface
and the typed client move together.

<p align="center">
  <img src="https://raw.githubusercontent.com/max-listov/stitchkit/master/assets/infographic-compare.jpg" alt="Without stitchkit: the same API hand-written three times. With stitchkit: one contract drives them all." width="100%" />
</p>

## Status

Pre-1.0. The core is stable and covered by tests, but the public API may still
change between minor versions until 1.0. Bun is first-class; Node ≥ 22 is
supported via `stitchkit/node`.

## Install

Start a production-shaped Next.js, Stitchkit and PostgreSQL application:

```bash
bun create stitchkit my-app
cd my-app
# Point DATABASE_URL in .env at your PostgreSQL database.
bun run dev
```

To add Stitchkit to an existing project instead:

```bash
bun add stitchkit        # Bun
npm install stitchkit    # Node
pnpm add stitchkit       # pnpm
```

## Import policy

Browser code imports browser-safe entrypoints:

```ts
import { defineContract, createClient, createHttpClient } from 'stitchkit'
import { createSocketIOClient } from 'stitchkit'
import { createCursorQuery, createCacheBridge } from 'stitchkit/react'
import { parseSSE } from 'stitchkit'
```

Server code imports server entrypoints:

```ts
import { createServer, createHandler, implement } from 'stitchkit/server'
import { createSocketIOServer, createAuthHook } from 'stitchkit/server'
import { createMcpHandler, mountAgent } from 'stitchkit/tools'
import { createAgentRuntime, defineAgentProtocol } from 'stitchkit/agent-runtime'
import { createApplication, defineManagedResource } from 'stitchkit/application'
import { implementRemote } from 'stitchkit/remote'
```

The root `stitchkit` entrypoint is browser-safe. Server, tool, optional managed
application, AI-SDK-backed agent-runtime and peer-free remote-proxy code live
behind `stitchkit/server`, `stitchkit/tools`, `stitchkit/application`,
`stitchkit/agent-runtime` and `stitchkit/remote` respectively. Optional provider
adapters are isolated further; importing `stitchkit/application` never resolves
grammY or OpenTelemetry.

## Managed application kernel

Use [`stitchkit/application`](./docs/guide/application-kernel.md) when several
process-local resources must start, become ready, drain and stop as one
application:

```ts
import {
  createApplication,
  createManagedSchedule,
  managedServerResource,
} from 'stitchkit/application'
import { bindProcessSignals } from 'stitchkit/server'

const app = createApplication({
  id: 'service',
  resources: [
    managedServerResource({ id: 'http', server }),
    createManagedSchedule({
      id: 'cleanup',
      everyMs: 60_000,
      run: ({ signal }) => removeExpiredRecords(signal),
    }),
  ],
})

bindProcessSignals(app)
await app.start()
```

The kernel owns dependency ordering, attempted-start rollback, readiness,
process-local admission, ephemeral schedules and bounded shutdown. It does not
own durable jobs, provider policy, retries, process restart or deployment.
`createApplicationOperationalHandlers` projects conventional status/readiness/
liveness routes from the same snapshot. Applications that already own an
OpenTelemetry SDK may opt into `stitchkit/application/opentelemetry`; the
adapter registers pull-only observable gauges on an injected Meter and owns no
exporter or SDK lifecycle.

## Quick Start

### 1. Define a contract

```ts
// shared/contracts.ts
import { defineContract } from 'stitchkit'
import { z } from 'zod'

const UserSchema = z.object({ id: z.string(), name: z.string() })
const CreateUserSchema = z.object({ name: z.string() })
const IdSchema = z.object({ id: z.string() })

export const users = defineContract({ prefix: 'users' }, {
  list:   { method: 'GET',    path: '/',    desc: 'List all users',  output: z.array(UserSchema) },
  create: { method: 'POST',   path: '/',    desc: 'Create a user',   input: CreateUserSchema, output: UserSchema },
  get:    { method: 'GET',    path: '/:id', desc: 'Get user by ID',  params: IdSchema, output: UserSchema },
  delete: { method: 'DELETE', path: '/:id', desc: 'Delete a user',   params: IdSchema },
})
```

### 2. Implement handlers

```ts
// server/index.ts
import { implement, createServer } from 'stitchkit/server'
import { users } from '../shared/contracts'

const service = implement(users, {
  list:   (ctx) => db.users.findMany(),
  create: (ctx) => db.users.create({ name: ctx.input.name }),
  get:    (ctx) => db.users.findById(ctx.params.id),
  delete: (ctx) => db.users.delete(ctx.params.id),
})

createServer({ services: [service], port: 3000 })
```

### 3. Use from the client

```ts
// client/api.ts
import { createClient, createHttpClient } from 'stitchkit'
import { users } from '../shared/contracts'

const http = createHttpClient({ baseUrl: '/api' })
export const api = createClient(users, http)

await api.list()                  // GET /users → User[]
await api.create({ name: 'Max' }) // POST /users → User
await api.get({ id: '123' })      // GET /users/123 → User
```

For many contracts at once, use `createClients(contractRegistry, http)`.

### 4. React data layer (react-query-kit)

stitchkit does not ship its own hook engine — pair the typed client with
[`react-query-kit`](https://github.com/liaoliao666/react-query-kit), wrapping
the client methods directly:

```ts
import { createMutation, createQuery } from 'react-query-kit'
import { api } from './api'

export const useUsers = createQuery({ queryKey: ['users'], fetcher: () => api.list() })
export const useCreateUser = createMutation({ mutationFn: api.create })
```

The ordinary generated method contains only contract variables, so it remains
safe to pass directly as a query or mutation callback. Imperative calls that
need cancellation use the method's explicit transport-options surface:

```ts
await api.create.withOptions({ name: 'Max' }, { signal })
await api.health.withOptions({ signal }) // endpoint without contract arguments
```

For cursor-paginated lists, `createCursorQuery` is the canonical helper:

```ts
import { createCursorQuery } from 'stitchkit/react'
import { api } from './api'

export const useFeed = createCursorQuery({ queryKey: ['feed'], endpoint: api.feed.list })
```

It injects `cursor` from the page param and bakes in `getNextPageParam`. Page
size is the server's call — the contract's `limit` default — never the client's.

### 5. MCP tools (for Claude, Cursor, etc.)

```ts
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools'

const mcp = createMcpHandler({
  serverInfo: { name: 'my-app', version: '1.0.0' },
  auth: (req) => resolveApiKey(req),     // → identity, or null for 401
  services: [service],                   // contract endpoints with expose: ['MCP']
})

createServer({
  services: [service],
  rawRoutes: [createMcpHttpRoute({ path: '/mcp', handler: mcp })],
})

// On shutdown: await mcp.close()
```

### 6. AI Agent tools

```ts
import { mountAgent } from 'stitchkit/tools'
import { generateText } from 'ai'

const tools = mountAgent(service, { context: { userId: 'agent-1' } })
const result = await generateText({ model, tools, prompt: 'Create a user named Max' })
```

### 7. WebSocket (Socket.IO)

For applications that want Stitchkit to own durable message/run transitions,
stream checkpoints, interruption and managed-tool fencing, use the optional
[`stitchkit/agent-runtime`](docs/guide/agent-runtime.md). `mountAgent` remains
the smaller application-owned-loop path.

stitchkit's WebSocket layer is Socket.IO — `polling` fallback, heartbeat, acks,
a mature client. The wrappers cover the boilerplate.

```ts
// Server
import { createServer, createSocketIOServer } from 'stitchkit/server'

const socket = await createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
  cors: { origin: 'https://app.example.com' },
})

socket.io.on('connection', (s) => { /* rooms — your domain logic; typed handshake auth via `handshake` */ })

createServer({
  services: [service],
  socket,                         // route + websocket + managed shutdown
})
```

```ts
// Client
import { createSocketIOClient } from 'stitchkit'

const socket = createSocketIOClient<ServerToClientEvents, ClientToServerEvents>({
  url: 'https://api.example.com',
})
socket.connect()
socket.on('notification', (data) => console.log(data))  // typed
socket.emit('join', { room: 'r1' })                     // typed
```

### 8. Cache Bridge

Sync Socket.IO events into the TanStack Query cache. Transport-agnostic — it
takes any emitter with `on(event, handler) => unsubscribe` (the
`createSocketIOClient` result qualifies).

```ts
import { createCacheBridge } from 'stitchkit/react'

const bridge = createCacheBridge({
  socket,
  queryClient,
  handlers: {
    notification: (data, ctx) => {
      if (ctx.isFresh(['notes'])) return            // skip echo of own mutation
      ctx.queryClient.setQueryData(['notes'], data)
    },
  },
})
bridge.connect()
// in a mutation: onSuccess: () => bridge.markFresh(['notes'])
```

### 9. SSE Streaming

```ts
import { streamSSE } from 'stitchkit/server'   // server: AsyncGenerator → SSE Response
import { parseSSE } from 'stitchkit'           // client: Response → AsyncGenerator
```

## Features

| Feature | API |
|---------|-----|
| **Contract** | `defineContract()` — single source of truth for your API |
| **HTTP Server** | `createServer()` / `createHandler()` — Bun.serve, validation, hooks, raw routes |
| **MCP Tools** | `createMcpHandler()` / `mountMcp()` — MCP tools from contracts |
| **Agent Tools** | `mountAgent()` — Vercel AI SDK tools from contracts |
| **Agent Runtime** | `createAgentRuntime()` — optional durable history, stream loop, coordination and fencing |
| **Application Kernel** | `createApplication()` — optional process-local resources, readiness, schedules and bounded shutdown |
| **Typed Client** | `createClient()` / `createClients()` — typed fetch from contracts |
| **Cursor Pagination** | `createCursorQuery()` — `react-query-kit` infinite query from a contract method |
| **WebSocket** | `createSocketIOClient()` / `createSocketIOServer()` — typed Socket.IO wrappers |
| **Cache Bridge** | `createCacheBridge()` — socket events → TanStack Query cache |
| **Auth** | `createAuthHook()` / `createBearerResolver()` — scope-aware auth from `contract.scope` |
| **SSE Streaming** | `streamSSE()` / `parseSSE()` — async generator ↔ SSE |
| **Events** | `createEventBus<EventMap>()` — typed in-process pub/sub |
| **Multipart** | typed buffered or streaming single/multi-file uploads with limits and MIME policy |
| **Rate Limiting** | `createRateLimiter()` — token bucket, per-key |
| **Cache** | `createCache()` — in-memory with TTL + `cacheHeaders()` |
| **Errors** | `AppError`, `notFound()`, `badRequest()`, `unauthorized()` |

## How it compares

A modern backend exposes the same operations as an HTTP API, as MCP tools and as
AI-agent tools. Most stacks make you describe each surface separately.

| | **Without stitchkit** | **With stitchkit** |
|--|----------------------|--------------------|
| Define an operation | once per surface — HTTP, MCP, agent (3×) | once — `defineContract()` |
| Keep the surfaces in sync | manual; they drift apart | cannot drift — one source |
| Typed client | hand-written, or a codegen step | inferred from the contract |
| Expose a new surface | re-describe every endpoint | flip `expose` — already typed |

Versus other typed-API tools:

| Capability | stitchkit | tRPC | ts-rest | Hono / Elysia |
|------------|:---:|:---:|:---:|:---:|
| Contract is plain data — no decorators, no codegen | ✅ | ⚠️ router type | ✅ | ❌ |
| Inferred typed client | ✅ | ✅ | ✅ | ⚠️ Eden / hc |
| Plain HTTP REST routes | ✅ | ⚠️ RPC-style | ✅ | ✅ |
| **MCP tools from the same contract** | ✅ | ❌ | ❌ | ❌ |
| **AI-agent tools from the same contract** | ✅ | ❌ | ❌ | ❌ |
| No HTTP-framework dependency | ✅ | ✅ | ✅ | — it is one |

The line no other tool draws: **the same contract becomes MCP tools and AI-agent
tools** — not just an HTTP API and a client. That is what stitchkit is for.

## Lifecycle Hooks

```ts
createServer({
  services: [service],
  hooks: {
    onRequest(req) { },              // logging, rate limiting
    authorize(ctx, endpoint) { },    // auth before request-body reads
    beforeHandle(ctx, endpoint) { }, // validated-input preconditions
    afterHandle(ctx, result) { },    // transform, cache headers
    onError(ctx, error) { },         // error formatting
  },
})
```

## Auth & Scopes

Contracts carry a `scope`; `createAuthHook` enforces it on every transport from
one declarative `rules` map:

```ts
import { createAuthHook, createBearerResolver } from 'stitchkit/server'

const authHook = createAuthHook<User>({
  resolve: (ctx) => resolveSession(ctx),
  rules: {
    public: 'public',
    user: 'authenticated',
    admin: (user) => user.isAdmin,
  },
})

createServer({ services, hooks: { authorize: authHook } })
```

## Dependencies

stitchkit ships with **one runtime dependency**. Everything else is an optional
peer — an install pulls in only what the project actually uses.

| Dependency | Kind | Why this one |
|------------|------|--------------|
| `ky` | bundled, runtime | The HTTP client behind the typed client — ~13 KB, `fetch`-based, with retry, hooks and timeouts built in. The only thing stitchkit installs for you. |
| `zod` | peer, **required** | Schemas are the single source of truth. A peer so your app and stitchkit share **one** `zod` instance — `z.infer` types and `instanceof` checks break across two copies. |
| `@modelcontextprotocol/server` | peer, optional | MCP server surfaces in `stitchkit/tools`; SDK v2, protocol `2026-07-28`. |
| `@modelcontextprotocol/client` | development dependency, optional | Only consumers that run MCP client integration tests or build an MCP host. |
| `@modelcontextprotocol/ext-apps` | peer, optional | Only MCP Apps (`ui://` resources and UI metadata). |
| `ai` | peer, optional | `stitchkit/tools` agent tools and the optional server-only `stitchkit/agent-runtime`. |
| `@openrouter/ai-sdk-provider` | peer, optional | Only `stitchkit/agent-runtime/openrouter`; neutral runtime imports do not resolve it. |
| `grammy` | peer, optional | Only `stitchkit/application/grammy`; the neutral application kernel does not resolve it. |
| `@opentelemetry/api` | peer, optional | Type-only boundary for `stitchkit/application/opentelemetry`; the adapter has no runtime import and owns no SDK/exporter. |
| `@tanstack/react-query` + `react-query-kit` | peer, optional | Only `stitchkit/react` — `createCursorQuery`, `createCacheBridge`. |
| `socket.io` / `@socket.io/bun-engine` / `socket.io-client` | peer, optional | Only the Socket.IO wrappers. |

**Why peers, not bundled.** A peer is resolved once, by your app — framework and
app code share a single instance. Bundled copies would double `zod`, split the
`react` hook runtime and break `instanceof`. Optional peers mean an app that
never touches MCP never installs the MCP SDK. → [ADR 0011](./docs/decisions/0011-bun-only-one-package.md)

The framework stays focused and inspectable: explicit adapters, no generated
application code and no framework build step in your app.

## Official starter

`bun create stitchkit my-app` generates the canonical application: separate
Next.js and Bun API processes, Prisma/PostgreSQL, shared Zod contracts, typed
HTTP/React Query clients, Socket.IO cache updates, OpenAPI, MCP, CLI and a full
UI catalogue. Its only source is
[`packages/create-stitchkit/template`](./packages/create-stitchkit/template).
The application owns its Prisma schema and migrations while PostgreSQL remains
external infrastructure configured through `DATABASE_URL`.
The template owns a committed Bun lockfile and an explicit Stitchkit catalog
range, so framework and scaffolder releases advance independently.

## Documentation — two roads

This README is the quick start. Where you go next depends on what you're doing:

### 📦 Building an app **with** stitchkit

The full guide and API reference, in [`docs/`](./docs/README.md):

- **Guide** — [getting started](./docs/guide/getting-started.md) ·
  [contracts](./docs/guide/contracts.md) ·
  [HTTP server](./docs/guide/server.md) ·
  [typed client](./docs/guide/client.md) ·
  [MCP & agents](./docs/guide/mcp-and-agents.md) ·
  [application kernel](./docs/guide/application-kernel.md) ·
  [realtime](./docs/guide/realtime.md) ·
  [auth & errors](./docs/guide/auth-and-errors.md) ·
  [testing & deployment](./docs/guide/testing-and-deployment.md) ·
  [multi-tenant](./docs/guide/multi-tenant.md) ·
  [upgrading](./docs/guide/upgrading.md)
- **[API reference](./docs/api/reference.md)** — every export, by entrypoint.
- **Coding agent?** The package ships **`llms.txt`** (a curated index) and
  **`llms-full.txt`** (the whole guide inlined) — your agent reads them from
  `node_modules/stitchkit/`. For Claude Code, the repo also provides a
  [stitchkit skill](./skills/stitchkit) you can drop into `.claude/skills/`.

### 🔧 Developing stitchkit itself

- **[AGENTS.md](./AGENTS.md)** — the development guide (setup, rules, hooks,
  local-dev, breaking changes, release flow). One place for human and agent
  contributors; [CONTRIBUTING.md](./CONTRIBUTING.md) points here.
- **[Architecture decisions](./docs/decisions/)** — the *why* behind the design.
- **[Roadmap](./ROADMAP.md)** · **[Changelog](./CHANGELOG.md)** ·
  **[Backlog](./docs/backlog/)** · security via **[SECURITY.md](./SECURITY.md)**.

## License

[MIT](./LICENSE) © Max Listov
