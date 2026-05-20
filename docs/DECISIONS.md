# Architecture Decisions

This document records the **why** behind stitchkit — the decisions that shaped
the framework, including the ones that were tried and reversed.

Each entry is an ADR (Architecture Decision Record): one decision, its context,
the alternatives weighed against it, and the consequences. ADRs are immutable —
when a decision changes, a new ADR supersedes the old one; the old one stays,
marked `Superseded`, so the reasoning is never lost.

These records were consolidated from the project's internal design notes on
2026-05-20; the dates on each ADR are when the decision was effectively made.

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](#adr-0001) | Build on `Bun.serve()`, no HTTP framework | Accepted |
| [0002](#adr-0002) | A generic core — the framework carries no domain model | Accepted |
| [0003](#adr-0003) | Two context types: `RuntimeContext` and `HandlerContext` | Accepted |
| [0004](#adr-0004) | Four lifecycle hooks instead of a middleware chain | Accepted |
| [0005](#adr-0005) | The typed client is inferred from the contract | Accepted |
| [0006](#adr-0006) | Route groups and GET/DELETE query params | Accepted |
| [0007](#adr-0007) | MCP and agent tools from one shared pipeline | Accepted |
| [0008](#adr-0008) | Thin wrappers over the stack you already use | Accepted |
| [0009](#adr-0009) | A hand-rolled WebSocket transport | Superseded by 0008 |
| [0010](#adr-0010) | Grow stitchkit into a fullstack framework | Rejected |
| [0011](#adr-0011) | Bun-only, published as one small package | Accepted |
| [0012](#adr-0012) | A built-in observability module | Accepted |

**Statuses:** _Accepted_ — in effect · _Superseded_ — replaced by a later ADR,
kept for history · _Rejected_ — considered, deliberately not done.

---

<a id="adr-0001"></a>

## ADR 0001 — Build on `Bun.serve()`, no HTTP framework

- **Status:** Accepted
- **Date:** 2025-05

### Context

stitchkit was extracted from several existing projects. Those projects ran on
HTTP frameworks — Hono and Elysia — and used only a thin slice of each: routing,
CORS, cookies, and JWT verification. The rest of every framework's surface went
unused, while the dependency, its release cadence and its idioms were inherited
wholesale.

stitchkit needs an HTTP layer. The question was whether to adopt a framework or
build directly on the runtime.

### Decision

Build directly on `Bun.serve()`. No Hono, no Elysia, no Express.

The features actually used — route matching, CORS, cookies, JWT, request
logging, trace ids — are roughly 100 lines of code on top of raw Bun. stitchkit
ships them itself.

### Alternatives considered

- **Hono.** Mature, portable. But it was used at ~5% of its surface, and
  portability across runtimes is irrelevant to a Bun-only project (see
  ADR 0011). Adopting it means inheriting framework lock-in for no gain.
- **Elysia.** Fast through aggressive JIT. But `Bun.serve()`'s native router is
  implemented in Zig and SIMD-accelerated — faster without the JIT warm-up — and
  Elysia is still a framework dependency.

### Consequences

- Zero HTTP-framework dependency; zero lock-in.
- No off-the-shelf middleware ecosystem — CORS, auth, cookies are written
  in-house (~100 lines total).
- Full control of the request pipeline — the route table, trace ids, startup
  route validation, and a built-in request logger (enabled with `logging:
  true`, or replaced by a custom `StitchLogger`) are all stitchkit's own code.
- The framework is bound to Bun (see ADR 0011) — an accepted trade-off.

---

<a id="adr-0002"></a>

## ADR 0002 — A generic core: the framework carries no domain model

- **Status:** Accepted
- **Date:** 2025-05

### Context

stitchkit was extracted from several unrelated projects — a chat-bot platform, a
media-generation app, and others. An earlier in-house framework had baked one
project's domain model straight into the core:

- `EndpointScope = 'public' | 'client' | 'bot' | 'admin' | 'project'` — five
  hardcoded scopes, each with its own typed context (`botId`, `projectId`, …).
- `requiredFeature?: PlanFeature` on every endpoint — billing in the core.
- a `Source` enum imported from the database (`EMAIL`, `SCHEDULER`,
  `WEBHOOK`, …) used in the handler context.

None of it transferred. A media app has no bots; another project has no
"projects" in that sense. The domain model was dead weight everywhere but its
origin.

### Decision

The framework carries **no domain model**. Every domain-specific concept is
pushed to the application.

- **Scopes are free strings.** `scope?: string` on an endpoint — any value. The
  application defines what its scopes mean and enforces them in a `beforeHandle`
  hook (see ADR 0004, ADR 0008).
- **No billing in the core.** Plan/feature gates are an application concern.
  An app extends `EndpointDef` with its own fields and checks them in a hook.
- **Transport-only source.** `source: TransportSource = 'http' | 'mcp' |
  'agent'` — where the call physically entered. Application-level origins
  (a scheduler, a webhook) are not the framework's concern.
- **Extensible context.** One `HandlerContext` with `[key: string]: unknown` —
  each app adds its own fields (`userId`, `sessionId`, …) through hooks.

### Consequences

- The framework is reusable across unrelated domains without modification.
- Applications wire identity, scopes and billing themselves — more setup, but
  no framework dictates the domain.
- Type safety for app-specific context is preserved by ADR 0003 and the
  `createImplement<Ctx>()` factory: the app declares its context type once.

---

<a id="adr-0003"></a>

## ADR 0003 — Two context types: `RuntimeContext` and `HandlerContext`

- **Status:** Accepted
- **Date:** 2025-05

### Context

A handler wants a typed context — `ctx.params` and `ctx.input` shaped by the
endpoint's schemas — for a good developer experience. But the transport layer
assembles the context *before* those types are known: right after a Zod parse,
`params` and `input` are `unknown`.

An earlier framework used a single `HandlerContext<TParams, TInput>` everywhere,
including in the transport, and bridged the gap with `as` casts — one in the
transport, another in the handler-binding step.

### Decision

Split the context into two interfaces.

- **`RuntimeContext`** — `{ params: unknown, input: unknown, … }`. Used by the
  transport and by lifecycle hooks. No generics, no casts.
- **`HandlerContext<P, I>`** — `{ params: P, input: I, … }`. Used only inside
  handlers, where the types are known.

`implement()` is the bridge. It accepts typed `Handlers<C>` and wraps each one
as a `MethodDef.handler(ctx: RuntimeContext)`. Runtime safety comes from the
Zod parse that runs before the handler; type safety comes from generics that
infer `P` and `I` from the endpoint schemas.

### Consequences

- Zero `as` casts on the framework's request path.
- The transport works with loose `unknown` types and never lies about them.
- Handlers see a fully typed context; the cast that used to bridge the two
  worlds no longer exists — it was replaced by an honest type boundary.

---

<a id="adr-0004"></a>

## ADR 0004 — Four lifecycle hooks instead of a middleware chain

- **Status:** Accepted
- **Date:** 2025-05

### Context

An earlier framework used Hono's per-path `.use()` middleware: a registration
step mounted middleware by scope, and request behaviour was assembled from a
chain of middleware functions. That chain is a framework-specific construct —
adopting it means adopting the framework (see ADR 0001).

stitchkit still needs the cross-cutting behaviour middleware usually provides:
logging, auth, response shaping, error formatting.

### Decision

Four lifecycle hooks, plain functions, no chain:

- **`onRequest(req)`** — runs first; logging, rate limiting. May short-circuit
  with a `Response`.
- **`beforeHandle(ctx, endpoint)`** — auth, scope checks. Runs after the context
  is built, before the handler.
- **`afterHandle(ctx, result, endpoint)`** — response transform, cache headers,
  audit logging. May replace the result.
- **`onError(ctx, error, endpoint)`** — error formatting, alerting.

Route groups (ADR 0006) may carry their own hooks. Execution order is
global hook → group hook → handler.

### Consequences

- Hooks are ordinary functions with zero framework dependency — the opposite of
  middleware lock-in.
- The four hooks cover every cross-cutting concern the source projects needed.
- There is no composable middleware *pipeline* — hooks are flat, not chained.
  Behaviour that a middleware stack would compose is instead expressed as plain
  code inside a hook. For stitchkit's scope this is simpler, not weaker.

---

<a id="adr-0005"></a>

## ADR 0005 — The typed client is inferred from the contract

- **Status:** Accepted
- **Date:** 2025-05 (core), 2026-05 (pilot fixes)

### Context

One source project hand-wrote its frontend client — a fetch wrapper plus
per-endpoint hooks in separate files. The contract was not used for client-side
inference, so the client could silently drift from the server.

Another prototype showed the alternative: a `TypedClient<C>` type that derives
the entire client API from the contract, with one typed function per endpoint.

### Decision

The typed client lives in the core. `createClient` / `createClients` build a
fully typed client from a contract with no hand-written per-endpoint code;
`createHttpClient` is the Ky-based transport adapter underneath (cookie auth,
SSR cookie forwarding, error parsing, transport retry).

Putting this through a real frontend (the pilot migration) exposed three subtle
defects, all now fixed:

- **Arguments are typed with `z.input`, not `z.output`.** The client *sends*
  pre-parse input; the server parses it to output. A field with `.default()`,
  `.coerce()` or `.transform()` differs between the two. Using the output type
  made server-defaulted fields *required* on the caller. `EndpointArgs` uses
  `z.input`; the handler's `ctx.input` keeps the output type.
- **The empty case is `{}`, never `Record<string, never>`.** The latter carries
  an index signature that poisons every intersected field to `never`, collapsing
  the whole argument type. `{} & X = X`. (`{}` was later written as `unknown`,
  which has the same intersection identity and is lint-clean.)
- **`defineContract<const T>`** preserves string literals (`multipart`,
  `method`, `path`). Without `const`, `multipart: 'file'` widened to `string`
  and the multipart argument type degraded to an index signature.

A per-endpoint `timeout` was also added: a slow synchronous endpoint (AI
generation) declares its own client timeout once, in the contract.

### Consequences

- Any contract yields a fully typed client; the transports cannot drift from it.
- Server-defaulted input fields are optional for the caller, as they should be.
- The client never needs an `as` cast to satisfy a contract method signature.

---

<a id="adr-0006"></a>

## ADR 0006 — Route groups and GET/DELETE query params

- **Status:** Accepted
- **Date:** 2026-05-13

### Context

Two gaps surfaced when preparing real projects to run on stitchkit:

1. `buildContext()` ignored `inputSchema` for GET and DELETE — every `list`
   endpoint with filters (`?status=active&limit=20`) was broken.
2. Some projects mount services under a path prefix
   (`/bots/:botId/...`, `/api/{prefix}/...`). stitchkit only built flat paths.

### Decision

**Query params on GET and DELETE.** GET and DELETE parse `inputSchema` from the
URL query. `searchParams.getAll()` supports repeated keys as arrays
(`?tag=a&tag=b`). DELETE sniffs the content-type: a JSON body when
`application/json`, the query otherwise. Coercion is the schema author's
responsibility — query params are always strings; a schema that wants a number
uses `z.coerce.number()`. The framework adds no automatic coercion (rejected:
auto-coerce primitives — magic; a `withQueryCoercion` helper — redundant with
`z.coerce.*`).

**Route groups.** `ServerConfig` accepts `groups: RouteGroup[]` alongside flat
`services`. A `RouteGroup` has a `pathPrefix`, its `services`, and optional
per-group `hooks`. `:param` segments from the prefix (`:botId`) are matched and
placed into the context. (Rejected: a `scopePaths` map keyed by the scope string
— ties URL structure to the scope vocabulary; a mutable `ServiceDef.pathPrefix`
— mutating the service after `implement()` is dirty.) Flat `services` remain
valid, so the simple case stays simple.

### Consequences

- List endpoints work with query filters; arrays are supported.
- Grouping is explicit and decoupled from the scope vocabulary; per-group hooks
  enrich the context (e.g. resolve `:botId`) before the handler runs.
- Coercion stays in the contract — no framework magic to reason around.

---

<a id="adr-0007"></a>

## ADR 0007 — MCP and agent tools from one shared pipeline

- **Status:** Accepted
- **Date:** 2026-05-13 (pipeline, extend), 2026-05-20 (`createMcpHandler`)

### Context

The same contract endpoint must be exposed as an [MCP](https://modelcontextprotocol.io)
tool (for assistants) and as an AI-SDK tool (for agents). Two concerns appeared:

- The MCP path and the agent path each had their own validate → call → format
  logic — duplicated, free to drift.
- Multi-tenant tools need an extra schema field the model must supply (for
  example a tenant id), which the contract itself does not carry.
- Every project re-implemented the MCP server lifecycle by hand — an SSE event
  store, a session map, the Streamable-HTTP transport.

### Decision

- **One execution pipeline.** `executeToolMethod()` does validate params + input
  → run handler → `normalizeError` → `ToolResult`. The MCP mount and the agent
  mount are ~20 lines each on top of it. `ToolCallHooks` (`beforeToolCall` /
  `afterToolCall`) give observability, fired even on validation failure.
- **One extension object.** `ToolExtend { schema, resolve, filter }` — the same
  shape for MCP and agent. `schema` adds fields the model sees, `resolve` turns
  those args into context before the handler, and the extra keys are stripped
  from the args that get validated. (Rejected: a per-tool `wrapTool` callback as
  the primary API — all boilerplate, kept only as an escape hatch; a separate
  group-config object — a second, divergent API shape.)
- **`createMcpHandler()`** owns the entire MCP Streamable-HTTP lifecycle — an
  SSE event store for stream resumability, per-session transports, the
  `McpServer` instances. The consuming app never imports
  `@modelcontextprotocol/sdk`; it declares only how to authenticate and which
  contract services to expose.

### Consequences

- Every MCP and agent tool comes from a contract — there are no hand-built
  native tools to keep in sync.
- The MCP path and the agent path share one validated, observable pipeline.
- An `AppError` may carry a `hint`; the pipeline forwards it into the tool
  result, so a model receives a recovery suggestion next to the error code.
- A consuming app's MCP server shrinks to a small block of configuration.

---

<a id="adr-0008"></a>

## ADR 0008 — Thin wrappers over the stack you already use

- **Status:** Accepted
- **Date:** 2026-05-20

### Context

stitchkit began by trying to own everything. It shipped its own WebSocket
transport (ADR 0009) and its own React data layer — `createReactClient`, a hook
factory built on TanStack Query.

An audit of every project consuming stitchkit told a different story. They all
run on **Socket.IO**. They all use **`react-query-kit`** for the hook layer.
The home-grown stacks were never adopted anywhere — they were dead code, and
each project still hand-wrote the same ~150-line Socket.IO client.

### Decision

stitchkit owns the **contract and the transport**. For everything the consuming
projects already standardise on, it ships a **thin wrapper**, not a competitor.

- **WebSocket is Socket.IO.** `createSocketIOClient` / `createSocketIOServer` —
  typed wrappers with durable subscriptions and a ready-made `/socket.io/*`
  route. The hand-rolled WebSocket stack was deleted (ADR 0009).
- **The React data layer is `react-query-kit`.** `createCursorQuery` is a
  cursor infinite-query helper built on it. The home-grown `createReactClient`
  was deleted.
- **`createCacheBridge`** syncs socket events into the TanStack Query cache. It
  is transport-agnostic — any emitter with `on(event, handler) => unsubscribe`
  qualifies. `markFresh()` plus a short `freshWindow` let a handler skip a
  socket echo of a change the client just made — no double update from the
  mutation and the event together.
- **`createAuthHook` / `createBearerResolver`** — scope-aware auth derived from
  `contract.scope`. This absorbed an earlier `createSessionHook`.
- **`createEventBus<EventMap>()`** — a typed in-process pub/sub, replacing the
  per-project `class EventBus` each project carried.
- **Cursor pagination is the canon.** Every list endpoint returns
  `{ items, nextCursor }`. Cursor beats offset for infinite scroll — it is
  immune to concurrent inserts, where offset drops or duplicates rows. Page
  size is the server's call (the contract's `limit` default), never the
  client's, so the two cannot diverge.

### Consequences

- Less framework code, no competing engines to maintain.
- The wrappers remove roughly 600 lines of duplicated socket-client code across
  the consuming projects.
- Socket.IO, `react-query-kit` and TanStack Query are **optional peer
  dependencies** (ADR 0011) — installed only by apps that use those wrappers.
- This is stitchkit's identity: a contract layer and a transport, plus thin
  wrappers over what the ecosystem already chose — not a framework with its own
  version of everything.

---

<a id="adr-0009"></a>

## ADR 0009 — A hand-rolled WebSocket transport

- **Status:** Superseded by [0008](#adr-0008)
- **Date:** 2025-05 (decided), 2026-05-20 (reverted)

### Context

stitchkit originally planned to own its real-time layer: a WebSocket transport
built directly on `Bun.serve()`'s native WebSocket, with no Socket.IO.

The rationale at the time:

- Zero dependencies — consistent with ADR 0001.
- Bun's native WebSocket (uWebSockets underneath) is faster than Socket.IO.
- Socket.IO's main job is a polling fallback, assumed unnecessary in 2026.
- Rooms are about 30 lines to implement.

### Decision (original)

Build a native WebSocket stack: `defineEvents` for a typed event registry,
`createWebSocketHandlers` for the server, `createSocketClient` for the client,
an entity emitter, a `useSocketEvent` React hook, and cookie-based handshake
auth via an `onAuth` callback.

### Why it was reverted

Every project consuming stitchkit already runs on Socket.IO — for the polling
fallback, the heartbeat, acknowledgements and a mature reconnection client that
a hand-rolled transport would have to re-earn. The native stack was never wired
into a single consumer. It was about 700 lines of dead code.

ADR 0008 replaced it with thin Socket.IO wrappers (`createSocketIOClient` /
`createSocketIOServer`). The entire native stack was deleted.

### Consequences

- A real transport was built, shipped, and never adopted — a cost paid in full.
- The lesson, recorded in ADR 0008: do not build a transport the consumers will
  not use. Wrap the one they already run on.

---

<a id="adr-0010"></a>

## ADR 0010 — Grow stitchkit into a fullstack framework

- **Status:** Rejected
- **Date:** 2026-05-13 (explored), 2026-05-20 (rejected)

### Context

There was a push to grow stitchkit from a contract-and-transport library into a
full fullstack framework — SSR, HMR, a dev-server integration, file-based
routing, server functions, type-safe links — "to the level of TanStack Start or
Next.js".

### What was explored

- A **Vite dev-server integration**: `createHandler()` was split out of
  `createServer()` so Vite middleware could call the request handler directly;
  a `stitchkit/vite` plugin routed API requests and SSR through it.
- An **SSR path**, an **HMR client**, and a render error boundary.
- Two earlier dev-server attempts were tried and abandoned first: a
  Bun-HTML-import server (single 2+ MB bundle, slow browser parse, broken code
  splitting) and a `bun build --watch` dual-process (live reload only, no true
  HMR, dev code leaking into request hooks).

### Decision

**Rejected for the core.** The projects consuming stitchkit are Next.js apps or
Vite single-page apps. They already own a frontend toolchain; a fullstack layer
inside stitchkit is redundant for every actual consumer.

The Layer-1 fullstack code — the Vite plugin, the SSR module, the HMR client,
the prebundle plugin — was deleted.

### What survived

- The **Ky-based HTTP client** (`createHttpClient`) — genuinely useful on its
  own, independent of any fullstack ambition. Kept; it backs the typed client
  in ADR 0005.
- The bundled `starter` example uses plain Vite as its own toolchain — it does
  not depend on a stitchkit fullstack layer.

### Consequences

- stitchkit stays a contract layer plus a transport (ADR 0008) — focused, small.
- If the fullstack ambition is ever revived, it belongs in a separate
  `stitchkit-fullstack` package, never in the core.

---

<a id="adr-0011"></a>

## ADR 0011 — Bun-only, published as one small package

- **Status:** Accepted
- **Date:** 2026-05-20

### Context

stitchkit ships to npm as an open-source package. That raised three questions:
which runtimes to support, how to package the code, and how to keep quality
green across contributors.

### Decision

**Bun-only.** stitchkit targets Bun and only Bun. It uses `Bun.serve()`,
`bun:test` and other Bun APIs directly; there is no Node or Deno compatibility
shim. `package.json` declares `engines.bun >= 1.2`. A compatibility layer would
dilute every decision in this document — ADR 0001 exists *because* the target is
a single fast runtime.

**One package, subpath exports.** Published as a single package, `stitchkit`,
with subpath exports — `/server`, `/tools`, `/react`, `/contract` — and a
browser-safe root entry. `ky` is the only runtime dependency. Everything else is
a **peer dependency**: `zod` (required), and `@modelcontextprotocol/sdk`, `ai`,
`socket.io`, `socket.io-client`, `@socket.io/bun-engine`,
`@tanstack/react-query`, `react-query-kit`, `react` (all optional). Peers
guarantee the consuming app shares one instance of each.

**Built output.** Consumers receive built `dist/` — `bun build` for JavaScript,
`tsc` for declarations — not raw `src/`. The TypeScript config is split:
`tsconfig.json` typechecks `src` and `tests`, and `tsconfig.build.json` emits
declarations from `src` only.

**Quality gate.** Biome handles lint and format. A CI workflow runs lint,
typecheck, tests and build. Two git hooks enforce the same locally: `pre-commit`
auto-formats staged files and blocks the commit on any warning; `pre-push` runs
the full `verify` suite. Dirty code cannot reach the remote.

### Consequences

- Small, dependency-light, Bun-native.
- Not usable on Node or Deno — a deliberate, accepted limitation.
- One published package keeps installation and versioning simple; subpath
  exports keep browser bundles free of server code.

---

<a id="adr-0012"></a>

## ADR 0012 — A built-in observability module

- **Status:** Accepted
- **Date:** 2026-05-20

### Context

stitchkit shipped only the low-level hooks — `LifecycleHooks` and
`ToolCallHooks` (ADR 0004, ADR 0007). Every consuming project then re-built the
*same* audit layer on top of them: a request-context, a trace id, a payload
sanitiser, a transport-source tag, an HTTP audit wrapper, a sink. Across three
sibling projects this layer was duplicated, divergent, or missing entirely —
the framework had ended the duplicated transport layer but not the duplicated
observability layer above it.

The hooks are the right primitive. The question was whether the audit layer
*above* them belongs in the framework too — and if so, how much of it.

### Decision

**Ship an observability module — `stitchkit/observability`, a new entrypoint.**
It owns the reusable audit machinery; a consuming project supplies only an audit
table and a `write(event)` function.

The module owns four things:

1. **W3C Trace Context** — `traceparent` parsing, formatting and span chaining.
   A trace spans the front-end call, the HTTP handler and every tool call
   beneath it.
2. **A request context** over `AsyncLocalStorage` — trace ids, transport
   source, identity and timing, reachable without threading a parameter.
3. **`RequestEvent`** — one normalised audit shape produced by both surfaces, so
   a single audit table stays queryable across HTTP, MCP and agent calls.
4. **`createAuditHook`** — wires both surfaces into one sink, plus the
   sanitisation that makes a payload safe to store.

**The HTTP audit is a fetch-handler wrapper, not a lifecycle hook.**
`LifecycleHooks` has a single `onError` (ADR 0004) — an audit built on it would
compete with the application's own error handler for that one slot. The wrapper
sees the final `Response` instead — success and error alike, one uniform place,
no contention. The tool-call audit *is* a hook (`afterToolCall`), which has no
such conflict.

**The module owns the machinery, not the policy.** It does not own the audit
table (a project's database model), the logger backend (`pino` vs console — the
`StitchLogger` interface stays the only contract), project-domain transport
sources, or any live-stream / admin-UI concern. Those stay with the project.
The split is the same as ADR 0002: a generic core, no domain model.

A separate entrypoint — not folded into `stitchkit/server` — keeps the audit
machinery tree-shakeable and the concern distinct: a project that does not audit
never imports it.

### Consequences

- A consuming project's request logging collapses to a table plus a `write`
  function; trace ids, the context, sanitisation and wiring come from the
  framework.
- One normalised `RequestEvent` means one queryable audit store across every
  surface, instead of three disconnected logs.
- The raw hooks remain fully available for anything that is not a full audit
  row — a one-off metric, a custom log line.
- The module depends on `node:async_hooks`. Bun implements it; consistent with
  ADR 0011.
