# Getting started

stitchkit turns one contract into an HTTP API, MCP tools, AI-agent tools and a
typed client. This page gets a working app running; the rest of the guide goes
deep on each piece.

## Requirements

- [Bun](https://bun.sh) `>= 1.2` (recommended) or [Node.js](https://nodejs.org)
  `>= 22`. Bun is first-class; Node is supported via `stitchkit/node`.

## Install

```bash
bun add stitchkit zod
```

`zod` is a required peer — schemas are the source of truth everywhere. Other
peers are optional and pulled in only when you use the matching feature
(`@modelcontextprotocol/server` for MCP servers, `ai` for agents, `socket.io*` for
realtime, `@tanstack/react-query` + `react-query-kit` for React). See
[deps](#dependencies) below.

## Entrypoints

Every entrypoint is import-safe for one environment — keeping server-only code
(`Bun.serve`, the MCP SDK) out of browser bundles.

Each also declares how settled it is. **Stable** means the shape changes rarely
and only with a reason worth a migration. **Evolving** means the shape is still
being found and may be redefined in any minor — always with a
`### ⚠️ Breaking changes` entry and a migration section, never silently. Both
are legitimate choices; the difference is how often you should expect to read
the changelog. Moving an entrypoint from evolving to stable is a decision on its
own, recorded as an ADR.

| Import | Use in | Maturity | Holds |
|--------|--------|----------|-------|
| `stitchkit` | browser **and** server | stable | `defineContract`, `createClient`, `createHttpClient`, `createSocketIOClient`, `parseSSE`, the error model |
| `stitchkit/contract` | browser **and** server | stable | the contract layer alone — `defineContract`, errors, pagination |
| `stitchkit/live` | browser **and** server | evolving | `defineEvents` — topic declarations beside the operation contract, projected onto the realtime contract |
| `stitchkit/primitives` | browser **and** server | evolving | generic values and declarations for lifecycle, access, audit, delivery and exports |
| `stitchkit/server` | server (Bun) | stable | `createServer`, `implement`, hooks, auth, Socket.IO server, server primitives |
| `stitchkit/node` | server (Node ≥ 22) | stable | `serveNode` + the runtime-agnostic core — the Node mirror of `/server` |
| `stitchkit/tools` | server | stable | `createMcpHandler`, `mountMcp`, `mountAgent`, the OAuth provider, native tools |
| `stitchkit/tools/contract` | browser + server | evolving | the shapes a tool surface speaks — async-operation contract, snapshot and cancel schemas, view-file input/output — without the runtime that serves them |
| `stitchkit/tools/invoker` | server | stable | peer-free `createToolInvoker` over the canonical contract tool runner |
| `stitchkit/cli` | server | stable | `createCli` — the CLI transport, light (no MCP SDK / `ai`) |
| `stitchkit/remote` | browser **and** server | stable | peer-free `implementRemote` for thin HTTP proxy processes |
| `stitchkit/files` | server (Bun or Node) | stable | peer-free managed local-file boundary |
| `stitchkit/telegram` | server (Bun or Node) | evolving | peer-free Telegram platform primitives — Mini App `initData` verification and Bot API send-failure classification |
| `stitchkit/tracking` | browser **and** server | evolving | visitor-tracking mechanics — `createTrackingClient`, the tab-shared outbox, the page-leave beacon, attribution, the contract factory; no event vocabulary, no React |
| `stitchkit/tracking/server` | server (Bun or Node) | evolving | the decisions a tracking backend makes — dispositions, visit lease over an application-owned store, active intervals, presence; no database |
| `stitchkit/release` | browser **and** server | evolving | a page follows the release it was built for — `createReleaseMarker` on the server, `createReleaseWatcher` in the browser, the `X-Build-Id` header and a socket event between them |
| `stitchkit/geo` | server (Bun or Node) | evolving | managed GeoIP reader generations, last-known-good reload and the optional MaxMind adapter |
| `stitchkit/observability` | server | stable | request/tool event projections — `createObservability`, trace context, sanitisation |
| `stitchkit/testing` | tests on Bun or Node | stable | in-process generated clients over a real Fetch handler, plus the store and managed-resource conformance kits |
| `stitchkit/declaration` | browser + build and deployment tooling (Bun or Node) | evolving | `ProjectDeclarationSchema` — the one machine-readable statement a repository makes about itself |
| `stitchkit/react` | browser + server rendering | stable | `createCursorQuery`, `createCacheBridge`, QueryClient and `ApiError` retry policy |
| `stitchkit/agent-runtime` | server | evolving<br>_redefined in 11 of the 26 minors since 0.56.2, most recently 0.75.0_ | optional durable conversation/run loop, history, models, prompts, fencing and events |
| `stitchkit/agent-runtime/harness` | server | evolving | resource-aware process-local facade over the canonical Agent runtime; supervision stays outside |
| `stitchkit/agent-runtime/coding-tools` | server (Bun or Node) | evolving | bounded host-authorized direct file and shell tools; a root boundary, not an OS sandbox |
| `stitchkit/agent-runtime/openrouter` | server | evolving | isolated OpenRouter language-model adapter |
| `stitchkit/agent-runtime/browser` | browser + server | evolving | canonical agent records, events and reconnect cursor without execution or sinks |
| `stitchkit/agent-runtime/sqlite/bun` | server (Bun) | evolving | durable built-in SQLite store for the agent runtime |
| `stitchkit/agent-runtime/sqlite/node` | server (Node ≥ 22.5) | evolving | durable built-in SQLite store for the agent runtime |
| `stitchkit-tui` | terminal (Bun) | evolving | optional official OpenTUI host over a caller-composed headless runtime |
| `stitchkit/application` | browser + server | evolving<br>_redefined in 6 of the 26 minors since 0.56.2, most recently 0.79.0_ | managed resource graph, readiness, admission, schedules, subtree restart and bounded shutdown |
| `stitchkit/application/grammy` | server | evolving | isolated grammY polling and webhook lifecycle adapters |
| `stitchkit/application/opentelemetry` | server | evolving | maps application snapshots onto an injected OpenTelemetry `Meter` |
| `stitchkit/application/schemas` | browser + server | evolving | the application's snapshot, health and shutdown schemas alone, without the kernel |
| `stitchkit/application/diagnostic-journal` | server | evolving | the local diagnostic journal — the one part of the kernel that spawns, locks and writes files |

Rule of thumb: browser code imports `stitchkit` and `stitchkit/react`; server
code adds `stitchkit/server` (or `stitchkit/node` on Node) and opts into
`stitchkit/tools`, `stitchkit/remote` or `stitchkit/files` by capability.
The full export list of each is in the [API reference](../api/reference.md).

## Project layout

A contract is shared by both sides, so it lives in its own folder:

```
src/
├── shared/contracts.ts   the contract — imported by server and client
├── server/index.ts       implement() + createServer()
└── client/api.ts         createClient()
```

## A first app

### 1. Define the contract

```ts
// src/shared/contracts.ts
import { defineContract } from 'stitchkit'
import { z } from 'zod'

const Note = z.object({ id: z.string(), text: z.string() })

export const notes = defineContract({ prefix: 'notes' }, {
  list:   { method: 'GET',  path: '/',    desc: 'List notes',  output: z.array(Note) },
  create: { method: 'POST', path: '/',    desc: 'Create note', input: z.object({ text: z.string() }), output: Note },
  get:    { method: 'GET',  path: '/:id', desc: 'Get a note',  params: z.object({ id: z.string() }), output: Note },
})
```

### 2. Implement and serve

```ts
// src/server/index.ts
import { implement, createServer } from 'stitchkit/server'
import { notes } from '../shared/contracts'

const service = implement(notes, {
  list:   ()    => db.list(),
  create: (ctx) => db.create(ctx.input.text),   // ctx.input is typed
  get:    (ctx) => db.get(ctx.params.id),       // ctx.params is typed
})

createServer({ services: [service], port: 3000 })
```

### 3. Call it, typed

```ts
// src/client/api.ts
import { createClient, createHttpClient } from 'stitchkit'
import { notes } from '../shared/contracts'

export const api = createClient(notes, createHttpClient({ baseUrl: '/api' }))

await api.list()                   // GET  /notes      → Note[]
await api.create({ text: 'hi' })   // POST /notes      → Note
await api.get({ id: '1' })         // GET  /notes/1    → Note
```

Run the server with `bun run src/server/index.ts`. The contract is the single
source of truth — change it and both the handler and the client are re-typed at
once.

#### On Node

`createServer` is Bun's `Bun.serve`. On **Node ≥ 22**, swap it for `serveNode`
(from `stitchkit/node`, built on `srvx`) — the contract, `implement` and the
client are identical:

```ts
import { serveNode } from 'stitchkit/node'

serveNode({ services: [service], port: 3000 })
```

Add `@types/bun` as a dev dependency on Node (an optional peer — it types the
shared `stitchkit/server` surface). See [deployment](./testing-and-deployment.md#deploy-on-node).

## Dependencies

`ky` is the **only** bundled runtime dependency. Everything else is an *optional
peer* — your app installs only what the features it uses need, and owns the
version (one shared instance, no dual-version skew). This matrix is the install
map — feature → packages:

| Feature you use | Install |
|-----------------|---------|
| anything (validation) | `zod` |
| `createServer` (Bun) | — (uses `Bun.serve`) |
| `serveNode` (Node ≥ 22) | `srvx` (+ `@types/bun` dev) |
| In-process contract tools (`stitchkit/tools/invoker`) | — |
| MCP / agent adapters (`stitchkit/tools`) | `@modelcontextprotocol/server` `ai` |
| Agent application runtime (`stitchkit/agent-runtime`) | `ai` |
| Headless Agent harness (`stitchkit/agent-runtime/harness`) | `ai` |
| Agent coding tools (`stitchkit/agent-runtime/coding-tools`) | — |
| OpenRouter runtime adapter (`stitchkit/agent-runtime/openrouter`) | `ai` `@openrouter/ai-sdk-provider` |
| SQLite agent store (`stitchkit/agent-runtime/sqlite/bun` or `/node`) | — (runtime built-in) |
| MCP host/client tests | `@modelcontextprotocol/client` |
| MCP Apps UI widgets | `@modelcontextprotocol/ext-apps` |
| React data layer (`stitchkit/react`) | `@tanstack/react-query` `react-query-kit` |
| MaxMind GeoIP (`stitchkit/geo`) | `maxmind` |
| **Socket.IO server on Bun** | `socket.io` `@socket.io/bun-engine` |
| **Socket.IO server on Node** | `socket.io` |
| Socket.IO client | `socket.io-client` (runtime peer; unrelated root declarations remain peer-free) |
| grammY lifecycle adapters (`stitchkit/application/grammy`) | `grammy` |
| Telegram platform primitives (`stitchkit/telegram`) | — (peer-free) |
| OpenTelemetry gauges (`stitchkit/application/opentelemetry`) | `@opentelemetry/api` |

```bash
bun add socket.io @socket.io/bun-engine    # e.g. the Socket.IO server on Bun
```

Dynamic optional-peer adapters fail with an actionable error naming the package
and install command. Static entrypoints such as `stitchkit/tools` fail during
ESM resolution by naming the exact missing package; the feature-to-peer matrix
below is the canonical install command.

The combined tools entry owns MCP and AI-agent adapters, so install both runtime
peers before importing `stitchkit/tools`:

```bash
bun add @modelcontextprotocol/server@^2 ai@^7
```

Browser, HTTP-client and React entrypoints remain usable without either MCP
package. MCP hosts and client E2E additionally install
`@modelcontextprotocol/client@^2`; Apps additionally install
`@modelcontextprotocol/ext-apps`.

## Next

- [Contracts](./contracts.md) — every endpoint field, in depth.
- [HTTP server](./server.md) — `createServer`, hooks, raw routes, primitives.
- [Typed client](./client.md) — the client, React data layer, SSE.
- [MCP & agents](./mcp-and-agents.md) — contracts as AI tools.
- [Realtime](./realtime.md) — Socket.IO and the cache bridge.
- [Auth & errors](./auth-and-errors.md) — scopes, auth hooks, the error model.
- [Testing & deployment](./testing-and-deployment.md).
- [API reference](../api/reference.md) — every export, by entrypoint.

For a complete production-shaped app, run `bun create stitchkit my-app`. The
canonical generated topology is maintained in
[`packages/create-stitchkit/template`](../../packages/create-stitchkit/template).

For a terminal Agent host instead, run
`bun create stitchkit my-agent --template agent`, copy `.env.example` to `.env`,
set `OPENROUTER_API_KEY`, then run `bun run dev` and choose a live tool-capable
model with `/model`. The provider catalog owns the exact model id and context window and presents
weekly popularity separately from sourced benchmark observations; `OPENROUTER_MODEL` is only an
optional preferred row. That profile is a thin `stitchkit.agent.ts` composition over the official
`stitchkit-tui` package and canonical headless harness:
durable SQLite history, lazy skills, direct coding tools, approval continuations
and recovery stay framework-owned primitives, while model choice, permissions,
executables and OS isolation remain application policy.
