# Testing & deployment

## Testing

stitchkit's own test suite runs on `bun:test`. The contract makes most of an
API testable without a live socket.

### Test generated clients in process

`createHandlerTestClient` runs the real generated client against the real Fetch
handler without opening a TCP port. It keeps URL construction, headers/cookies,
multipart encoding, cancellation, output validation, `ApiError` and
`x-request-id` correlation in the test path:

```ts
import { createHandlerTestClient } from 'stitchkit/testing'

const api = createHandlerTestClient({
  contract: notes,
  handler,
  pathPrefix: 'api',
  client: { headers: { cookie: 'session=test' } },
})

expect(await api.create({ text: 'hi' })).toEqual({ id: '1', text: 'hi' })
```

`contractConfig` accepts the same scoped `pathPrefix` / `stripPrefixKeys` as
`createClient`. `createHandlerTestClients` is the batch form for a literal
contract registry. Both helpers are Fetch-only: they construct ordinary
absolute `Request` objects and call `createHandler` directly, so Bun and Node
exercise the same framework pipeline.

### Transport conformance

`buildSurfaceManifest` v2 snapshots canonical operations separately from actual
HTTP topology and mounted MCP/Agent/CLI projections. Named MCP surfaces keep
their own advertised input digests (including `extend`, flattening and schema
policy), and named realtime contracts keep directional argument/ack input and
output digests. Compare only discovery you actually observed, then run explicit
drivers for the transports you provide:

```ts
import { bindRealtimeClient } from 'stitchkit'
import {
  assertSurfaceDiscovery,
  buildSurfaceManifest,
  createRealtimeProbeDriver,
  defineRealtimeProbe,
  runSurfaceProbes,
} from 'stitchkit/testing'

const manifest = buildSurfaceManifest({
  groups: [{ pathPrefix: '/api', services: httpServices }],
  mcpPreparation: { extend, schemaValidation, multiRound },
  mcpSurfaces: {
    member: { services: memberServices, runtimeTools },
    admin: { services: adminServices, runtimeTools },
  },
  toolSurfaces: {
    AGENT: { services: agentServices, runtimeTools },
    CLI: { services: cliServices, runtimeTools: cliRuntimeTools },
  },
  realtime: { primary: realtimeContract },
  cliCommands,
})
assertSurfaceDiscovery(manifest, {
  openApi,
  toolSurfaces: [{
    transport: 'MCP',
    surface: 'member',
    names: (await mcpClient.listTools()).tools.map((tool) => tool.name),
  }],
  AGENT: Object.keys(agentTools),
  CLI: cliHelpNames,
  realtime: {
    primary: { serverToClient: observedServerEvents, clientToServer: observedClientEvents },
  },
})

const invalidInbound = defineRealtimeProbe({
  name: 'invalid inbound payload',
  scenario: 'invalid_arguments',
  fixture: invalidPayloadFixture,
  expected: {
    outcome: 'realtime_rejected',
    code: 'REALTIME_CONTRACT_VIOLATION',
    rejection: {
      direction: 'server-inbound', phase: 'arguments',
      reason: 'invalid-arguments', fault: 'peer',
    },
    handlerCalls: 0,
  },
})

const realtimeDriver = createRealtimeProbeDriver({
  bind: (onRejected, fixture) => {
    const client = bindRealtimeClient(realtimeContract, existingTransport, { onRejected })
    const scenario = bindApplicationRealtimeScenario(client, fixture)
    return {
      connected: () => client.connected,
      invoke: scenario.invoke,
      dispose: scenario.dispose, // subscriptions only; never disconnect the transport
    }
  },
  handlerCalls: () => applicationRealtimeHandlerCalls,
})

await runSurfaceProbes({
  probes: [invalidInbound],
  drivers: { REALTIME: realtimeDriver },
})
```

MCP preparation is global because the real MCP mount has one preparation
policy; named surfaces select tools, while `extend.filter` decides which
selected operations receive extra fields. CLI selection is deliberately plain,
and Agent owns its own reachable presentation shaping.

The kit never starts a server, discovers Socket.IO topology remotely, invents
credentials or synthesises invalid Zod values. Fixtures and observations come
from the application. The realtime driver creates a rejection channel per
scenario, observes connection state before invocation, and disposes only
probe-owned subscriptions. Each scenario has one absolute deadline shared by
signalled setup, invocation and teardown. An outer timeout stops waiting; it
does not disconnect a foreign transport or retract an already emitted packet.
A missing driver is unsupported, not silently marked conformant.

### Test handlers with raw Requests

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

This lower-level form exercises the same pipeline while letting a test inspect
the raw `Response` itself.

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

The suite in `packages/core/tests` is the working reference for testing each
piece. Its size changes with the public surface, so the guide does not pin a
count that can drift independently from the test runner.

## Deployment

### Build

A stitchkit app is a Bun program — there is no framework build step. Bundle it
however the project already does (`bun build`, or run the entry file directly).
The `stitchkit` package itself ships pre-built; you consume `dist/`, not `src/`.

### Runtime

The recommended target is **Bun ≥ 1.2** — `createServer` is `Bun.serve`. **Node
≥ 22** is also supported via `stitchkit/node` (see below).

```ts
createServer({
  services,
  port: Number(process.env.PORT ?? 3000),
  hostname: '0.0.0.0',
})
```

### Process signals — `bindProcessSignals`

Keep the managed handle and wire process policy explicitly. The framework
registers no signal listener on its own; `bindProcessSignals` is that explicit
step, and it owns the state machine:

```ts
import { bindProcessSignals } from 'stitchkit/server'

const server = createServer({ services, socket })

bindProcessSignals(server, {
  shutdown: { gracePeriodMs: 30_000, forceTimeoutMs: 5_000 },
  onShutdown: () => stopSchedulers(),        // before the drain starts
  onComplete: async (result) => {            // after it finishes
    await mcp.close()
    await prisma.$disconnect()
    process.exitCode = result.outcome === 'clean' ? 0 : 1
  },
  onError: (error) => {
    console.error(error)
    process.exitCode = 1
  },
})
```

- The first signal runs `onShutdown`, then one `shutdown()`.
- A later signal **forces that same chain** — never a second shutdown. Signals
  delivered in the same turn as the first (a supervisor sending `SIGINT` and
  `SIGTERM` together) are not counted, so the grace period is not collapsed to
  zero.
- The signal after the force — or one arriving while `onComplete` still runs —
  re-delivers the signal so its default disposition applies, letting an operator
  kill a process stuck on some other resource. This works only while nothing else
  in the process listens for that signal; if something does, the signal is
  swallowed and `onEscalationBlocked` fires instead. The framework will not call
  `process.exit` on your behalf.
- `shutdown` budgets are validated when you bind, not when the signal arrives.
  `signal` is not accepted there — the binding owns it, and that is what makes a
  later signal force the first chain.
- `onError(phase, error)` separates the phases. A failing `onShutdown`
  (`'prepare'`) is reported and the shutdown **still runs** — a failed
  preparation must not leave the server listening. A failing `onComplete`
  (`'complete'`) leaves `promise` resolved, because the transport did shut down.
  Only a failing `shutdown()` (`'shutdown'`) rejects it.

`close()` removes the listeners. Closing a binding that never received a signal
resolves `promise` with `undefined`, so an awaiting application does not hang;
closing one whose chain is already running leaves that chain to finish and keeps
the handle claimed, since a second binding could not force it. `promise` is
already observed internally, so ignoring it never raises an `unhandledRejection`.

#### Composite shutdown target — parallel domain drains

`bindProcessSignals` takes `Pick<ManagedServerHandle, 'shutdown'>` — an
**interface**, not the server. An application whose shutdown spans several
domains (transport, bots, agent runs, broadcasts) composes them into one target;
the signal machine stays the framework's, the composition stays yours:

```ts
const composite: ShutdownTarget = {
  async shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
    const { signal } = ShutdownOptionsSchema.parse(options ?? {})
    // Domain drains run in parallel with the transport drain, all watching the
    // same force signal the second OS signal aborts.
    const [transport, bots, agents, broadcasts] = await Promise.all([
      server.shutdown(options),
      drainBots(signal),
      drainAgents(signal),
      drainBroadcasts(signal),
    ])
    return {
      ...transport,
      // Fold domain leftovers into the transport result so `onComplete` sees
      // one honest outcome.
      outcome: transport.outcome === 'clean' && bots + agents + broadcasts === 0
        ? 'clean'
        : 'forced',
    }
  },
}

bindProcessSignals(composite, { shutdown: { gracePeriodMs: 30_000 } })
```

The transport half inside stays the real managed handle — its admission gate and
HTTP drain are not reimplemented, only composed. Domain drains must watch the
`signal` themselves: it is the only channel a second OS signal has into a
running chain.

#### The last line of defence is yours

The framework never calls `process.exit`, and `process.exitCode` only takes
effect once the event loop empties — which is exactly what a stuck resource
prevents. If the deployment must exit before the supervisor's `SIGKILL`, arm an
application-side timer:

```ts
onShutdown: () => {
  setTimeout(() => process.exit(1), 60_000).unref()
},
```

`unref()` keeps the timer from holding a healthy process open; it only fires if
something else already is.

#### When NOT to use `bindProcessSignals`

- The application already runs a signal machine with states this one does not
  have (staged escalation policies, per-signal semantics beyond
  first/force/escalate). Two machines on the same signals is worse than either.
- Signal policy must differ per signal (e.g. `SIGHUP` = reload, not shutdown) —
  bind only the terminating signals here and keep the rest yours.
- Something else in the process must keep listening for the same signal: the
  escalation path restores the default disposition only when nothing else
  listens, and reports `onEscalationBlocked` otherwise.

The server owns HTTP/Socket.IO transport resources. MCP, databases, queues and
domain run-state remain application resources and close explicitly after server
drain. Do not call `runtime.stop()` or `socket.io.close()` in parallel with
`shutdown()`.

### Stdio process signals

An MCP stdio handle has `close()`, not managed HTTP `shutdown()` with a force
signal and deadline. Bind its process lifecycle with the truthful close-only
sibling from `stitchkit/tools`:

```ts
import {
  bindStdioProcessSignals,
  createStdioMcpServer,
} from 'stitchkit/tools'

const stdio = await createStdioMcpServer(config)
const binding = bindStdioProcessSignals(stdio, {
  onClose: () => stopWorkers(),
  onComplete: () => { process.exitCode = 0 },
  onError: (phase, error) => {
    console.error(phase, error) // stderr; stdout stays JSON-RPC-only
    process.exitCode = 1
  },
})

await binding.promise
```

The first signal starts exactly one close chain. A same-turn duplicate is
ignored; a later signal restores the default OS disposition because the
official stdio close is not abortable and Stitchkit will not pretend otherwise.
`binding.close()` removes idle listeners and resolves the promise with
`undefined`. No listener is installed until the binder is called, and the
framework never calls `process.exit()`.

### Deploy on Node

The contract, `implement`, hooks, auth and the client are runtime-agnostic. Only
the listener differs: replace `createServer` with **`serveNode`** (from
`stitchkit/node`, built on `srvx`) — same `HandlerConfig`:

```ts
import { serveNode } from 'stitchkit/node'

const server = await serveNode({
  services,
  socket,
  port: Number(process.env.PORT ?? 3000),
})

await server.shutdown({ gracePeriodMs: 30_000 })
```

Notes for a Node host:

- `stitchkit/node` declarations do not require `@types/bun`. Runtime-neutral
  raw routes use `RawRoute<TServer = unknown>`; supply a host server generic
  only when an embedding adapter passes one to `createHandler`.

- **Socket.IO** attaches to the Node HTTP server via `serveNode({ socket })`, and
  on Node the default transport is `['websocket']` — set the client to match
  (`transports: ['websocket']`). See [realtime](./realtime.md).
- **Bun-only helpers** do not run on Node: `serveFile` (uses `Bun.file`) and the
  raw WebSocket lane. `staticRoute` is runtime-neutral (`node:fs`) and works on
  both, but in production prefer a CDN / the static front-end below.

### Production checklist

- **CORS** — set `cors.origin` to your real front-end origin(s). Do not ship
  `origin: '*'` with credentials.
- **Logging** — `logging: true` for built-in request logs, or
  `logging: { logger, skip, enrich }` to route them into your logging stack,
  drop probe noise and add your own fields.
- **Trace ids** — override `traceId` to reuse an id your platform already
  assigns, so request logs and application logs share one id. Every response
  carries it as `x-request-id`; log `$upstream_http_x_request_id` at the proxy
  to join the two logs.
- **Rate limiting** — `createRateLimiter` in `onRequest` for a global limit;
  per-route limits belong in `beforeHandle`.
- **Auth** — wire one `createAuthHook` as HTTP `hooks.authorize` and tool
  `lifecycle.beforeHandle`; do not re-check auth per handler. HTTP authorization
  runs before JSON or multipart body reads.
- **Errors** — handlers throw `AppError`; let the standard envelope render them.
  Add an `onError` hook only to integrate an error tracker.
- **Secrets** — read them from the environment; never commit them.

### The static front-end

stitchkit serves the API. A SPA front-end is built and hosted separately — a
static host or CDN in production, its own dev server in development. The backend
does not serve static files (`staticRoute` exists for the occasional asset, not
a whole app). `bun create stitchkit my-app` demonstrates the supported split:
an independently built Next.js frontend and Bun/Stitchkit API.

### MCP

If the app exposes MCP tools, mount `createMcpHandler` with
`createMcpHttpRoute({ path: '/mcp', handler })` and close the handler during
graceful shutdown. Production needs the `@modelcontextprotocol/server` v2 peer;
apps without MCP do not. Only an MCP host or integration-test package needs
`@modelcontextprotocol/client`.
