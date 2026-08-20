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

stitchkit ships eleven entrypoints. Each is import-safe for one environment —
keeping server-only code (`Bun.serve`, the MCP SDK) out of browser bundles.

| Import | Use in | Holds |
|--------|--------|-------|
| `stitchkit` | browser **and** server | `defineContract`, `createClient`, `createHttpClient`, `createSocketIOClient`, `parseSSE`, the error model |
| `stitchkit/contract` | browser **and** server | the contract layer alone — `defineContract`, errors, pagination |
| `stitchkit/server` | server (Bun) | `createServer`, `implement`, hooks, auth, Socket.IO server, server primitives |
| `stitchkit/node` | server (Node ≥ 22) | `serveNode` + the runtime-agnostic core — the Node mirror of `/server` |
| `stitchkit/tools` | server | `createMcpHandler`, `mountMcp`, `mountAgent`, the OAuth provider, native tools |
| `stitchkit/cli` | server | `createCli` — the CLI transport, light (no MCP SDK / `ai`) |
| `stitchkit/remote` | browser **and** server | peer-free `implementRemote` for thin HTTP proxy processes |
| `stitchkit/files` | server (Bun or Node) | peer-free managed local-file boundary |
| `stitchkit/observability` | server | request/tool event projections — `createObservability`, trace context, sanitisation |
| `stitchkit/testing` | tests on Bun or Node | in-process generated clients over a real Fetch handler, without a TCP port |
| `stitchkit/react` | browser | `createCursorQuery`, `createCacheBridge` |

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
| MCP / agent tools (`stitchkit/tools`) | `@modelcontextprotocol/server` `ai` |
| MCP host/client tests | `@modelcontextprotocol/client` |
| MCP Apps UI widgets | `@modelcontextprotocol/ext-apps` |
| React data layer (`stitchkit/react`) | `@tanstack/react-query` `react-query-kit` |
| **Socket.IO server on Bun** | `socket.io` `@socket.io/bun-engine` |
| **Socket.IO server on Node** | `socket.io` |
| Socket.IO client | `socket.io-client` |

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
