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
| `createClients` | function | build one exact typed client per contract from a registry; accepts the same scoped config and transports as `createClient` |
| `createScopedClients` | function | build one registry routed by contract scope; arrays compose contracts into one namespace |
| `createScopedUrlBuilders` | function | build one URL registry routed by contract scope; arrays compose contracts into one namespace |
| `ScopeClientConfigs` | _type_ | per-scope routing configuration consumed by scoped clients and URL builders |
| `ScopedClientRegistry` | _type_ | exact composed registry returned by `createScopedClients` |
| `ScopedUrlBuilderRegistry` | _type_ | exact composed registry returned by `createScopedUrlBuilders` |
| `ClientRegistryValue` | _type_ | one contract or a contract array composing one client namespace |
| `ClientContract` | _type_ | HTTP-client-compatible contract value used by scoped registries |
| `RegistryScope` | _type_ | contract-scope union inferred from a scoped client registry value |
| `createUrlBuilder` | function | build synchronous browser-native URLs for all HTTP endpoints; body methods accept URL-bound args only — [guide](../guide/client.md#contract-url-builders) |
| `createUrlBuilders` | function | build one exact URL builder per contract in a registry |
| `UrlBuilderConfig` | _type_ | explicit `{ baseUrl }` source for a URL builder |
| `ClientConfig` | _type_ | config for `createClient`'s bare-fetch mode (2nd arg, no `HttpClient`) |
| `ClientFetch` | _type_ | injectable Fetch-compatible transport used by framework testing adapters |
| `ClientRequestOptions` | _type_ | per-call `{ signal?: AbortSignal }` passed through an endpoint callable's `.withOptions(...)`; caller abort is distinct from timeout — [guide](../guide/client.md#per-call-cancellation) |
| `ContractClientConfig` | _type_ | per-tenant / resource-scoped client config — dynamic `pathPrefix` + `stripPrefixKeys` ([guide](../guide/client.md#contractclientconfig--per-tenant--resource-scoped-clients)) |
| `contractEndpointMatchers` | function | compile exact pathname matchers for selected HTTP contract operations and expected-401 policy |
| `PathPrefixArgs` | _type_ | required string-valued keys exposed to a typed dynamic `pathPrefix` callback |
| `createHttpClient` | function | the Ky-based HTTP transport; on Next.js SSR its first attempt stays request-memoizable while every retry is a distinct transport attempt — [guide](../guide/client.md#createhttpclient) |
| `ApiError` | class | a non-2xx response, with `code` / `status` / `details` / `hint` and optional readonly `traceId` from `x-request-id` |
| `HttpClient` | _type_ | the transport interface `createClient` builds on |
| `ConfiguredHttpClient` | _type_ | a framework-created `HttpClient` carrying its readonly `baseUrl` for URL builders |
| `HttpClientConfig` | _type_ | config for `createHttpClient`; retry `limit` counts retries after the initial attempt (default 2 = at most 3 GET attempts), with `statusCodes: []` by default; `unix` dials a unix domain socket (Bun only) — [details](../guide/client.md#createhttpclient) |
| `UnauthorizedMatcher` | _type_ | exact `(pathname) => boolean` policy accepted by `suppressUnauthorizedFor` |
| `RequestOptions` | _type_ | per-call options — params, timeout, response type |
| `HeaderProvider` | _type_ | static or per-request headers |
| `ApiEvent` | _type_ | a client event — `unauthorized` / `network_error` / `logout` |
| `ApiEventListener` | _type_ | an `ApiEvent` handler |

### Realtime (client) & streaming

| Export | Kind | Summary |
|--------|------|---------|
| `createSocketIOClient` | function | low-level typed Socket.IO transport primitive — [guide](../guide/realtime.md#low-level-transport) |
| `defineRealtimeContract` | function | Zod-first shared Socket.IO event contract — [guide](../guide/realtime.md#zod-first-event-contract) |
| `createRealtimeClient` | function | inferred, runtime-validated Socket.IO client — [guide](../guide/realtime.md#client--createrealtimeclient) |
| `bindRealtimeClient` | function | bind contract validation and typed acknowledgements to an existing Stitchkit client transport without owning its lifecycle |
| `createRetainedTopics` | function | retained last-value store for sticky events — [guide](../guide/realtime.md#sticky-events) |
| `parseSSE` | function | parse an SSE `Response` into an async generator — [guide](../guide/client.md#sse) |
| `SocketIOClient` | _type_ | low-level client handle; `emit` reports disconnected drops and `emitWithAck` exposes the native Promise primitive used by validated `request()` |
| `SocketIOClientConfig` | _type_ | config for `createSocketIOClient` (incl. `retain`, `onConnectError`, `onDroppedEmit`) |
| `SocketEventMap` | _type_ | the shape of an event map |
| `RealtimeClient` | _type_ | validated client inferred from a realtime contract |
| `RealtimeClientOptions` | _type_ | transport options and the rejected-event hook for `createRealtimeClient` |
| `BoundRealtimeClient` | _type_ | validated non-owning `on`/`emit`/`request` client with no `connect`/`disconnect` |
| `RealtimeClientTransport` | _type_ | minimal existing transport capability accepted by `bindRealtimeClient` |
| `BindRealtimeClientOptions` | _type_ | rejection/logger options for a bound existing transport |
| `RealtimeAcknowledgedEvent` | _type_ | event-name union restricted to definitions with an `ack` schema |
| `RealtimeAcknowledgement` | _type_ | validated acknowledgement output inferred from an event definition |
| `RealtimeRequestArguments` | _type_ | request arguments inferred from an acknowledged event tuple |
| `RealtimeRequestOptions` | _type_ | finite positive native acknowledgement `timeoutMs` |
| `RealtimeRequestTimeoutError` | class | stable `REALTIME_REQUEST_TIMEOUT` rejection |
| `RealtimeRequestDisconnectedError` | class | stable `REALTIME_REQUEST_DISCONNECTED` rejection, including an immediate disconnected call |
| `RealtimeRequestInvalidAcknowledgementError` | class | invalid ack was reported through `onRejected` and the request rejected |
| `RealtimeContract` | _type_ | shared server-to-client and client-to-server event registries |
| `RealtimeEventRegistry` | _type_ | string-keyed registry of event definitions |
| `RealtimeEventDefinition` | _type_ | one tuple-shaped event and optional acknowledgement schema |
| `RealtimeEventArguments` | _type_ | tuple inferred from an event definition |
| `RealtimeEmitArguments` | _type_ | emit arguments including an inferred acknowledgement callback |
| `RealtimeEventHandler` | _type_ | handler inferred from an event definition |
| `InferRealtimeEventMap` | _type_ | inferred Socket.IO-compatible event map |
| `RealtimeRejectDirection` | _type_ | server/client inbound/outbound rejection direction |
| `RealtimeRejectedEvent` | _type_ | structured rejected event with event, direction, phase, reason and fault |
| `RealtimeRejectedEventHook` | _type_ | sync/async observer for structured realtime rejections |
| `ValidatedRealtimeSocket` | _type_ | runtime-validating `on`/`emit` surface inferred from registries; `emit` returns "accepted by the transport" (`false` only for a client-side disconnected drop) |
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
| `TraceContext` | _type_ | `{ traceId, spanId, parentSpanId?, tracestate?, baggage? }` |

---

## `stitchkit/contract`

The contract layer alone — browser-and-server safe. All of this is also exported
from the root `stitchkit`.

### Contract

| Export | Kind | Summary |
|--------|------|---------|
| `defineContract` | function | declare a contract — [guide](../guide/contracts.md#definecontract) |
| `createContractFactory` | function | a `defineContract` whose scope — on the contract **and** on any endpoint override — is required and held to your union, retaining each concrete literal — [guide](../guide/contracts.md#scope) |
| `ContractFactoryConfig` | _type_ | optional scoped-factory policy, including explicit tool exposure |
| `ContractFactoryToolExposure` | _type_ | `'explicit'` — omitted endpoint exposure materializes as HTTP-only |
| `ExplicitScopedDefineContract` | _type_ | scoped factory authoring with explicit tool opt-in |
| `ExplicitToolExposureEndpoints` | _type_ | endpoint map after missing exposure is materialized as `['HTTP']` |
| `FactoryScopedEndpoint` | _type_ | an endpoint authored through the factory — its own `scope` override is held to the same union |
| `ScopedContractDef` | _type_ | a factory-defined contract whose `meta.scope` is the required concrete literal |
| `ScopedDefineContract` | _type_ | the `defineContract` `createContractFactory` returns — endpoint `scope` overrides join the union |
| `ALL_TRANSPORTS` | constant | `['HTTP', 'MCP', 'AGENT', 'CLI']` |
| `ContractDef` | _type_ | a defined contract |
| `ContractMeta` | _type_ | a contract's `prefix` + optional `scope` and `meta` (a default every endpoint shallow-merges over) |
| `EndpointDef` | _type_ | a single endpoint definition; `output` declares JSON response presence (`null` is data, `undefined` is invalid) |
| `HeadEndpointDef` | _type_ | explicit HTTP-only, bodyless `HEAD` endpoint definition |
| `EndpointResponseMeta` | _type_ | static success metadata declared by an HTTP-only typed-data endpoint |
| `ResponseMetadata` | _type_ | per-request outbound collector exposed as `ctx.response` only for a `responseMeta` endpoint |
| `HttpSuccessStatus` | _type_ | supported declared 2xx success statuses |
| `BodyHttpSuccessStatus` | _type_ | supported 2xx statuses excluding bodyless 204/205 |
| `HttpMethod` | _type_ | `GET \| HEAD \| POST \| PUT \| PATCH \| DELETE` |
| `Transport` | _type_ | `HTTP \| MCP \| AGENT \| CLI` |
| `TransportSource` | _type_ | `http \| mcp \| agent \| cli` — the value of `ctx.source` |
| `RuntimeContext` | _type_ | the loose context seen by transport and hooks, including optional typed `mcp` metadata |
| `HandlerContext` | _type_ | the typed context seen by a handler, including optional typed `mcp` metadata |
| `McpCallContext` | _type_ | validated metadata for the active managed MCP call (`era`, method, tool, client and multi-round fields) |
| `McpClientInfo` | _type_ | self-reported MCP host name/version; attribution only, never application identity |
| `McpRoundOutcome` | _type_ | managed multi-round attempt outcome |
| `EndpointHandlerContext` | _type_ | one endpoint handler's fully inferred params, input, files and runtime context |
| `EndpointFn` | _type_ | the call signature of one client method |
| `TypedClient` | _type_ | the full typed client for a contract |
| `TypedHttpClient` | _type_ | the typed client, HTTP endpoints only (`= ScopedHttpClient<C, unknown>`) |
| `ScopedHttpClient` | _type_ | a client whose `stripPrefixKeys` become required args ([guide](../guide/multi-tenant.md)) |
| `ScopedEndpointFn` | _type_ | one method's signature with the consumed keys folded in |
| `TypedUrlBuilder` | _type_ | one contract's HTTP endpoints as synchronous, method-aware URL functions |
| `ScopedUrlBuilder` | _type_ | a URL builder whose scoped-prefix keys are required method arguments |
| `ScopedUrlFn` | _type_ | one URL method's signature with scoped-prefix keys folded in |
| `MultipartFile` | _type_ | a `multipart` file field — `Blob \| FileDescriptor` |
| `FileDescriptor` | _type_ | a React Native / Expo file — `{ uri, name, type }` |
| `MultipartDescriptor` | _type_ | file fields, cardinality, delivery and request/text limits |
| `MultipartFilePolicy` | _type_ | required/multiple, per-file bytes/count and declared MIME policy |
| `MultipartBufferedFiles` | _type_ | `File` map inferred from a multipart descriptor |
| `EndpointToolAnnotations` | _type_ | MCP behavioural hints on an endpoint (`readOnlyHint` / `destructiveHint` / `title`) |
| `EndpointUiMeta` | _type_ | MCP Apps widget metadata on an endpoint |
| `EndpointMcpInputRequired` | _type_ | typed MCP multi-round input request (`key`, message and Zod object schema) |
| `EndpointMcpPolicy` | _type_ | MCP-only endpoint policy containing `inputRequired` |

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
| `defineErrors` | function | declare immutable domain error definitions → typed `AppError` constructors, codes and schemas — [guide](../guide/auth-and-errors.md#domain-errors--defineerrors) |
| `DefinedErrors` | _type_ | the `{ errors, codes, definitions, isCode }` handle `defineErrors` returns |
| `DefinedAppError` | _type_ | literal-code error instance with schema-refined details |
| `ErrorDefinition` | _type_ | `{ status, message?, details? }` definition for one domain code |
| `ErrorDefinitions` | _type_ | string-keyed domain error definition registry |
| `ErrorDetailsSchema` | _type_ | required or optional Zod object accepted for structured details |
| `ErrorDetailsOutput` | _type_ | parsed details inferred from one definition |
| `ErrorFactoryArguments` | _type_ | options tuple with forbidden/required/optional details inferred per code |
| `ErrorFactory` | _type_ | one typed `AppError` constructor |
| `ErrorFactories` | _type_ | mapped constructor registry derived from all definitions |
| `FrozenErrorDefinitions` | _type_ | read-only definition registry returned to consumers |
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
| `createScopedImplement` | function | fix one scope→context map, then type every handler by its endpoint's effective scope; `.declare(contract)(handlers)` types without binding for the registry path, `.stream(scope, …)` covers streaming multipart — [guide](../guide/server.md#per-scope-handler-context--createscopedimplement) |
| `ScopedHandlers` | _type_ | handler map typed per endpoint by its effective scope |
| `ScopeContexts` | _type_ | scope → extra context fields map accepted by `createScopedImplement` |
| `EffectiveScope` | _type_ | an endpoint's own `scope`, else its contract's group scope |
| `createScopedImplementRegistry` | function | the registry form of `createScopedImplement` — one contract registry, handlers still typed per endpoint scope |
| `ScopedRegistryHandlers` | _type_ | scoped handler registry inferred from a contract registry |
| `ScopedImplementationRegistry` | _type_ | contract registry whose every group scope is a key of the scope map |
| `StreamScope` | _type_ | the scope `createScopedImplement(...).stream` accepts for one endpoint |
| `ExactScopedRegistryHandlers` | _type_ | fail-first scoped registry shape that rejects extra registry and endpoint keys |
| `implementRegistry` | function | bind one exact contract registry to one exact backend handler registry |
| `createImplementRegistry` | function | context-typed factory for `implementRegistry` |
| `ImplementationRegistry` | _type_ | flat literal registry of concrete contracts accepted by `implementRegistry` |
| `KeyedServices` | _type_ | registry result: the mount-ordered `ServiceDef[]` carrying the same services under `.byKey` |
| `RegistryHandlers` | _type_ | exact backend handler registry inferred from a contract registry |
| `ExactRegistryHandlers` | _type_ | fail-first handler shape that rejects extra registry and endpoint keys |
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
| `HandlerConfig` | _type_ | config for `createHandler`, including optional `maxJsonBodyBytes`; bound to `BunServer` on this entrypoint |
| `BunServerConfig` | _type_ | config for `createServer` (Bun); `unix` listens on a unix domain socket (mutually exclusive with `port`/`hostname`) — [details](../guide/server.md#local-daemon-over-a-unix-socket) |
| `UnixListenConfig` | _type_ | unix listener — a socket path, or `{ path, mode }` to tighten the file mode after listen |
| `BunServerHandle` | _type_ | managed Bun handle (`url`, `port`, `runtime`, `status`, `shutdown`) |
| `ManagedServerHandle` | _type_ | shared lifecycle shape generic over the runtime escape hatch |
| `ShutdownOptionsSchema` / `ShutdownOptions` | schema / _type_ | one graceful budget, bounded forced-completion timeout, retry hint and optional external abort signal |
| `ShutdownStatusSchema` / `ShutdownStatus` | schema / _type_ | live state and request/WebSocket counters |
| `ShutdownResultSchema` / `ShutdownResult` | schema / _type_ | clean/forced result with final counters and at-force snapshots |
| `ShutdownStateSchema` / `ShutdownState` | schema / _type_ | managed lifecycle state machine |
| `ServiceDef` | _type_ | the result of `implement` |
| `MethodDef` | _type_ | one resolved endpoint inside a service |
| `OperationIdentity` | _type_ | path-free service/action/scope/method identity shared by contract and native tool operations |
| `Handlers` | _type_ | the typed handler map `implement` expects |
| `LifecycleHooks` | _type_ | `onRequest` / pre-body `authorize` / `beforeHandle` / `afterHandle` / `onError` |
| `composeLifecycleHooks` | function | compose HTTP lifecycle phases in declaration order with short-circuit/fallthrough semantics |
| `AuthorizationContext` | _type_ | HTTP pre-body context with validated params, `input: undefined` and no files |
| `RouteGroup` | _type_ | a prefixed group of services with its own hooks |
| `RawRoute` | _type_ | a non-contract `Request → Response` route with a concrete `BunServer` context |
| `RawRouteContext` | _type_ | the Bun-bound routing context a raw handler receives |
| `BunServer` | _type_ | the `Bun.serve` instance type |
| `ServerPassthrough` | _type_ | extra `Bun.serve` options |
| `StitchLogger` | _type_ | the custom-logger interface |
| `LoggingConfig` | _type_ | the `logging` object — `logger` / `format` / `skip` / `enrich` |
| `LogFormat` | _type_ | `'pretty'` or `'json'` — what the built-in formatter writes |
| `LogOutcome` | _type_ | how a request finished, as `enrich` sees it |
| `FetchHandler` | _type_ | what `createHandler` returns, bound to `BunServer` here |
| `FetchComposition` | _type_ | the Bun-bound `wrapFetch` seam |

### Auth

| Export | Kind | Summary |
|--------|------|---------|
| `createAuthHook` | function | one scope gate for HTTP `authorize` and tool `beforeHandle` — [guide](../guide/auth-and-errors.md#createauthhook) |
| `composeAuthHooks` | function | route multiple canonical auth domains by owned scope and atomically commit their typed contributions |
| `createErrorHook` | function | an async-capable, endpoint-aware `onError` hook from a code map + envelope renderer — [guide](../guide/auth-and-errors.md#createerrorhook) |
| `ErrorHookConfig` | _type_ | async observer/renderer config for `createErrorHook` |
| `ResolvedError` | _type_ | the normalised error handed to `createErrorHook`'s `render` |
| `createBearerResolver` | function | a bearer-token identity resolver |
| `signJwt` | function | sign an HS256 JWT |
| `VerifyJwtOptions` | _type_ | options for `verifyJwt` |
| `verifyJwt` | function | verify an HS256 JWT |
| `extractToken` | function | read a bearer token from header or cookie |
| `deriveCodeChallenge` | function | PKCE — derive the `code_challenge` from a verifier |
| `verifyPkce` | function | PKCE — verify a verifier against a stored challenge |
| `AuthHook` | _type_ | the hook `createAuthHook` returns |
| `AuthHookConfig` | _type_ | config for `createAuthHook` |
| `AuthRule` | _type_ | `'public' \| 'authenticated' \| predicate` |
| `AuthRuleContribution` | _type_ | plain context fields a sync/async rule may contribute after authorizing |
| `ScopedAuthRule` | _type_ | a rule plus its typed context contribution — `{ rule, inject? }` |
| `AuthRules` | _type_ | the `rules` map: bare rules or scoped rules |
| `RuleScopes` | _type_ | scope→context map derived from a `rules` object; `'public'` fields become optional |
| `ScopedAuthHook` | _type_ | an auth hook carrying its derived scope map at the type level |
| `AuthScopes` | _type_ | recover the derived map — `createScopedImplement<AuthScopes<typeof hook>>()` |
| `ComposeAuthHooksConfig` | _type_ | ordered canonical hooks plus the optional explicit composite default scope |
| `ComposedAuthScopes` | _type_ | scope→context map derived from every owner in a composed auth hook |
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
| `bindRealtimeServer` | function | inferred, runtime-validated connection and broadcast boundary |
| `RealtimeServer` | _type_ | validated broadcast and connection API inferred from a realtime contract |
| `RealtimeServerConnection` | _type_ | one validated connection with raw socket access for auth and rooms |
| `RealtimeServerHandle` | _type_ | minimal Socket.IO server handle accepted by `bindRealtimeServer`; carries the handshake identity type through to `connection.raw.data` |
| `SocketIORequestPolicy` | _type_ | runtime-neutral async-capable Web `Request` handshake admission policy |
| `SocketIOServerConfig` | _type_ | config for `createSocketIOServer`; `handshake` is the typed identity gate — [guide](../guide/realtime.md#handshake-auth--cookie-or-token) |
| `SocketIOHandshakeConfig` | _type_ | the `handshake` gate — Zod `schema` over `handshake.auth` plus optional async `verify`; the result lands typed in `socket.data` |
| `SocketIOServerHandle` | _type_ | typed Socket.IO server plus Bun mount fields and idempotent lifecycle |
| `SocketIOServerLifecycle` | _type_ | non-generic Bun mount/shutdown portion accepted by `createServer` |
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
| `MultipartLifecycle` | _type_ | request-scoped rollback ownership for accepted streamed handles |
| `MultipartResult` | _type_ | what `parseMultipart` returns |
| `parseMultipart` | function | parse a typed buffered/streaming multipart descriptor — [guide](../guide/server.md#multipart) |
| `defineMultipartStream` | function | bind typed streaming file receivers and a final endpoint handler |
| `createMultipartStream` | function | fix one handler context type for streaming multipart endpoints |
| `MultipartStreamConfig` | _type_ | receivers plus the context-typed handler accepted by the streaming builders |
| `MultipartFileMetadata` | _type_ | field, filename, declared media type and optional declared size |
| `MultipartReceiver` | _type_ | consumer-owned Web-stream storage receiver |
| `MultipartReceiverResult` | _type_ | receiver value plus rollback cleanup |
| `StreamingMultipartImplementation` | _type_ | receiver registry and handler shape inferred by `defineMultipartStream` |
| `bindProcessSignals` | function | bind `SIGINT` / `SIGTERM` to one managed `shutdown()` — one chain, force on a later signal, default disposition on the one after — [guide](../guide/testing-and-deployment.md#process-signals--bindprocesssignals) |
| `ProcessSignalsOptions` | _type_ | config for `bindProcessSignals` |
| `ProcessSignalsBinding` | _type_ | the `{ promise, close }` handle `bindProcessSignals` returns |
| `ProcessSignalsErrorPhase` | _type_ | `'prepare' \| 'shutdown' \| 'complete'` — which phase an `onError` report came from |
| `SignalSource` | _type_ | injectable signal source — `process` by default |
| `ProcessSignalName` | _type_ | signal names the binding accepts (owned, so the published types need no `@types/node`) |
| `ShutdownTarget` | _type_ | the `shutdown`-only slice a binding needs — an interface, so a [composite target](../guide/testing-and-deployment.md#composite-shutdown-target--parallel-domain-drains) can drain several domains under one signal machine |
| `createRateLimiter` | function | token-bucket rate limiting — [guide](../guide/server.md#rate-limiting) |
| `createCache` | function | an in-memory TTL cache |
| `CacheOptions` | _type_ | bounded-cache options, including the maximum retained entry count |
| `cacheHeaders` | function | build a `Cache-Control` header |
| `EventBusOptions` | _type_ | options for `createEventBus` |
| `EventHandler` | _type_ | one event-bus subscriber |
| `DefaultEventMap` | _type_ | the default event map — `Record<string, unknown>` |
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

## `stitchkit/agent-runtime`

Server-only optional application runtime. See the
[agent runtime guide](../guide/agent-runtime.md).

| Export | Kind | Summary |
|--------|------|---------|
| `createAgentRuntime` | function | compose durable acceptance, stream loop, checkpoints, coordination, managed tools and terminal publication |
| `defineAgentProtocol` | function | declare and validate context, input metadata and canonical message parts |
| `AgentMessageSchema` / `AgentRunSchema` / `AgentSnapshotSchema` | schema | versioned canonical engine records |
| `AgentRuntimeStore` | _type_ | aggregate CAS transaction boundary for message, run and compaction mutations |
| `RecoverAgentRunSchema` | schema | explicit abandon/requeue recovery decision; acquired runs require replay-safe evidence |
| `createMemoryAgentRuntimeStore` | function | process-local reference adapter, not production durability |
| `projectAgentHistory` | function | asynchronously project canonical records and resolved multimodal files into provider-valid AI SDK messages |
| `defineModelRegistry` | function | typed language-model descriptors, capabilities and provider construction |
| `composeAgentPrompt` | function | ordered prompt contributions and provenance-aware context budget |
| `structuredCompaction` | function | summarize a provider-valid snapshot range and replace it through CAS |
| `createAgentSessionCoordinator` | function | strict process-local queue/interrupt lifecycle |
| `AgentRuntimeStopPolicy` | _type_ | named custom AI SDK stop condition persisted and published on policy stop |
| `AgentRuntimePrepareStep` | _type_ | per-run controlled step callback with typed domain context and managed run signal/fence |
| `AgentRuntimeRecordIds` | _type_ | optional caller-provided input, run and assistant IDs for stable application records |
| `AgentRuntimeAdmission` | _type_ | actual assigned run/assistant identity and snapshot version after durable admission |
| `AgentSessionCloseOptions` | _type_ | natural `drainTimeoutMs` followed by shutdown abort and optional bounded `forceTimeoutMs` settlement wait |
| `AgentHistoryProjectionOptions` | _type_ | storage-neutral file resolver and explicit unresolved-file behavior |
| `createAgentToolFenceLifecycle` | function | pre-effect and post-effect run ownership fence for `mountAgent` |
| `AgentRuntimeEventSchema` | schema | transient delta, durable checkpoint/run-state/tool and terminal event union |
| `createAgentObservability` | function | separate agent-run sink over the shared bounded observability lifecycle |

## `stitchkit/agent-runtime/openrouter`

| Export | Kind | Summary |
|--------|------|---------|
| `openRouterProvider` | function | isolated `@openrouter/ai-sdk-provider` language-model factory |
| `OpenRouterProviderSettings` | _type_ | official provider settings accepted by the factory |

## `stitchkit/observability`

Server-only. The audit layer one level above the raw hooks — W3C trace context,
an `AsyncLocalStorage` request context, payload sanitisation and a normalised
audit event. See the [Observability guide](../guide/observability.md).

### Events

| Export | Kind | Summary |
|--------|------|---------|
| `createObservability` | function | configure framework-owned request completion and canonical tool event sinks — [guide](../guide/observability.md#createobservability) |
| `RequestEvent` | _type_ | the normalised audit event handed to the sink; opt-in HTTP cancellation rows carry `outcome: 'cancelled'` |
| `ObservabilityConfig` | _type_ | independent request and tool sink configuration |
| `Observability` | _type_ | `{ request?, toolCall, getStatus(), flush(), close() }` with bounded sink lifecycle |
| `ObservabilitySinkStatus` | _type_ | immutable counters for one bounded request/tool sink |
| `ObservabilityStatus` | _type_ | per-surface plus aggregate operational snapshot |
| `ObservabilityDrainReport` | _type_ | final closed/drained snapshot plus duration |
| `ObservabilitySinkStatusSchema` / `ObservabilityStatusSchema` / `ObservabilityDrainReportSchema` | schema | runtime schemas for status/report integration boundaries |
| `RequestEventSinkConfig` | _type_ | `write`, filter/sanitisation, `maxPending`, `onSinkError` and `onDrop` |
| `RequestObservabilityConfig` | _type_ | request sink plus opt-in payload capture and default-off `includeCancelled` rows |
| `SinkDropReason` | _type_ | `'capacity' \| 'closed'` |
| `SinkError` | _type_ | isolated sink/projection failure and optional event |
| `SinkDrop` | _type_ | rejected event, reason and current pending count |
| `HttpRequestCompletion` | _type_ | the single framework-owned HTTP outcome, including optional neutral cancellation, projected to logging and request events |
| `HttpRequestObserver` | _type_ | server-facing projection consumed by `HandlerConfig.observability` |

### Request context

| Export | Kind | Summary |
|--------|------|---------|
| `WrapRequestContextOptions` | _type_ | options for `wrapInRequestContext` |
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
| `resolvePropagationContext` | function | continue bounded MCP/W3C propagation metadata with optional ambient fallback |
| `parseTraceparent` | function | parse a `traceparent` header |
| `formatTraceparent` | function | render a `traceparent` header value |
| `createTraceContext` | function | a fresh root trace |
| `childSpan` | function | a child span of a parent trace |
| `TraceContext` | _type_ | `{ traceId, spanId, parentSpanId?, tracestate?, baggage? }` |

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

## `stitchkit/remote`

Peer-free remote implementation boundary. Importing it does not load the MCP
SDK, `ai`, or other optional tool peers, so it is safe in a thin CLI bundle.

| Export | Kind | Summary |
|--------|------|---------|
| `implementRemote` | function | bind a contract to a remote HTTP API — [guide](../guide/mcp-and-agents.md#proxying-a-remote-api--implementremote) |
| `ImplementRemoteOptions` | _type_ | optional argument-rewrite hook for `implementRemote` |

---

## `stitchkit/tools`

Server-only. Turns contracts into MCP and AI-agent tools. MCP server surfaces
need the `@modelcontextprotocol/server` v2 peer; MCP hosts/tests use the separate
`@modelcontextprotocol/client` package. Agent surfaces need the `ai` peer.

Framework-owned MCP tools advertise the exact declared output schema and return
the validated value unchanged as `structuredContent`, including arrays, scalars
and `null`. Tools without an output contract advertise and return no structured
payload.

| Export | Kind | Summary |
|--------|------|---------|
| `createMcpHandler` | function | a stateless dual-era Streamable-HTTP MCP handler — [guide](../guide/mcp-and-agents.md#mcp--createmcphandler) |
| `createMcpHttpRoute` | function | framework-owned `RawRoute` adapter for an MCP HTTP handler |
| `createStdioMcpServer` | function | a complete stdio MCP server — [guide](../guide/mcp-and-agents.md#mcp-over-stdio--createstdiomcpserver) |
| `bindStdioProcessSignals` | function | explicitly bind OS signals to one close-only stdio handle — [guide](../guide/testing-and-deployment.md#stdio-process-signals) |
| `buildMcpServer` | function | build an `McpServer` from contract/runtime surfaces; no-auth configs omit the second argument |
| `mountMcp` | function | add contract tools to an existing `McpServer` — [guide](../guide/mcp-and-agents.md#mountmcp) |
| `mountAgent` | function | a Vercel AI SDK `ToolSet` from a service — [guide](../guide/mcp-and-agents.md#ai-agents--mountagent) |
| `defineRuntimeTool` | function | define one validated pathless operation for explicit MCP, Agent and/or CLI surfaces — [guide](../guide/mcp-and-agents.md#pathless-runtime-tools-and-multimodal-results) |
| `createRuntimeToolFactory` | function | bind shared identity and Zod-validated per-call context for runtime tools — [guide](../guide/mcp-and-agents.md#pathless-runtime-tools-and-multimodal-results) |
| `createToolInvoker` | function | compile an exposure-aware in-process dispatcher over the canonical tool runner — [guide](../guide/mcp-and-agents.md#in-process-calls--createtoolinvoker) |
| `createCli` | function | a command-line program from contracts — [guide](../guide/cli.md) (also on `stitchkit/cli`) |
| `defineCliCommand` | function | define one typed CLI-only command with no fake managed-tool identity — [guide](../guide/cli.md#native-binary-commands) (also on `stitchkit/cli`) |
| `createToolkit` | function | context-typed tool mounts — [guide](../guide/cli.md#typed-context) |
| `mountViewFile` | function | a native multimodal "view file" MCP tool |
| `resolveMedia` | function | resolve a media reference for a tool result |
| `validateMcpSchemas` | function | object-shaped assertion over the exact advertised schema surface — compatibility, typed properties and portable formats ([guide](../guide/mcp-and-agents.md#mcp-schema-validation-profile)) |
| `listToolNames` | function | every contract/runtime tool name with origin, identity and transports — for stable snapshots — [guide](../guide/mcp-and-agents.md#pinning-tool-names--listtoolnames) |
| `listContractToolNames` | function | the same listing straight from contracts — no handlers or stub services needed |
| `McpHandlerConfig` | _type_ | server surface plus stateless HTTP transport config |
| `McpHttpConfig` | _type_ | HTTP auth, protected-resource, legacy-era and security options |
| `McpHttpHandler` | _type_ | framework-owned `{ fetch(request), close() }` lifecycle |
| `McpHttpSecurityConfig` | _type_ | Fetch-boundary Host and Origin allowlists |
| `McpLegacyPolicy` | _type_ | `'serve' \| 'reject'` protocol-era compatibility policy |
| `McpStdioHandle` | _type_ | closeable official stdio transport handle |
| `StdioMcpServerConfig` | _type_ | config for `createStdioMcpServer` |
| `StdioCloseTarget` | _type_ | minimal close-only target accepted by `bindStdioProcessSignals` |
| `StdioProcessSignalsOptions` | _type_ | signal source, close callbacks and phased error reporting |
| `StdioProcessSignalsBinding` | _type_ | close-only signal binding with observed `promise` and listener `close()` |
| `StdioProcessSignalsErrorPhase` | _type_ | `'prepare' \| 'close' \| 'complete'` reporting phase |
| `McpServerBuildConfig` | _type_ | shared config for `buildMcpServer` |
| `McpServerSharedConfig` | _type_ | transport-neutral options shared by direct and finite surface configs |
| `McpServer` | _type_ | official split-SDK server instance accepted by raw extension points |
| `DirectMcpSurfaceConfig` | _type_ | static or identity-dynamic `services` / `runtimeTools` source |
| `FiniteMcpSurfaceConfig` | _type_ | bounded `surfaces` registry plus typed selector |
| `McpSurfaceDefinition` | _type_ | one immutable `{ services, runtimeTools }` MCP surface |
| `McpSurfaceRegistry` | _type_ | finite keyed surface registry for eager preparation |
| `StdioAuthConfig` | _type_ | startup identity composed into `StdioMcpServerConfig` |
| `McpMountConfig` | _type_ | config for `mountMcp` |
| `McpSchemaValidationConfig` | _type_ | shared `{ policy, requireTypedProperties, allowUntyped, requirePortableFormats, allowFormats }` profile |
| `ValidateMcpSchemasConfig` | _type_ | standalone validation profile plus `services`, `extend`, flattening and logger |
| `RuntimeToolDefinition` | _type_ | transport-neutral pathless operation with identity, schemas, handler and optional presenters |
| `RuntimeToolDefinitionBase` | _type_ | common name, identity, input, exposure and MCP metadata fields |
| `RuntimeToolDefinitionWithOutput` | _type_ | runtime definition whose handler and presenters share a validated output type |
| `RuntimeToolDefinitionWithoutOutput` | _type_ | runtime definition with a void handler and no presentation callbacks |
| `RuntimeToolFactory` | _type_ | identity/context-bound runtime-tool definition factory |
| `RuntimeToolFactoryConfig` | _type_ | factory service identity and context schema |
| `RuntimeToolFactoryDefinitionWithOutput` | _type_ | factory-authored runtime tool with a validated output schema |
| `RuntimeToolFactoryDefinitionWithoutOutput` | _type_ | factory-authored void runtime tool without presenters |
| `RuntimeToolFactoryHandlerContext` | _type_ | parsed factory context plus parsed tool input |
| `RuntimeToolFactoryIdentityFields` | _type_ | per-tool action, semantic method and optional identity metadata |
| `RuntimeToolIdentity` | _type_ | `{ serviceName, action, scope?, method, meta? }` for runtime lifecycle/audit |
| `RuntimeToolHandlerContext` | _type_ | runtime context with the definition's parsed input |
| `RuntimeToolOutput` | _type_ | output inferred from a runtime tool's optional Zod schema |
| `RuntimeToolPresenters` | _type_ | optional MCP and AI SDK `toModelOutput` presentation callbacks |
| `RuntimeMcpPresentation` | _type_ | MCP content/metadata result without framework-owned `structuredContent` or `isError` |
| `RuntimeMcpInput` | _type_ | typed accepted multi-round input for an opted-in runtime tool |
| `OAuthClientRegistrationConfig` | _type_ | deterministic pre-registered → CIMD → explicit-DCR client resolution |
| `CimdClientMetadata` | _type_ | validated Client ID Metadata Document |
| `CimdClientMetadataFetcher` | _type_ | injectable secure network boundary for metadata loading |
| `CimdFetchResponse` | _type_ | bounded metadata fetch result passed across the injectable network boundary |
| `CimdFetchPolicy` | _type_ | CIMD timeout, redirect and size limits |
| `CimdCachePolicy` | _type_ | bounded HTTP-aware cache policy: separate positive/negative pools (`maxEntries`), per-client and server-wide resolution rate limits (`maxResolutionsPerClient` / `maxResolutions` per `resolutionWindowMs`) |
| `CimdCacheEvent` | _type_ | observable CIMD cache hit, miss, revalidation and eviction event |
| `createSecureClientMetadataFetcher` | function | production HTTPS, DNS/IP-pinned CIMD fetcher |
| `RuntimeAgentModelOutput` | _type_ | AI SDK model-facing text/JSON/content output returned by `present.agent` |
| `RuntimeToolTransport` | _type_ | runtime exposure: `'MCP' \| 'AGENT' \| 'CLI'`; omission still means MCP+Agent only |
| `AgentMountConfig` | _type_ | config for `mountAgent` |
| `AgentContext` | _type_ | the context merged into agent tool handlers |
| `CliConfig` | _type_ | config for `createCli` |
| `CliSurfaceSource` | _type_ | static managed surface or identity-dependent surface factory for `createCli` |
| `CliCommandDefinition` | _type_ | Zod-first CLI-only command union |
| `CliCommandDefinitionBase` | _type_ | native command name, description and input schema |
| `CliCommandDefinitionWithOutput` | _type_ | native command with declared output schema and validated handler result |
| `CliCommandDefinitionWithoutOutput` | _type_ | void native command with no output schema |
| `CliCommandContext` | _type_ | parsed native command input, global options and injected writers |
| `CliWaitConfig` | _type_ | `--wait` polling config |
| `ExitCodeMap` | _type_ | `ToolResult.code` → process exit code |
| `Toolkit` | _type_ | the context-pinned tool surface from `createToolkit` |
| `ToolExtend` | _type_ | extra-args extension for `mountMcp` / `mountAgent` |
| `ToolLifecycle` | _type_ | `beforeHandle` / `afterHandle` gate for tool calls — [guide](../guide/mcp-and-agents.md#guarding-tools--lifecycle) |
| `ToolExecutionControlReason` | _type_ | internal managed-execution stop reason: stale run or requested interruption |
| `ToolExecutionControlError` | class | control-flow error used to unwind a superseded managed tool call without presenting it as a model-facing tool failure |
| `isToolExecutionControlError` | function | narrow an unknown thrown value to the managed execution control error |
| `ToolOperation` | _type_ | executable path-free operation shape shared by contract and framework-native runners |
| `ToolCallHooks` | _type_ | object-shaped `beforeToolCall` / `afterToolCall` / `onToolError` observability hooks; the raw thrown value reaches the last two as `error` ([guide](../guide/observability.md#the-cause-behind-a-failed-tool-call)) |
| `BeforeToolCallOptions` | _type_ | `{ toolName, args, context, endpoint }` passed before execution |
| `AfterToolCallOptions` | _type_ | completed call options plus `{ result, durationMs, error? }` |
| `ToolErrorOptions` | _type_ | `{ toolName, error, context, endpoint }` for a thrown handler-path value |
| `ErrorHintFn` | _type_ | `(toolName, errorCode) => string \| null` — a per-tool recovery hint, shared by every mount |
| `ToolResult` | _type_ | the result of one tool call |
| `ToolInvoker` | _type_ | immutable compiled dispatcher (`names`, envelope `invoke`, throwing `invokeOrThrow`) |
| `ToolInvokerConfig` | _type_ | compile-time exposure, extension and presentation options |
| `ToolInvocationOptions` | _type_ | per-call source, context, lifecycle, hooks and output-strip reporter |
| `ToolInvokerTransport` | _type_ | invoker exposure policy: `MCP \| AGENT \| CLI` |
| `ToolCallContext` | _type_ | the context every tool hook receives — `{ source, mcp? }` plus whatever the mount's `context` added |
| `ViewFileOptions` | _type_ | shared URL/managed-file-boundary policy for `defineViewFileTool`, `mountViewFile` and `resolveMedia` |
| `ViewFileOutput` | _type_ | neutral managed batch result with multimodal `content` and per-item `errors` |
| `ViewFileInputSchema` | constant | fixed one-or-many media path/URL input schema |
| `ViewFileOutputSchema` | constant | Zod schema for the neutral managed view-file batch result |
| `ViewFileErrorSchema` | constant | Zod schema for one structured per-item view failure |
| `McpAnnotations` | _type_ | MCP annotations on a media result |
| `McpAnnotationsSchema` | constant | Zod schema for MCP media annotations |
| `McpMediaContentSchema` | constant | Zod schema for text/image/audio media content |
| `CollectToolsConfig` | _type_ | options for `collectTools` |
| `findUntypedProperties` | function | every property in a JSON Schema with no `type`/`enum`/`$ref` — what a model is shown and cannot obey ([guide](../guide/mcp-and-agents.md)) |
| `UntypedProperty` | _type_ | one such property — `{ path, description? }` |
| `findNonPortableFormats` | function | deep finder for formats outside the portable MCP/AJV baseline |
| `NonPortableFormat` | _type_ | one `{ path, format }` portability finding |
| `PORTABLE_JSON_SCHEMA_FORMATS` | constant | portable-format baseline used by MCP validation |
| `ToolNameEntry` | _type_ | one `listToolNames` row — `{ kind, name, service, method, transports }` |
| `IncompatibleSchemaPolicy` | _type_ | `'throw' \| 'skip' \| 'warn'` |
| `McpMediaContent` | _type_ | a multimodal MCP content item |

### Native tools

Generic host-supplied operations — managed definitions for the canonical
runtime-tool runner, plus deliberate raw MCP adapters over the same mechanics.

| Export | Kind | Summary |
|--------|------|---------|
| `defineDownloadTool` | function | define a guarded, size-capped managed download for MCP/Agent `runtimeTools` |
| `defineUploadTool` | function | define a typed managed local-file upload for MCP/Agent `runtimeTools` |
| `defineWaitTool` | function | define a typed, cancellable managed polling operation for MCP/Agent `runtimeTools` |
| `defineViewFileTool` | function | define a guarded, batch-capped managed multimodal operation for MCP/Agent `runtimeTools` |
| `DefineDownloadToolConfig` | _type_ | Zod input, stable identity, URL resolver, storage policy and presenters for `defineDownloadTool` |
| `DefineUploadToolConfig` | _type_ | stable identity, typed output, upload callback and presenters for `defineUploadTool` |
| `DefineWaitToolConfig` | _type_ | Zod input/state, identity, poll/done/timeout policy and presenters for `defineWaitTool` |
| `DefineViewFileToolConfig` | _type_ | identity, media security policy and optional presenters for `defineViewFileTool` |
| `ManagedNativeToolConfig` | _type_ | shared name, description, identity, exposure and annotations for managed native factories |
| `NativeToolIdentity` | _type_ | pathless service/action/scope/meta identity; semantic method is factory-owned |
| `ManagedWaitRender` | _type_ | optional managed wait terminal text and failure classification |
| `UploadToolInputSchema` | constant | fixed `{ path: string }` input schema for `defineUploadTool` |
| `defineAsyncOperation` | function | runtime-only start/status/wait plus configured cancel/result/artifacts definitions |
| `defineAsyncOperationContract` | function | define one canonical Zod-first HTTP contract for start/status/wait plus optional capabilities |
| `bindContractAsyncOperation` | function | bind literal methods from an existing contract without creating another HTTP surface |
| `createAsyncOperationSnapshotSchema` | function | canonical pending/running/succeeded/failed/cancelled Zod snapshot |
| `AsyncOperationCancelResultSchema` | constant | validated accepted/already_terminal/rejected cancellation result |
| `AsyncOperationCancelResult` | _type_ | validated cancel capability result |
| `AsyncOperationCancelCapability` | _type_ | optional typed domain cancellation callback |
| `AsyncOperationCapability` | _type_ | generated capability-name union |
| `AsyncOperationStartDefinition` / `AsyncOperationFollowDefinition` | _type_ | generated runtime definition types |
| `AsyncOperationIdentity` | _type_ | shared service/action/scope/meta identity for an operation |
| `AsyncOperationOutputCapability` | _type_ | optional result/artifact schema plus handler |
| `RuntimeAsyncOperationConfig` | _type_ | runtime-only descriptor configuration |
| `RuntimeAsyncOperation` | _type_ | inferred generated definitions and schemas |
| `AsyncOperationContractConfig` | _type_ | canonical contract config where start returns the operation id |
| `AsyncOperationContractWithStartOutputConfig` | _type_ | canonical contract config with an application start envelope and typed id extractor |
| `DefinedAsyncOperationContract` | _type_ | generated contract, capability keys, schemas and parsed adapters |
| `ContractAsyncOperationConfig` | _type_ | literal contract method binding and handlers |
| `AdaptedContractAsyncOperationConfig` | _type_ | existing-contract binding with explicit id and per-capability input adapters |
| `BoundAdaptedContractAsyncOperation` | _type_ | inferred adapted binding with parsed id/input projectors |
| `AdaptedContractAsyncOperationStartKey` | _type_ | existing-contract keys with a declared start output |
| `AdaptedContractAsyncOperationFollowKey` | _type_ | existing-contract keys with both input and output schemas |
| `AdaptedContractAsyncOperationWaitKey` | _type_ | adapted follow-up keys whose output matches the selected status snapshot |
| `ContractAsyncOperationInputAdapters` | _type_ | guaranteed direct-binding status/wait input adapters plus configured optional capabilities |
| `ContractAsyncOperationKeys` | _type_ | literal method-key union of a bound contract |
| `ContractAsyncOperationStartKey` | _type_ | direct-binding start keys whose declared ID schema has stable input/output |
| `ContractAsyncOperationFollowKey` | _type_ | contract keys whose input schema type matches the selected start output |
| `ContractAsyncOperationWaitKey` | _type_ | follow-up keys whose output schema type also matches the selected status output |
| `composeToolLifecycle` | function | ordered composition of tool before/after phases |
| `mountDownload` | function | raw MCP "download a URL to disk" adapter (SSRF-guarded, size-capped) |
| `mountUpload` | function | raw MCP "upload a local file" adapter |
| `mountWait` | function | raw MCP generic `--wait`-style polling adapter |
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
| `summarizeTransports` | function | mixed contract/runtime operation counts and per-source breakdown for a boot-time summary |
| `buildToolManifest` | function | transport-aware searchable `{ name, description, inputSchema }` rows from a mixed surface |
| `ToolLoggerConfig` | _type_ | config for `createToolLogger` |
| `ToolCallRecord` | _type_ | the structured record `createToolLogger` passes to `onRecord` |
| `TransportSummary` | _type_ | `{ contractServices, runtimeTools, totals, sources }` from `summarizeTransports` |
| `TransportCounts` | _type_ | per-transport counts (`{ HTTP, MCP, AGENT, CLI }`) |
| `ToolSurfaceDefinition` | _type_ | shared object-shaped `{ services?, runtimeTools? }` introspection surface |
| `ToolSurfaceTransport` | _type_ | tool collector transport: `'MCP' \| 'AGENT' \| 'CLI'` |
| `ToolManifestConfig` | _type_ | mixed surface plus required model-facing `transport` and presentation options |
| `coerceJsonArgs` | function | coerce JSON-stringified array/object tool arguments |
| `flattenToolJsonSchema` | function | project structurally identifiable discriminated unions into conservative object joins; divergent fields retain every provable base kind in a deterministic `type` array, and the projection never executes validation |
| `ToolPresentationSchema` | _type_ | immutable model-facing JSON Schema document shared by tool transports |
| `MountableTool` | _type_ | one operation with separate executable CLI argument schema and model-facing presentation schema |
| `ToolManifestEntry` | _type_ | one `buildToolManifest` row |

---

## `stitchkit/testing`

Fetch-only integration helpers that preserve the real generated-client and
handler pipeline without opening a TCP port.

| Export | Kind | Summary |
|--------|------|---------|
| `createHandlerTestClient` | function | one contract client backed by an in-process `FetchHandler` |
| `createHandlerTestClients` | function | exact contract-registry batch form |
| `HandlerTestClientDefaults` | _type_ | ordinary bare-client defaults with handler-owned `baseUrl` and `fetch` removed |
| `HandlerTestClientConfig` | _type_ | handler, contract, path prefix, scoped config and client request defaults |
| `HandlerTestClientsConfig` | _type_ | batch helper configuration |
| `HandlerTestTransportConfig` | _type_ | shared in-process handler, origin, prefix, client defaults and optional server handle |
| `buildSurfaceManifest` | function | deterministic manifest v2 with HTTP topology, transport-specific tool projections, named MCP surfaces and realtime schema digests |
| `assertSurfaceManifestSnapshot` | function | bounded deterministic manifest drift assertion |
| `assertSurfaceDiscovery` | function | compare real OpenAPI/tool/realtime caller-observed discovery to the exact manifest projection |
| `runSurfaceProbes` | function | execute explicit transport drivers under one per-scenario setup/invoke/teardown deadline |
| `defineRealtimeProbe` | function | declare one canonical realtime scenario for a caller-supplied real transport driver |
| `createRealtimeProbeDriver` | function | bind each scenario to a caller-owned transport and normalize actual event/ack/rejection/disconnect outcomes without lifecycle ownership |
| `TransportObservationSchema` | constant | normalized HTTP/tool/realtime outcome including rejection fields and handler-call evidence |
| `RealtimeRejectionObservationSchema` | constant | direction/phase/reason/fault observation for a rejected realtime event |
| `RealtimeDisconnectObservationSchema` | constant | observed before-invoke versus in-flight disconnect phase |
| `ConformanceTransport` | _type_ | explicit probe transport union |
| `RunSurfaceProbesConfig` | _type_ | probes, drivers and diagnostic byte cap |
| `SurfaceDiscoveryObservation` | _type_ | real OpenAPI/tool/CLI/extension discovery values |
| `SurfaceToolDiscoveryObservation` | _type_ | transport, optional named surface and caller-observed tool names |
| `SurfaceRealtimeDiscoveryObservation` | _type_ | caller-observed server→client and client→server event names |
| `SurfaceProbe` / `SurfaceProbeDriver` | _type_ | one bounded scenario and its consumer-supplied runner |
| `DefineRealtimeProbeConfig` | _type_ | name, canonical scenario, explicit fixture and expected realtime outcome |
| `CreateRealtimeProbeDriverConfig` | _type_ | per-scenario foreign-transport binder and optional handler-call counter |
| `RealtimeProbeAdapter` | _type_ | connected-state observation, scenario invocation and subscription-only cleanup |
| `RealtimeProbeFixture` / `RealtimeProbeScenario` | _type_ | driver input and supported event/ack/invalid/disconnect/timeout scenario vocabulary |
| `RealtimeRejectionObservation` | _type_ | parsed structured realtime rejection observation |
| `RealtimeDisconnectObservation` | _type_ | normalized physical timing of a realtime disconnect |
| `TransportObservation` | _type_ | validated normalized driver result |
| `SurfaceManifest` / `SurfaceManifestConfig` | _type_ | deterministic surface snapshot and its inputs |
| `SurfaceManifestOperation` / `SurfaceManifestOperationSchema` | _type_ / schema | one contract or runtime operation row |
| `SurfaceManifestTool` / `SurfaceManifestToolSchema` | _type_ / schema | one mounted tool row with advertised input digest |
| `SurfaceManifestToolSurface` / `SurfaceManifestToolSurfaceSchema` | _type_ / schema | one static transport projection, optionally keyed for a finite MCP surface |
| `SurfaceManifestRealtimeEvent` / `SurfaceManifestRealtimeEventSchema` | _type_ / schema | one named directional realtime event with input/output args and ack digests |
| `SurfaceManifestExtension` / `SurfaceManifestExtensionSchema` | _type_ / schema | declared transport extension row |
| `SurfaceManifestSchema` | schema | complete deterministic manifest schema |
| `SurfaceToolDefinition` | _type_ | plain service/runtime selection used by CLI and finite named MCP surfaces |
| `SurfaceAgentProjection` | _type_ | Agent selection plus its reachable extend/flatten presentation policy |
| `SurfaceMcpPreparation` | _type_ | one global MCP extend/flatten/schema-validation/multi-round preparation policy |
| `SurfaceRuntimeToolDefinition` | _type_ | peer-free non-executable runtime-operation descriptor for manifest projection |
| `SurfaceToolExtension` | _type_ | canonical structural tool extension including schema, resolver and optional filter |
| `McpSchemaValidationConfig` / `IncompatibleSchemaPolicy` | _type_ | canonical MCP schema-preparation policy used by real mounts and manifests |
| `SurfaceRealtimeSchemaPairSchema` | schema | input/output digest pair for args or acknowledgements |
| `SurfaceSchemaDigestsSchema` | schema | params/input/output/multipart digest object |
| `serializeSurfaceValue` | function | canonical versioned serialization used for deterministic digests |

---

## `stitchkit/files`

Peer-free Bun/Node filesystem capability. Browser/contract-safe refs are also
available from `stitchkit/contract`.

| Export | Kind | Summary |
|--------|------|---------|
| `createManagedFileBoundary` | function | bind an application-owned root, optionally creating one final directory under a trusted existing parent |
| `ManagedFileBoundary` | _type_ | non-reopenable `read`/`write` capability over canonical relative paths |
| `ManagedFileBoundaryConfig` | _type_ | bound root, optional `createRoot`, finite read/write/inspection limits, inspector and cleanup observer |
| `ManagedFileRefSchema` / `ManagedFileRef` | schema / _type_ | transport-safe relative path, measured size and optional media metadata |
| `ManagedFilePathSchema` / `ManagedFilePath` | schema / _type_ | canonical POSIX relative managed-file path |
| `ManagedFileSource` | _type_ | bounded immutable bytes plus validated ref passed to upload callbacks |
| `ManagedFileReadOptions` / `ManagedFileWriteOptions` | _type_ | per-operation byte cap, signal and atomic write policy |
| `ManagedFileError` / `ManagedFileErrorCode` | class / _type_ | stable boundary failures; registered `FILE_*` mistakes are caller-safe while `FILE_IO_ERROR` remains internal |
| `ManagedFileInspector` | _type_ | bounded-prefix read/write inspection callback with a finite cancellation signal that cannot own path or size |
| `ManagedFileInspectionInput` / `ManagedFileInspection` | _type_ | inspector prefix/name/declared media/signal input and validated metadata-only result |

---

## `stitchkit/node`

Server-only, for Node ≥ 22 (Bun uses `stitchkit/server`). The runtime-agnostic
core plus a Node HTTP adapter — [ADR 0013](../decisions/0013-runtime-agnostic-core.md),
[deployment guide](../guide/testing-and-deployment.md#deploy-on-node). Re-exports the
runtime-agnostic pieces of `stitchkit/server` and the error helpers.

| Export | Kind | Summary |
|--------|------|---------|
| `serveNode` | function | build the router and start a Node HTTP server (via `srvx`) |
| `createHandler` | function | the router as a bare `(req) => Response` (same as `/server`) |
| `createSocketIOServer` | function | the typed Node Socket.IO server (`io` + `attach`; no Bun engine declarations) |
| `implement` / `createImplement` / `createScopedImplement` / `createScopedImplementRegistry` / `createMultipartStream` | function | bind a contract to typed handlers, optionally typed per endpoint scope (same as `/server`) |
| `NodeServerConfig` | _type_ | config for `serveNode` |
| `NodeServerHandle` | _type_ | managed Node handle (`url`, `port`, `runtime`, `status`, `shutdown`) |
| `NodeRuntimeServer` | _type_ | concrete `srvx/node` runtime escape hatch |
| `NodeSocketLifecycle` | _type_ | Bun-free Socket.IO lifecycle accepted by `serveNode` |
| `HandlerConfig` / `ServiceDef` / `RawRoute` / `RawRouteContext` | _type_ | runtime-neutral handler types; raw routes default their host server to `unknown` |
| `SocketIORequestPolicy` / `SocketIOServerConfig` / `SocketIOServerHandle` | _type_ | runtime-neutral handshake policy, config and Bun-free Node handle with `io`, `attach` and lifecycle |
| `AppError` + `appError` / `badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `rateLimited` | — | error helpers (same as `/contract`) |

---

## `stitchkit/cli`

Server-only. Composes contract/runtime managed operations and CLI-only native
commands into one command-line program. Light by design: needs neither the MCP
SDK nor the `ai` peer.

| Export | Kind | Summary |
|--------|------|---------|
| `createCli` | function | build and run a CLI from contracts — [guide](../guide/cli.md) |
| `defineCliCommand` | function | define one Zod-typed CLI-only executable command |
| `parseCliArgs` | function | argv → typed tool args against a schema (advanced) |
| `pollUntilDone` | function | the generic `--wait` poller (advanced) |
| `emitResult` | function | write a pretty or compact `ToolResult` record to stdout/stderr + exit code (advanced) |
| `DEFAULT_EXIT_CODES` | const | the default `ToolResult.code` → exit-code map |
| `CliConfig` | _type_ | config for `createCli` |
| `CliSurfaceSource` | _type_ | static service/runtime array or identity-dependent factory |
| `CliCommandDefinition` | _type_ | native command definition union |
| `CliCommandDefinitionBase` | _type_ | native command name, description and input schema |
| `CliCommandDefinitionWithOutput` | _type_ | native command with validated declared output |
| `CliCommandDefinitionWithoutOutput` | _type_ | native void command without an output contract |
| `CliCommandContext` | _type_ | parsed input, global options and stdout/stderr writers |
| `CliRunOptions` | _type_ | parsed global flags (`--json` compacts success/error records, `--wait`, …) |
| `ParsedCliArgs` | _type_ | result of `parseCliArgs` |
| `CliWaitConfig` | _type_ | per-command `--wait` polling config; optional `failed(result)` maps a terminal domain failure to `WAIT_FAILED` and a non-zero exit |
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
| `EntityCacheEvent` | _type_ | discriminated created/updated/deleted input for dynamic cache keys |
| `EntityCacheKey` | _type_ | static `QueryKey` or event-aware key factory |
| `EntityCacheListConfig` | _type_ | list shape, scoped key, insertion/missing-update policy and comparator |
| `EntityCacheListShape` | _type_ | `array \| paginated \| infinite-array \| infinite-paginated` |
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
