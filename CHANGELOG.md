# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

## [Unreleased]

## [0.3.0] — 2026-05-20

### Security hardening

A multi-agent audit of the framework surfaced and closed a set of holes.

- **Prototype-pollution defence at every input boundary.** A `__proto__` key in
  a JSON body, query string, cookie, multipart field, tool argument, path param
  or JWT claim is stripped before it can rewire a prototype chain. New
  `safeJsonParse` helper.
- **Real client IP, unspoofable by default.** `ctx.ipAddress` (and a raw
  route's `ctx.ipAddress`) is the actual socket peer — resolved by the adapter
  (`Bun.serve` / `srvx`), not a header. `HandlerConfig.trustProxy` (default
  `false`) switches it to the `x-forwarded-for` client for deployments behind a
  trusted proxy. A spoofed forwarded header is ignored unless `trustProxy` is
  set.
- **SSRF — `view_file` no longer follows redirects past the guard.** A public
  URL could `302` to an internal address; the guard now re-validates every
  redirect hop. A non-canonical numeric host (`http://2130706433/`) is rejected.
- **CORS — `credentials: true` with a wildcard origin is rejected** at
  construction. A rejected origin no longer receives `Allow-Credentials`.
  Origin matching is case-insensitive.
- **Internal error messages no longer leak.** An unexpected (non-`AppError`)
  error returns a generic `Internal server error`; the real cause is logged
  server-side. Applies to the HTTP response and the SSE error event.
- **Multipart uploads are capped before buffering.** The body is stream-read
  with a hard byte limit, so an upload with a missing / spoofed
  `Content-Length` can no longer exhaust memory.
- **JWT verification hardened** — an empty secret is rejected, `exp` / `nbf`
  honour a configurable clock-skew leeway (default 60 s), a non-numeric `exp`
  is malformed (not "non-expiring"), optional `issuer` / `audience` checks, an
  oversized token is rejected, and a non-base64url segment is rejected.
- **`createAuthHook` fails closed** — a scope with no matching rule now throws
  instead of silently passing the request. Identity resolution branches on the
  authoritative `ctx.source`, not the presence of `ctx.req`.
- **MCP session and event stores are bounded** — hard caps with LRU eviction
  on top of the TTL sweep, closing a memory-exhaustion vector.
- **`createHandler` is fully Web-Fetch-clean** — request timing uses
  `performance.now()`, not `process.hrtime`.
- A non-empty request body must declare `Content-Type: application/json` — a
  `text/plain` body (a forgeable cross-origin form post) is rejected.
- `staticRoute` uses `node:fs` (runs on Node, not just Bun), sets
  `X-Content-Type-Options: nosniff` and a content type, and rejects
  percent-encoded path traversal.
- The JSON-coercion of tool arguments is now an argument transform, not a
  schema wrapper — the advertised tool schema keeps its correct `required`
  fields. `withJsonCoercion` is replaced by `coerceJsonArgs`.
- Smaller fixes: rate-limiter LRU key-space cap, `afterToolCall` fires even when
  `beforeToolCall` throws, the response `x-request-id` is always the
  framework-resolved id, `createEventBus` takes an `onListenerError` hook,
  `traceparent` rejects the all-zero id, `buildToolManifest` tolerates an
  incompatible schema, `redact` no longer mislabels a shared subtree as
  circular.

### Tool ≡ HTTP parity — follow-up fixes

A post-0.2.0 audit found gaps in the contract-parity guarantee between the HTTP
and tool surfaces.

- **`createAuthHook` no longer silently skips tool calls.** It previously
  early-returned when there was no `ctx.req`, so a `createAuthHook` passed as a
  tool mount's `lifecycle.beforeHandle` enforced **nothing** — a scoped tool was
  callable by anyone. The hook now resolves identity per surface: `resolve`
  (HTTP, from `ctx.req`) or the new `resolveFromContext` (tool calls). A scoped
  tool call with no `resolveFromContext` **fails closed**.
- **HTTP output-validation mismatch is now `INTERNAL_SERVER_ERROR`.** A handler
  returning a value the contract `output` rejects is a server fault — it was
  reported as a client `VALIDATION_ERROR` (400). Now `500`, matching the tool
  transport.
- **ADR 0014** — the tool surface carries the same contract guarantees as HTTP.
  Records the invariant the parity fixes established; lists the intentional
  differences (error envelope, multipart endpoints are HTTP-only).
- New `tests/parity.test.ts` runs one contract's args through both surfaces and
  asserts identical accept / reject.

## [0.2.0] — 2026-05-20

### Tools — LLM robustness and mount extensions

New mount-time options for real-world LLM tool usage.

- **JSON coercion for tool arguments.** `coerceJsonArgs` (default `true`) on
  `mountAgent` / `mountMcp` / `createMcpHandler` — LLMs that double-serialize
  arrays/objects (sending `"[1,2]"` instead of `[1,2]`) no longer hit validation
  errors. New public `withJsonCoercion()` helper.
- **Discriminated union flatten for MCP.** `flattenUnionInput` on mount configs
  flattens a `z.discriminatedUnion` into a single `z.object` with an enum
  discriminator — MCP tools with variant inputs (patch operations) register
  instead of being rejected. New public `flattenDiscriminatedUnion()` helper.
- **Global error hints.** `errorHint` callback on mount configs — inject a
  recovery hint into every failed tool result (e.g. "try a different approach").
  Combined with per-error `AppError.hint` when both are present.
- **Tool manifest for deferred tools.** `buildToolManifest(tools)` produces a
  searchable `{ name, description, inputSchema }[]` from `collectTools()` — the
  primitive for building a `tool_search` native tool. `collectTools` and
  `MountableTool` are now public exports.

### Runtime-agnostic core

The core is now Web Fetch-clean — `createHandler` has no Bun globals. Node ≥ 22
is a supported runtime.

- **`stitchkit/node` subpath.** `serveNode(config)` runs the same `createHandler`
  on Node via [`srvx`](https://srvx.h3.dev). One contract, one `implement()`,
  one set of handlers — different import for the server bootstrap.
- **Type split.** `ServerConfig` is replaced by `HandlerConfig` (runtime-neutral,
  used by `createHandler`) and `BunServerConfig` (extends `HandlerConfig` with
  Bun-specific fields, used by `createServer`).
- **`new URL` fallback.** `createHandler` passes a base to `new URL(req.url)` so
  Node adapters that supply only a pathname no longer throw.
- **New exports from `stitchkit/node`:** `serveNode`, `NodeServerConfig`,
  `NodeServerHandle`, `createHandler`, `HandlerConfig`.
- **New exports from `stitchkit/server`:** `HandlerConfig`, `BunServerConfig`.
- `engines` in `package.json` now declares `node: ">=22"` alongside
  `bun: ">=1.2.0"`. `srvx` is an optional peer dependency.
- CI runs a Node 22 smoke test against the built `dist/`.

### ADR split

- Architecture decisions moved from a single `docs/DECISIONS.md` into individual
  files under `docs/decisions/` (one per ADR). New: ADR 0013 (runtime-agnostic
  core).

### Tools — tool-surface integrity

A pass over the MCP / agent layer to close the cases where a tool surface
silently diverged from the HTTP contract.

- **MCP tools fail loud on an incompatible schema.** A tool whose schema cannot
  be represented as JSON Schema (a `z.date()`, a `z.map()`, …) no longer
  vanishes from the surface with a `console.error`. `mountMcp` /
  `buildMcpServer` / `createMcpHandler` take `onIncompatibleSchema:
  'throw' | 'skip' | 'warn'` (default `'throw'`), and `createMcpHandler`
  validates a static `services` array at construction — a failed deploy, not a
  lost tool. New `validateMcpSchemas()` runs the same check on its own.
- **One Zod → JSON Schema conversion point** (`tools/json-schema.ts`) — the
  build-time validity probe now uses the same converter direction (`io`) the
  transport SDKs emit with, so it tests what is actually shipped.
- **Tool arguments are validated by the schema the tool advertises.** The
  advertised schema is no longer coerced or discriminated-union-flattened away
  from the schema used to validate a call — `withJsonCoercion` and the lossy
  union flatten are gone. An agent tool advertises a union / discriminated
  union natively; an MCP tool needs an object input (the MCP surface cannot
  advertise a top-level union), so a non-object input is reported through
  `onIncompatibleSchema` rather than shipped as an empty schema.
- **Tool calls parse params and input over disjoint argument slices**, like the
  HTTP transport — a `.strict()` contract schema now works as a tool.
- **Tool calls run a `beforeHandle` / `afterHandle` lifecycle.** `mountMcp`,
  `mountAgent`, `buildMcpServer` and `createMcpHandler` take a `lifecycle` —
  pass the same `createAuthHook` result used for the HTTP `beforeHandle` and
  tool calls are scope-guarded identically (previously a tool call bypassed it).
- **A tool's handler output is validated against the contract** (an
  `INTERNAL_SERVER_ERROR` on mismatch), as on HTTP.
- **A non-object `output` still yields `structuredContent`** — it is wrapped in
  `{ result: … }` for the MCP structured payload.
- **Cross-service tool-name collisions throw** in `mountMcp` / `mountAgent`.
- `mountAgent` now also accepts `ServiceDef | ServiceDef[]` (`mountMcp` already did).
- `defineContract` rejects an empty `desc` and a `toolName` on an endpoint not
  exposed on any tool transport.
- New exports from `stitchkit/tools`: `validateMcpSchemas`,
  `IncompatibleSchemaPolicy`, `ToolLifecycle`, `ToolCallHooks`, `ToolResult`.

## [0.1.0] — 2026-05-20

First public release.

### Contract

- `defineContract(meta, endpoints)` — one declaration describing an API: method,
  path, Zod `input` / `output` / `params`, `scope`, `expose` transports,
  `multipart`, per-endpoint `timeout`.
- `AppError` + `notFound` / `badRequest` / `unauthorized` / `forbidden` /
  `conflict` / `rateLimited` / `appError` — a single error model. `ErrorEnvelope`
  is the one error-response shape, shared by the server and the typed client.
- `paginatedSchema()` / `Paginated<T>` — the cursor-pagination envelope.

### HTTP server

- `createServer()` / `createHandler()` — HTTP on `Bun.serve()`, no HTTP
  framework dependency. Route groups, lifecycle hooks, raw routes, CORS,
  request logging, trace ids.
- `implement()` / `createImplement<Ctx>()` — type-safe handler binding.
- `createAuthHook()` / `createBearerResolver()` — scope-aware auth derived
  from `contract.scope`.
- `streamSSE()` / `parseSSE()`, `parseMultipart()`, `createRateLimiter()`,
  `createCache()`, `createEventBus<EventMap>()`.

### MCP & AI agents

- `createMcpHandler()` — a full MCP Streamable-HTTP server from contracts; the
  consuming app never imports `@modelcontextprotocol/sdk`.
- `createStdioMcpServer()` — serve contract tools over the **stdio** transport,
  as a subprocess of the MCP client. `buildMcpServer()` is the transport-neutral
  core shared by both MCP transports.
- `mountMcp()` mounts contract tools onto an existing server; `mountAgent()`
  produces Vercel AI SDK tools. `ToolExtend` adds host-supplied arguments.
- `implementRemote(contract, http)` — bind a contract to a remote HTTP API, for
  building a thin local MCP / agent server. Optional `transformArgs` hook.
- `instructions` on the MCP server config — a host-facing usage hint, surfaced
  to MCP tool-search.
- MCP tools register an `outputSchema` (from the contract `output`) and return
  `structuredContent` — the structured payload consumed by MCP App UIs.

### Observability

- `stitchkit/observability` — the audit layer above the raw hooks. A project's
  request logging becomes a table plus a `write` function.
- `createAuditHook({ write, filter?, sanitize? })` — wires the HTTP fetch
  handler and the `afterToolCall` hook into one sink, normalising every
  completed call into a `RequestEvent`.
- `wrapInRequestContext` + `getRequestContext` / `getTraceId` / `setRequestUser`
  / `setRequestError` — a per-request `AsyncLocalStorage` context.
- W3C Trace Context — `resolveTraceContext` / `parseTraceparent` /
  `formatTraceparent` / `childSpan`.
- `sanitizePayload` / `redact` / `truncatePreview` / `measureSize` — mask
  secret-named keys, drop binary blobs, cap payload size.

### Client & React

- `createClient()` / `createClients()` / `createHttpClient()` — a typed fetch
  client built from contracts (Ky-based, SSR cookies, error parsing).
- `createCursorQuery()` — the canonical cursor-paginated infinite query, built
  on `react-query-kit`.
- `createSocketIOClient()` / `createSocketIOServer()` — typed Socket.IO
  wrappers with durable subscriptions.
- `createCacheBridge()` — sync socket events into the TanStack Query cache;
  transport-agnostic.

[Unreleased]: https://github.com/max-listov/stitchkit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/max-listov/stitchkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/max-listov/stitchkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/max-listov/stitchkit/releases/tag/v0.1.0
