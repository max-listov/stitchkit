# Testing & deployment

## Testing

stitchkit's own test suite runs on `bun:test`. The contract makes most of an
API testable without a live socket.

### Test handlers in process

`createHandler` is the router as a plain `(req) => Promise<Response>` function —
no `Bun.serve`, no port. Drive it with a `Request`:

```ts
import { test, expect } from 'bun:test'
import { createHandler } from 'stitchkit/server'
import { implement } from 'stitchkit/server'
import { notes } from '../shared/contracts'

const handler = createHandler({
  services: [implement(notes, {
    list:   () => [],
    create: (ctx) => ({ id: '1', text: ctx.input.text }),
    get:    (ctx) => ({ id: ctx.params.id, text: 'x' }),
  })],
})

test('create returns the note', async () => {
  const res = await handler(new Request('http://test/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ id: '1', text: 'hi' })
})
```

This exercises the full pipeline — routing, schema parsing, hooks, the error
envelope — with no network.

### Test handlers directly

A handler is a plain function of `ctx`. For pure handler logic, call it with a
context object directly — no HTTP at all. The contract's types keep the test
`ctx` honest.

### Validation and errors

A bad request body comes back as `400 VALIDATION_ERROR`; a thrown `AppError`
comes back with its `code` and `status`. Assert on the envelope:

```ts
const res = await handler(new Request('http://test/notes/missing'))
expect(res.status).toBe(404)
expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Note not found' } })
```

stitchkit's own suite — 143 tests in `packages/core/tests` — is the working
reference for testing each piece.

## Deployment

### Build

A stitchkit app is a Bun program — there is no framework build step. Bundle it
however the project already does (`bun build`, or run the entry file directly).
The `stitchkit` package itself ships pre-built; you consume `dist/`, not `src/`.

### Runtime

The deployment target must have **Bun ≥ 1.2**. stitchkit uses `Bun.serve` and
Bun APIs with no Node/Deno shims — a Node host will not run it.

```ts
createServer({
  services,
  port: Number(process.env.PORT ?? 3000),
  hostname: '0.0.0.0',
})
```

`createServer` returns the `Bun.serve` instance — keep the reference if you need
`.stop()` for a graceful shutdown.

### Production checklist

- **CORS** — set `cors.origin` to your real front-end origin(s). Do not ship
  `origin: '*'` with credentials.
- **Logging** — `logging: true` for built-in request logs, or pass a
  `StitchLogger` to route them into your logging stack.
- **Trace ids** — override `traceId` to reuse an id your platform already
  assigns, so request logs and application logs share one id.
- **Rate limiting** — `createRateLimiter` in `onRequest` for a global limit;
  per-route limits belong in `beforeHandle`.
- **Auth** — a `createAuthHook` `beforeHandle` guards every transport at once;
  do not re-check auth per handler.
- **Errors** — handlers throw `AppError`; let the standard envelope render them.
  Add an `onError` hook only to integrate an error tracker.
- **Secrets** — read them from the environment; never commit them.

### The static front-end

stitchkit serves the API. A SPA front-end is built and hosted separately — a
static host or CDN in production, its own dev server in development. The backend
does not serve static files (`staticRoute` exists for the occasional asset, not
a whole app). See [`packages/starter`](../../packages/starter) for the split.

### MCP

If the app exposes MCP tools, `createMcpHandler` is mounted as a raw route
(`/mcp`). It needs the `@modelcontextprotocol/sdk` peer installed in production —
it is optional only for apps that do not use MCP.
