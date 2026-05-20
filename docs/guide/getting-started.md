# Getting started

stitchkit turns one contract into an HTTP API, MCP tools, AI-agent tools and a
typed client. This page gets a working app running; the rest of the guide goes
deep on each piece.

## Requirements

- [Bun](https://bun.sh) `>= 1.2`. stitchkit is Bun-only — it builds on
  `Bun.serve`, `bun:test` and Bun APIs. There is no Node or Deno compatibility
  layer.

## Install

```bash
bun add stitchkit zod
```

`zod` is a required peer — schemas are the source of truth everywhere. Other
peers are optional and pulled in only when you use the matching feature
(`@modelcontextprotocol/sdk` for MCP, `ai` for agents, `socket.io*` for
realtime, `@tanstack/react-query` + `react-query-kit` for React). See
[deps](#dependencies) below.

## Entrypoints

stitchkit ships five entrypoints. Each is import-safe for one environment —
keeping server-only code (`Bun.serve`, the MCP SDK) out of browser bundles.

| Import | Use in | Holds |
|--------|--------|-------|
| `stitchkit` | browser **and** server | `defineContract`, `createClient`, `createHttpClient`, `createSocketIOClient`, `parseSSE`, the error model |
| `stitchkit/contract` | browser **and** server | the contract layer alone — `defineContract`, errors, pagination |
| `stitchkit/server` | server | `createServer`, `implement`, hooks, auth, Socket.IO server, server primitives |
| `stitchkit/tools` | server | `createMcpHandler`, `mountMcp`, `mountAgent` |
| `stitchkit/react` | browser | `createCursorQuery`, `createCacheBridge` |

Rule of thumb: browser code imports `stitchkit` and `stitchkit/react`; server
code adds `stitchkit/server` and `stitchkit/tools`.

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

## Dependencies

| Dependency | Kind | Needed for |
|------------|------|------------|
| `ky` | bundled | the HTTP client — the only runtime dependency |
| `zod` | peer | always — validation everywhere |
| `@modelcontextprotocol/sdk` | peer, optional | `stitchkit/tools` MCP |
| `ai` | peer, optional | `stitchkit/tools` agent |
| `@tanstack/react-query` + `react-query-kit` | peer, optional | `stitchkit/react` |
| `socket.io` / `@socket.io/bun-engine` | peer, optional | `createSocketIOServer` |
| `socket.io-client` | peer, optional | `createSocketIOClient` |

Optional peers are provided by your app, so the framework shares one instance of
each with your code.

## Next

- [Contracts](./contracts.md) — every endpoint field, in depth.
- [HTTP server](./server.md) — `createServer`, hooks, raw routes, primitives.
- [Typed client](./client.md) — the client, React data layer, SSE.
- [MCP & agents](./mcp-and-agents.md) — contracts as AI tools.
- [Realtime](./realtime.md) — Socket.IO and the cache bridge.
- [Auth & errors](./auth-and-errors.md) — scopes, auth hooks, the error model.
- [Testing & deployment](./testing-and-deployment.md).
- [API reference](../api/reference.md) — every export, by entrypoint.

A complete runnable app is in [`packages/starter`](../../packages/starter).
