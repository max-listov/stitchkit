# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

## [Unreleased]

### Observability

- `stitchkit/observability` — a new entrypoint: the audit layer above the raw
  hooks. A project's request logging becomes a table plus a `write` function.
- `createAuditHook({ write, filter?, sanitize? })` — wires the HTTP fetch
  handler and the `afterToolCall` hook into one sink, normalising every
  completed call into a `RequestEvent`.
- `RequestEvent` — one normalised audit shape for every surface (HTTP / MCP /
  agent): trace ids, outcome, timing, sanitised payload, identity.
- `wrapInRequestContext` + `getRequestContext` / `getTraceId` / `setRequestUser`
  / `setRequestError` — a per-request `AsyncLocalStorage` context: trace ids,
  source, identity, timing. Pass `getTraceId` as `createServer`'s `traceId` so
  request logs and application logs share one id.
- W3C Trace Context — `resolveTraceContext` / `parseTraceparent` /
  `formatTraceparent` / `childSpan`: a `traceparent` is continued across the
  HTTP request and every tool call beneath it.
- `sanitizePayload` / `redact` / `truncatePreview` / `measureSize` — mask
  secret-named keys, drop binary blobs, cap payload size.

### MCP

- `createStdioMcpServer` — serve contract tools over the **stdio** transport, as
  a subprocess of the MCP client. Companion to `createMcpHandler` (HTTP).
- `buildMcpServer` — the transport-neutral core that builds an `McpServer` from
  contracts; shared by both MCP transports.
- `implementRemote(contract, http)` — bind a contract to a remote HTTP API
  (handlers proxy to a deployed server), for building a thin local MCP / agent
  server. Optional `transformArgs` hook rewrites call arguments before forward.
- `instructions` on the MCP server config — a short host-facing usage hint,
  surfaced to MCP tool-search.
- MCP tools now register an `outputSchema` (from the contract `output`) and
  return `structuredContent` — the structured payload consumed by MCP App UIs.
  `mountMcp` moved off the deprecated `.tool()` to `registerTool()`.

### Internal

- Pre-release deduplication pass — no behaviour change. `mountMcp` / `mountAgent`
  now share `tools/mount` (method walk, schema merge, extend handling, call
  execution); `createCache` / `createRateLimiter` share `server/swept-map`; the
  router's three segment-match loops collapse to one `matchSegments`; `isRecord`
  is one guard in `internal/typed`.
- `ToolExtend` is a single exported type — it replaces the duplicated
  `McpToolExtend` / `AgentToolExtend` aliases.
- `ErrorEnvelope` — one exported type for the error-response shape; both
  `AppError.toJSON()` and the typed HTTP client are declared against it.

## [0.1.0] — 2026-05-20

First public release.

### Contract

- `defineContract(meta, endpoints)` — one declaration describing an API: method,
  path, Zod `input` / `output` / `params`, `scope`, `expose` transports,
  `multipart`, per-endpoint `timeout`.
- `AppError` + `notFound` / `badRequest` / `unauthorized` / `forbidden` /
  `conflict` / `rateLimited` / `appError` — a single error model.
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
  consuming app never imports `@modelcontextprotocol/sdk`. `mountMcp()` for
  mounting onto an existing server.
- `mountAgent()` — Vercel AI SDK tools from contracts.

### Client & React

- `createClient()` / `createClients()` / `createHttpClient()` — a typed fetch
  client built from contracts (Ky-based, SSR cookies, error parsing).
- `createCursorQuery()` — the canonical cursor-paginated infinite query, built
  on `react-query-kit`.
- `createSocketIOClient()` / `createSocketIOServer()` — typed Socket.IO
  wrappers with durable subscriptions.
- `createCacheBridge()` — sync socket events into the TanStack Query cache;
  transport-agnostic.

[Unreleased]: https://github.com/maxlistov/stitchkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/maxlistov/stitchkit/releases/tag/v0.1.0
