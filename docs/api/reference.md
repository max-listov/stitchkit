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
| `ClientConfig` | _type_ | config for `createClient`'s bare-fetch mode (2nd arg, no `HttpClient`) |
| `ContractClientConfig` | _type_ | per-tenant / resource-scoped client config — dynamic `pathPrefix` + `stripPrefixKeys` ([guide](../guide/client.md#contractclientconfig--per-tenant--resource-scoped-clients)) |
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
| `createRetainedTopics` | function | retained last-value store for sticky events — [guide](../guide/realtime.md#sticky-events) |
| `parseSSE` | function | parse an SSE `Response` into an async generator — [guide](../guide/client.md#sse) |
| `SocketIOClient` | _type_ | the client handle |
| `SocketIOClientConfig` | _type_ | config for `createSocketIOClient` (incl. `retain`) |
| `SocketEventMap` | _type_ | the shape of an event map |
| `RetainedTopics` | _type_ | the `createRetainedTopics` handle |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |

### Trace (client)

Browser-safe W3C trace helpers — the same functions as on
[`stitchkit/observability`](#stitchkitobservability), re-exported so a client
can emit / propagate a `traceparent` (see `HttpClientConfig.trace`).

| Export | Kind | Summary |
|--------|------|---------|
| `createTraceContext` | function | a fresh root trace |
| `formatTraceparent` | function | render a `traceparent` header value |
| `parseTraceparent` | function | parse a `traceparent` header |
| `childSpan` | function | a child span of a parent trace |
| `TraceContext` | _type_ | `{ traceId, spanId, parentSpanId? }` |

---

## `stitchkit/contract`

The contract layer alone — browser-and-server safe. All of this is also exported
from the root `stitchkit`.

### Contract

| Export | Kind | Summary |
|--------|------|---------|
| `defineContract` | function | declare a contract — [guide](../guide/contracts.md#definecontract) |
| `createContractFactory` | function | a `defineContract` with a required, typed `scope` — [guide](../guide/contracts.md#scope) |
| `ScopedDefineContract` | _type_ | the `defineContract` `createContractFactory` returns |
| `ALL_TRANSPORTS` | constant | `['HTTP', 'MCP', 'AGENT', 'CLI']` |
| `ContractDef` | _type_ | a defined contract |
| `ContractMeta` | _type_ | a contract's `prefix` + optional `scope` and `meta` (a default every endpoint shallow-merges over) |
| `EndpointDef` | _type_ | a single endpoint definition |
| `HttpMethod` | _type_ | `GET \| POST \| PUT \| PATCH \| DELETE` |
| `Transport` | _type_ | `HTTP \| MCP \| AGENT \| CLI` |
| `TransportSource` | _type_ | `http \| mcp \| agent \| cli` — the value of `ctx.source` |
| `RuntimeContext` | _type_ | the loose context seen by transport and hooks |
| `HandlerContext` | _type_ | the typed context seen by a handler |
| `EndpointFn` | _type_ | the call signature of one client method |
| `TypedClient` | _type_ | the full typed client for a contract |
| `TypedHttpClient` | _type_ | the typed client, HTTP endpoints only (`= ScopedHttpClient<C, unknown>`) |
| `ScopedHttpClient` | _type_ | a client whose `stripPrefixKeys` become required args ([guide](../guide/multi-tenant.md)) |
| `ScopedEndpointFn` | _type_ | one method's signature with the consumed keys folded in |
| `MultipartFile` | _type_ | a `multipart` file field — `Blob \| FileDescriptor` |
| `FileDescriptor` | _type_ | a React Native / Expo file — `{ uri, name, type }` |
| `EndpointToolAnnotations` | _type_ | MCP behavioural hints on an endpoint (`readOnlyHint` / `destructiveHint` / `title`) |
| `EndpointUiMeta` | _type_ | MCP Apps widget metadata on an endpoint |

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
| `defineErrors` | function | declare domain error codes → typed throwers + a code table — [guide](../guide/auth-and-errors.md#domain-errors--defineerrors) |
| `DefinedErrors` | _type_ | the `{ errors, codes, isCode }` handle `defineErrors` returns |
| `ErrorThrower` | _type_ | one `defineErrors` thrower — `(message?, details?, hint?) => never` |
| `STITCH_ERROR_STATUS` | const | `code → HTTP status` map for stitchkit's own error codes — [guide](../guide/auth-and-errors.md#stitch-codes-vs-your-codes) |
| `StitchErrorCode` | _type_ | a code stitchkit itself emits (`keyof STITCH_ERROR_STATUS`) |
| `isStitchErrorCode` | function | type guard — is a code one of stitchkit's own? |

### Pagination

| Export | Kind | Summary |
|--------|------|---------|
| `paginatedSchema` | function | the `{ items, nextCursor }` Zod schema — [guide](../guide/contracts.md#pagination) |
| `Paginated` | _type_ | the cursor-pagination envelope |
| `encodeCursor` | function | encode a keyset value into an opaque `nextCursor` string (base64url, UTF-8-safe) |
| `decodeCursor` | function | decode + Zod-validate a cursor back to its value (`null` if missing/invalid) |

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
| `serveFile` | function | serve a file with `Range` / `304` / `HEAD` — [guide](../guide/server.md#serving-files--range-requests) |
| `parseByteRange` | function | parse a single `Range` header → range / `unsatisfiable` / `null` |
| `isWithinDir` | function | path containment — `(root, resolvedTarget) => boolean`; call it before `serveFile` on any URL-derived path |
| `weakETag` | function | a weak `ETag` from size + mtime |
| `ServeFileOptions` | _type_ | options for `serveFile` |
| `ByteRange` | _type_ | an inclusive `{ start, end }` byte range |
| `respondJson` | function | a raw route's JSON response (`204` for null/undefined) |
| `errorResponse` | function | any thrown value → the framework error envelope + `x-request-id` |
| `normalizeError` | function | any thrown value → an `AppError` (`ZodError` → `VALIDATION_ERROR` 400 with structured `details.issues`, else generic 500) — the framework's canonical classification, for a bespoke `onError` |
| `errorCode` | function | the stable error code for a thrown value (side-effect-free — for log attribution) |
| `formatZodError` | function | a `ZodError` → a readable, field-summarised string |
| `zodIssues` | function | a `ZodError` → structured `{ path, code, message }[]` — the machine-readable sibling of `formatZodError` |
| `ZodIssueSummary` | _type_ | one structured validation issue (`{ path, code, message }`) |
| `parseBody` | function | parse + Zod-validate a JSON body → `data` or `null` (no throw) |
| `HandlerConfig` | _type_ | config for `createHandler` (runtime-agnostic) |
| `BunServerConfig` | _type_ | config for `createServer` (Bun) |
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
| `createErrorHook` | function | an `onError` hook from a code map + envelope renderer — [guide](../guide/auth-and-errors.md#createerrorhook) |
| `ErrorHookConfig` | _type_ | config for `createErrorHook` |
| `ResolvedError` | _type_ | the normalised error handed to `createErrorHook`'s `render` |
| `createBearerResolver` | function | a bearer-token identity resolver |
| `signJwt` | function | sign an HS256 JWT |
| `verifyJwt` | function | verify an HS256 JWT |
| `extractToken` | function | read a bearer token from header or cookie |
| `deriveCodeChallenge` | function | PKCE — derive the `code_challenge` from a verifier |
| `verifyPkce` | function | PKCE — verify a verifier against a stored challenge |
| `AuthHook` | _type_ | the hook `createAuthHook` returns |
| `AuthHookConfig` | _type_ | config for `createAuthHook` |
| `AuthRule` | _type_ | `'public' \| 'authenticated' \| predicate` |
| `BearerResolverConfig` | _type_ | config for `createBearerResolver` |
| `JwtPayload` | _type_ | a decoded JWT payload |
| `SignJwtOptions` | _type_ | options for `signJwt` (expiry, claims) |
| `PkceMethod` | _type_ | the PKCE challenge method — `'S256' \| 'plain'` |

### Cookies & CORS

| Export | Kind | Summary |
|--------|------|---------|
| `defineCookie` | function | a typed cookie `get` / `set` / `clear` handle — [guide](../guide/auth-and-errors.md#cookies) |
| `parseCookies` | function | parse a `Cookie` header to a record |
| `serializeCookie` | function | build a `Set-Cookie` value |
| `corsHeaders` | function | compute CORS response headers |
| `corsPreflightResponse` | function | build a preflight `Response` |
| `DEFAULT_CORS_ALLOW_HEADERS` | const | the default `Access-Control-Allow-Headers` (incl. `traceparent`) — extend it when overriding `cors.headers` |
| `DEFAULT_CORS_EXPOSE_HEADERS` | const | the default `Access-Control-Expose-Headers` (incl. `Content-Disposition`, `ETag`, `Content-Range`) — extend it when overriding `cors.exposeHeaders` |
| `CookieDef` | _type_ | the `defineCookie` handle |
| `CookieOptions` | _type_ | cookie attributes |
| `CorsConfig` | _type_ | CORS policy |

### Realtime (server)

| Export | Kind | Summary |
|--------|------|---------|
| `createSocketIOServer` | function | the typed Socket.IO server — [guide](../guide/realtime.md#server--createsocketioserver) |
| `SocketIOServerConfig` | _type_ | config for `createSocketIOServer` |
| `SocketIOServerHandle` | _type_ | the `{ io, websocket, route }` handle |
| `composeWebSocketHandlers` | function | compose one Bun `websocket` from N lanes — a raw binary lane beside Socket.IO ([guide](../guide/realtime.md#raw-binary-lane-bun)) |
| `webSocketLane` | function | a typed, cast-free lane for `composeWebSocketHandlers` |
| `socketIoLane` | function | the Socket.IO catch-all lane for `composeWebSocketHandlers` |
| `ComposedLane` | _type_ | a lane bridged to the loose data type |
| `WebSocketLane` | _type_ | a typed lane (`{ match, handlers }`) |
| `WebSocketComposeConfig` | _type_ | server-wide tuning for the composed handler |

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
| `resolveSocketIp` | function | the caller IP for a Socket.IO handshake (proxy-aware) |
| `getClientInfo` | function | caller IP + user-agent |
| `EventBus` | _type_ | the `createEventBus` handle |
| `RateLimitConfig` | _type_ | config for `createRateLimiter` |
| `ClientIpOptions` | _type_ | trusted-proxy config for `extractIp` / `resolveSocketIp` |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |

### OpenAPI

| Export | Kind | Summary |
|--------|------|---------|
| `generateOpenApiDocument` | function | an OpenAPI 3.1 document from contract services — [ADR 0018](../decisions/0018-openapi-generation.md) |
| `openApiRoute` | function | a `RawRoute` that serves the document as JSON |
| `OpenApiConfig` | _type_ | config for `generateOpenApiDocument` (incl. `includeMethod` — curate a public subset) — [guide](../guide/server.md#curating-the-spec--includemethod) |
| `OpenApiDocument` | _type_ | the generated document |
| `OpenApiInfo` | _type_ | the spec `info` block |
| `OpenApiServer` | _type_ | a spec `servers` entry |

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
| `setRequestEndpoint` | function | attach the resolved endpoint identity to the active context |
| `setRequestDimensions` | function | attach custom audit dimensions to the active context |
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
| `createCli` | function | a command-line program from contracts — [guide](../guide/cli.md) (also on `stitchkit/cli`) |
| `createToolkit` | function | context-typed tool mounts — [guide](../guide/cli.md#typed-context) |
| `mountViewFile` | function | a native multimodal "view file" MCP tool |
| `resolveMedia` | function | resolve a media reference for a tool result |
| `validateMcpSchemas` | function | assert every tool schema is JSON Schema-compatible — [guide](../guide/mcp-and-agents.md#incompatible-schemas--onincompatibleschema) |
| `listToolNames` | function | every mounted tool name with its `(service, method)` identity — for name-baseline snapshots — [guide](../guide/mcp-and-agents.md#pinning-tool-names--listtoolnames) |
| `McpHandlerConfig` | _type_ | config for `createMcpHandler` |
| `StdioMcpServerConfig` | _type_ | config for `createStdioMcpServer` |
| `McpServerBuildConfig` | _type_ | shared config for `buildMcpServer` |
| `ImplementRemoteOptions` | _type_ | options for `implementRemote` |
| `McpMountConfig` | _type_ | config for `mountMcp` |
| `AgentMountConfig` | _type_ | config for `mountAgent` |
| `AgentContext` | _type_ | the context merged into agent tool handlers |
| `CliConfig` | _type_ | config for `createCli` |
| `CliWaitConfig` | _type_ | `--wait` polling config |
| `ExitCodeMap` | _type_ | `ToolResult.code` → process exit code |
| `Toolkit` | _type_ | the context-pinned tool surface from `createToolkit` |
| `ToolExtend` | _type_ | extra-args extension for `mountMcp` / `mountAgent` |
| `ToolLifecycle` | _type_ | `beforeHandle` / `afterHandle` gate for tool calls — [guide](../guide/mcp-and-agents.md#guarding-tools--lifecycle) |
| `ToolCallHooks` | _type_ | `beforeToolCall` / `afterToolCall` observability hooks |
| `ErrorHintFn` | _type_ | `(toolName, errorCode) => string \| null` — a per-tool recovery hint, shared by every mount |
| `ToolResult` | _type_ | the result of one tool call |
| `ToolNameEntry` | _type_ | one `listToolNames` row — `{ name, service, method, transports }` |
| `IncompatibleSchemaPolicy` | _type_ | `'throw' \| 'skip' \| 'warn'` |
| `McpMediaContent` | _type_ | a multimodal MCP content item |

### Native tools

Generic host-supplied tools mounted onto a server — not derived from a contract.

| Export | Kind | Summary |
|--------|------|---------|
| `mountDownload` | function | a "download a URL to disk" tool (SSRF-guarded, size-capped) |
| `mountUpload` | function | an "upload a local file" tool |
| `mountWait` | function | a generic `--wait`-style polling tool |
| `DownloadToolConfig` | _type_ | config for `mountDownload` |
| `UploadToolConfig` | _type_ | config for `mountUpload` |
| `WaitToolConfig` | _type_ | config for `mountWait` |

### OAuth 2.1 provider

A native remote-connector auth surface for MCP — [guide](../guide/mcp-and-agents.md#oauth-21--a-native-remote-connector).

| Export | Kind | Summary |
|--------|------|---------|
| `mountOAuthProvider` | function | the OAuth 2.1 provider routes (DCR, PKCE, token) |
| `oauthProtectedResourceRoute` | function | the RFC 9728 protected-resource-metadata route |
| `protectedResourceMetadataUrl` | function | build the metadata URL for a resource |
| `wwwAuthenticateHeader` | function | build the `WWW-Authenticate` challenge header |
| `PROTECTED_RESOURCE_PATH` | const | the well-known metadata path |
| `OAuthProviderConfig` | _type_ | config for `mountOAuthProvider` |
| `ProtectedResourceConfig` | _type_ | config for `oauthProtectedResourceRoute` |
| `ApplicationType` | _type_ | DCR `application_type` — `'native'` (loopback allowed) \| `'web'` (https only) |
| `AuthCodeData` | _type_ | a stored authorization-code record |
| `AuthRequest` | _type_ | a parsed authorization request |
| `ClientMetadata` | _type_ | dynamic-client-registration metadata |
| `RefreshData` | _type_ | a stored refresh-token record |
| `RegisteredClient` | _type_ | a registered OAuth client |

### MCP Apps (widgets)

Interactive MCP resources — [ADR 0019](../decisions/0019-generic-native-tools.md).

| Export | Kind | Summary |
|--------|------|---------|
| `mountMcpResource` | function | mount an MCP Apps widget resource |
| `inlineMcpAppBundle` | function | inline a built widget bundle into a resource |
| `EXT_APPS_BUNDLE_PLACEHOLDER` | const | the placeholder token `inlineMcpAppBundle` replaces |
| `RESOURCE_MIME_TYPE` | const | the MCP Apps resource MIME type |
| `McpResourceDef` | _type_ | an MCP Apps resource definition |
| `McpAppResourceMeta` | _type_ | resource `_meta` for an MCP App |
| `McpAppCsp` | _type_ | the widget content-security policy |

### Introspection & internals

Advanced building blocks — the shared machinery the mounts are built on.

| Export | Kind | Summary |
|--------|------|---------|
| `collectTools` | function | resolve a service's methods to mountable tools (the shared resolver) |
| `createToolLogger` | function | a ready `afterToolCall` that logs every tool call — [guide](../guide/mcp-and-agents.md#logging-tool-calls--createtoollogger) |
| `summarizeTransports` | function | per-transport operation counts for a boot-time summary |
| `buildToolManifest` | function | a searchable `{ name, description, inputSchema }` manifest for a `tool_search` tool |
| `ToolLoggerConfig` | _type_ | config for `createToolLogger` |
| `ToolCallRecord` | _type_ | the structured record `createToolLogger` passes to `onRecord` |
| `TransportSummary` | _type_ | the result of `summarizeTransports` |
| `TransportCounts` | _type_ | per-transport counts (`{ HTTP, MCP, AGENT, CLI }`) |
| `coerceJsonArgs` | function | coerce JSON-stringified array/object tool arguments |
| `flattenDiscriminatedUnion` | function | flatten one discriminated union into a single object schema |
| `flattenUnionsDeep` | function | flatten discriminated unions at every depth — union shape only; each object keeps its own key policy (`.strict()` / `.loose()` / `.catchall()`) |
| `MountableTool` | _type_ | one contract method resolved for mounting |
| `ToolManifestEntry` | _type_ | one `buildToolManifest` row |

---

## `stitchkit/node`

Server-only, for Node ≥ 22 (Bun uses `stitchkit/server`). The runtime-agnostic
core plus a Node HTTP adapter — [ADR 0013](../decisions/0013-runtime-agnostic-core.md),
[deployment guide](../guide/testing-and-deployment.md#node). Re-exports the
runtime-agnostic pieces of `stitchkit/server` and the error helpers.

| Export | Kind | Summary |
|--------|------|---------|
| `serveNode` | function | build the router and start a Node HTTP server (via `srvx`) |
| `createHandler` | function | the router as a bare `(req) => Response` (same as `/server`) |
| `createSocketIOServer` | function | the typed Socket.IO server (same as `/server`) |
| `implement` / `createImplement` | function | bind a contract to typed handlers (same as `/server`) |
| `NodeServerConfig` | _type_ | config for `serveNode` |
| `NodeServerHandle` | _type_ | the `serveNode` handle (`{ port, stop }`) |
| `HandlerConfig` / `ServiceDef` / `RawRoute` / `RawRouteContext` / `SocketIOServerConfig` / `SocketIOServerHandle` | _type_ | re-exported from `/server` |
| `AppError` + `appError` / `badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `rateLimited` | — | error helpers (same as `/contract`) |

---

## `stitchkit/cli`

Server-only. Turns contracts into a command-line program — the fourth transport.
Light by design: needs neither the MCP SDK nor the `ai` peer.

| Export | Kind | Summary |
|--------|------|---------|
| `createCli` | function | build and run a CLI from contracts — [guide](../guide/cli.md) |
| `parseCliArgs` | function | argv → typed tool args against a schema (advanced) |
| `pollUntilDone` | function | the generic `--wait` poller (advanced) |
| `emitResult` | function | write a `ToolResult` to stdout/stderr + exit code (advanced) |
| `DEFAULT_EXIT_CODES` | const | the default `ToolResult.code` → exit-code map |
| `CliConfig` | _type_ | config for `createCli` |
| `CliRunOptions` | _type_ | parsed global flags (`--json`, `--wait`, …) |
| `ParsedCliArgs` | _type_ | result of `parseCliArgs` |
| `CliWaitConfig` | _type_ | per-command `--wait` polling config |
| `ExitCodeMap` | _type_ | `ToolResult.code` → process exit code |
| `PollParams` | _type_ | params for `pollUntilDone` |
| `CliWriters` | _type_ | stdout/stderr sinks for `emitResult` |
| `EmitOptions` | _type_ | options for `emitResult` |

---

## `stitchkit/react`

Browser-only. The React data-layer helpers. Needs the `@tanstack/react-query`
and `react-query-kit` peers.

| Export | Kind | Summary |
|--------|------|---------|
| `createCursorQuery` | function | a cursor-paginated infinite query — [guide](../guide/client.md#cursor-pagination) |
| `createCacheBridge` | function | sync socket events into the Query cache — [guide](../guide/realtime.md#cache-bridge) |
| `createEntityCacheHandlers` | function | created/updated/deleted cache handlers for one entity — [guide](../guide/realtime.md#entity-cache-handlers) |
| `EntityCacheConfig` | _type_ | config for `createEntityCacheHandlers` |
| `EntityCacheHandlers` | _type_ | the `{ created, updated, deleted }` handlers it returns |
| `DeletedPayload` | _type_ | a `deleted` event payload — the entity or a bare `{ id }` |
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
[Architecture Decisions](../decisions/).
