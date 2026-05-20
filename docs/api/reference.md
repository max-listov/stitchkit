# API reference

Every public export of stitchkit, grouped by entrypoint. Each entry links to the
guide page that explains it in context. Types are marked _type_; everything else
is a value (a function, a class, a constant).

The root `stitchkit` entrypoint is browser-safe; `stitchkit/server` and
`stitchkit/tools` are server-only. See
[Getting started → entrypoints](../guide/getting-started.md#entrypoints).

---

## `stitchkit`

The browser-and-server entrypoint. Re-exports everything from
[`stitchkit/contract`](#stitchkitcontract), plus the client and browser realtime.

### Client

| Export | Kind | Summary |
|--------|------|---------|
| `createClient` | function | build a typed client from a contract — [guide](../guide/client.md#createclient) |
| `createClients` | function | build one typed client per contract from a registry |
| `createHttpClient` | function | the Ky-based HTTP transport — [guide](../guide/client.md#createhttpclient) |
| `ApiError` | class | a non-2xx response, with `code` / `status` / `details` / `hint` |
| `HttpClient` | _type_ | the transport interface `createClient` builds on |
| `HttpClientConfig` | _type_ | config for `createHttpClient` |
| `RequestOptions` | _type_ | per-call options — params, timeout, response type |
| `HeaderProvider` | _type_ | static or per-request headers |
| `ApiEvent` | _type_ | a client event — `unauthorized` / `network_error` / `logout` |
| `ApiEventListener` | _type_ | an `ApiEvent` handler |

### Realtime (client) & streaming

| Export | Kind | Summary |
|--------|------|---------|
| `createSocketIOClient` | function | the typed Socket.IO client — [guide](../guide/realtime.md#client--createsocketioclient) |
| `parseSSE` | function | parse an SSE `Response` into an async generator — [guide](../guide/client.md#sse) |
| `SocketIOClient` | _type_ | the client handle |
| `SocketIOClientConfig` | _type_ | config for `createSocketIOClient` |
| `SocketEventMap` | _type_ | the shape of an event map |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |

---

## `stitchkit/contract`

The contract layer alone — browser-and-server safe. All of this is also exported
from the root `stitchkit`.

### Contract

| Export | Kind | Summary |
|--------|------|---------|
| `defineContract` | function | declare a contract — [guide](../guide/contracts.md#definecontract) |
| `ALL_TRANSPORTS` | constant | `['HTTP', 'MCP', 'AGENT']` |
| `ContractDef` | _type_ | a defined contract |
| `ContractMeta` | _type_ | a contract's `prefix` + optional `scope` |
| `EndpointDef` | _type_ | a single endpoint definition |
| `HttpMethod` | _type_ | `GET \| POST \| PUT \| PATCH \| DELETE` |
| `Transport` | _type_ | `HTTP \| MCP \| AGENT` |
| `TransportSource` | _type_ | `http \| mcp \| agent` — the value of `ctx.source` |
| `RuntimeContext` | _type_ | the loose context seen by transport and hooks |
| `HandlerContext` | _type_ | the typed context seen by a handler |
| `EndpointFn` | _type_ | the call signature of one client method |
| `TypedClient` | _type_ | the full typed client for a contract |
| `TypedHttpClient` | _type_ | the typed client, HTTP endpoints only |

### Errors

| Export | Kind | Summary |
|--------|------|---------|
| `AppError` | class | the framework error — `code` / `status` / `details` / `hint` |
| `ErrorEnvelope` | _type_ | the JSON shape of an error response |
| `notFound` | function | throw `404 NOT_FOUND` — [guide](../guide/auth-and-errors.md#throwing-errors) |
| `badRequest` | function | throw `400 BAD_REQUEST` |
| `unauthorized` | function | throw `401 UNAUTHORIZED` |
| `forbidden` | function | throw `403 FORBIDDEN` |
| `conflict` | function | throw `409 CONFLICT` |
| `rateLimited` | function | throw `429 RATE_LIMITED` |
| `appError` | function | throw an `AppError` for any code |

### Pagination

| Export | Kind | Summary |
|--------|------|---------|
| `paginatedSchema` | function | the `{ items, nextCursor }` Zod schema — [guide](../guide/contracts.md#pagination) |
| `Paginated` | _type_ | the cursor-pagination envelope |

---

## `stitchkit/server`

Server-only. Builds and runs the HTTP server, and carries the server primitives.
Also re-exports the error helpers from `stitchkit/contract`.

### Server & handlers

| Export | Kind | Summary |
|--------|------|---------|
| `createServer` | function | build the router and start `Bun.serve` — [guide](../guide/server.md#createserver) |
| `createHandler` | function | the router as a bare `(req) => Response` — [guide](../guide/server.md#createserver) |
| `implement` | function | bind a contract to typed handlers — [guide](../guide/server.md#implement) |
| `createImplement` | function | fix the handler context type once |
| `staticRoute` | function | a raw route that serves a directory |
| `ServerConfig` | _type_ | config for `createServer` / `createHandler` |
| `ServiceDef` | _type_ | the result of `implement` |
| `MethodDef` | _type_ | one resolved endpoint inside a service |
| `Handlers` | _type_ | the typed handler map `implement` expects |
| `LifecycleHooks` | _type_ | `onRequest` / `beforeHandle` / `afterHandle` / `onError` |
| `RouteGroup` | _type_ | a prefixed group of services with its own hooks |
| `RawRoute` | _type_ | a non-contract `Request → Response` route |
| `RawRouteContext` | _type_ | the routing context a raw handler receives |
| `BunServer` | _type_ | the `Bun.serve` instance type |
| `ServerPassthrough` | _type_ | extra `Bun.serve` options |
| `StitchLogger` | _type_ | the custom-logger interface |

### Auth

| Export | Kind | Summary |
|--------|------|---------|
| `createAuthHook` | function | a scope-enforcing `beforeHandle` hook — [guide](../guide/auth-and-errors.md#createauthhook) |
| `createBearerResolver` | function | a bearer-token identity resolver |
| `verifyJwt` | function | verify an HS256 JWT |
| `extractToken` | function | read a bearer token from header or cookie |
| `AuthHook` | _type_ | the hook `createAuthHook` returns |
| `AuthHookConfig` | _type_ | config for `createAuthHook` |
| `AuthRule` | _type_ | `'public' \| 'authenticated' \| predicate` |
| `BearerResolverConfig` | _type_ | config for `createBearerResolver` |
| `JwtPayload` | _type_ | a decoded JWT payload |

### Cookies & CORS

| Export | Kind | Summary |
|--------|------|---------|
| `defineCookie` | function | a typed cookie `get` / `set` / `clear` handle — [guide](../guide/auth-and-errors.md#cookies) |
| `parseCookies` | function | parse a `Cookie` header to a record |
| `serializeCookie` | function | build a `Set-Cookie` value |
| `corsHeaders` | function | compute CORS response headers |
| `corsPreflightResponse` | function | build a preflight `Response` |
| `CookieDef` | _type_ | the `defineCookie` handle |
| `CookieOptions` | _type_ | cookie attributes |
| `CorsConfig` | _type_ | CORS policy |

### Realtime (server)

| Export | Kind | Summary |
|--------|------|---------|
| `createSocketIOServer` | function | the typed Socket.IO server — [guide](../guide/realtime.md#server--createsocketioserver) |
| `SocketIOServerConfig` | _type_ | config for `createSocketIOServer` |
| `SocketIOServerHandle` | _type_ | the `{ io, websocket, route }` handle |

### Primitives

| Export | Kind | Summary |
|--------|------|---------|
| `streamSSE` | function | an async generator → SSE `Response` — [guide](../guide/server.md#sse-streaming) |
| `parseSSE` | function | parse an SSE `Response` (also on the root entrypoint) |
| `parseMultipart` | function | parse a `multipart/form-data` request — [guide](../guide/server.md#multipart) |
| `createRateLimiter` | function | token-bucket rate limiting — [guide](../guide/server.md#rate-limiting) |
| `createCache` | function | an in-memory TTL cache |
| `cacheHeaders` | function | build a `Cache-Control` header |
| `createEventBus` | function | typed in-process pub/sub — [guide](../guide/server.md#event-bus) |
| `generateTraceId` | function | a fresh trace id |
| `resolveTraceId` | function | the default per-request trace-id resolver |
| `extractIp` | function | the caller IP from a request |
| `getClientInfo` | function | caller IP + user-agent |
| `EventBus` | _type_ | the `createEventBus` handle |
| `RateLimitConfig` | _type_ | config for `createRateLimiter` |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |

---

## `stitchkit/observability`

Server-only. The audit layer one level above the raw hooks — W3C trace context,
an `AsyncLocalStorage` request context, payload sanitisation and a normalised
audit event. See the [Observability guide](../guide/observability.md).

### Audit

| Export | Kind | Summary |
|--------|------|---------|
| `createAuditHook` | function | wire both surfaces into one sink — [guide](../guide/observability.md#createaudithook) |
| `RequestEvent` | _type_ | the normalised audit event handed to the sink |
| `AuditConfig` | _type_ | config for `createAuditHook` |
| `AuditHook` | _type_ | the `{ http, toolCall }` the hook returns |

### Request context

| Export | Kind | Summary |
|--------|------|---------|
| `wrapInRequestContext` | function | run a fetch handler inside a request context — [guide](../guide/observability.md#request-context) |
| `getRequestContext` | function | the active request context |
| `getTraceId` | function | the active trace id — pass as `traceId` to `createServer` |
| `getUserId` | function | the active user id, once auth has resolved it |
| `setRequestUser` | function | attach the resolved user to the active context |
| `setRequestError` | function | record the error outcome on the active context |
| `runWithRequestContext` | function | run a function inside a given context |
| `RequestContext` | _type_ | the per-request record |

### Trace context

| Export | Kind | Summary |
|--------|------|---------|
| `resolveTraceContext` | function | the trace for a request — `traceparent` continued or fresh |
| `parseTraceparent` | function | parse a `traceparent` header |
| `formatTraceparent` | function | render a `traceparent` header value |
| `createTraceContext` | function | a fresh root trace |
| `childSpan` | function | a child span of a parent trace |
| `TraceContext` | _type_ | `{ traceId, spanId, parentSpanId? }` |

### Sanitisation

| Export | Kind | Summary |
|--------|------|---------|
| `sanitizePayload` | function | redact secrets and cap size — [guide](../guide/observability.md#sanitisation) |
| `redact` | function | mask secret-named keys, drop binary blobs |
| `truncatePreview` | function | cap a value by serialised size |
| `measureSize` | function | item count + byte size of a result |
| `JsonValue` | _type_ | a JSON-serialisable value |
| `SanitizeOptions` | _type_ | tuning for `redact` / `sanitizePayload` |
| `SizeMeasure` | _type_ | the result of `measureSize` |

---

## `stitchkit/tools`

Server-only. Turns contracts into MCP and AI-agent tools. Needs the
`@modelcontextprotocol/sdk` peer (for MCP) and the `ai` peer (for agents).

| Export | Kind | Summary |
|--------|------|---------|
| `createMcpHandler` | function | a complete Streamable-HTTP MCP server — [guide](../guide/mcp-and-agents.md#mcp--createmcphandler) |
| `createStdioMcpServer` | function | a complete stdio MCP server — [guide](../guide/mcp-and-agents.md#mcp-over-stdio--createstdiomcpserver) |
| `buildMcpServer` | function | build an `McpServer` from contracts — the transport-neutral core |
| `mountMcp` | function | add contract tools to an existing `McpServer` — [guide](../guide/mcp-and-agents.md#mountmcp) |
| `implementRemote` | function | bind a contract to a remote HTTP API — [guide](../guide/mcp-and-agents.md#proxying-a-remote-api--implementremote) |
| `mountAgent` | function | a Vercel AI SDK `ToolSet` from a service — [guide](../guide/mcp-and-agents.md#ai-agents--mountagent) |
| `mountViewFile` | function | a native multimodal "view file" MCP tool |
| `resolveMedia` | function | resolve a media reference for a tool result |
| `McpHandlerConfig` | _type_ | config for `createMcpHandler` |
| `StdioMcpServerConfig` | _type_ | config for `createStdioMcpServer` |
| `McpServerBuildConfig` | _type_ | shared config for `buildMcpServer` |
| `ImplementRemoteOptions` | _type_ | options for `implementRemote` |
| `McpMountConfig` | _type_ | config for `mountMcp` |
| `AgentMountConfig` | _type_ | config for `mountAgent` |
| `AgentContext` | _type_ | the context merged into agent tool handlers |
| `ToolExtend` | _type_ | extra-args extension for `mountMcp` / `mountAgent` |
| `McpMediaContent` | _type_ | a multimodal MCP content item |

---

## `stitchkit/react`

Browser-only. The React data-layer helpers. Needs the `@tanstack/react-query`
and `react-query-kit` peers.

| Export | Kind | Summary |
|--------|------|---------|
| `createCursorQuery` | function | a cursor-paginated infinite query — [guide](../guide/client.md#cursor-pagination) |
| `createCacheBridge` | function | sync socket events into the Query cache — [guide](../guide/realtime.md#cache-bridge) |
| `CursorQueryConfig` | _type_ | config for `createCursorQuery` |
| `CacheBridge` | _type_ | the `createCacheBridge` handle |
| `CacheBridgeConfig` | _type_ | config for `createCacheBridge` |
| `CacheBridgeContext` | _type_ | the `ctx` a bridge handler receives |
| `CacheBridgeHandler` | _type_ | one event-to-cache handler |
| `CacheBridgeHandlers` | _type_ | the handler map |
| `CacheBridgeSocket` | _type_ | the minimal emitter a bridge accepts |

---

For the rationale behind these APIs — why `Bun.serve` and not a framework, why
two context types, why thin wrappers — see the
[Architecture Decisions](../DECISIONS.md).
