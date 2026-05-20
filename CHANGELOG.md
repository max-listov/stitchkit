# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

## [Unreleased]

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

[Unreleased]: https://github.com/max-listov/stitchkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/max-listov/stitchkit/releases/tag/v0.1.0
