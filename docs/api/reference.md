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
| `ClientFetch` | _type_ | injectable Fetch-compatible transport used by framework and application-owned adapters |
| `ClientRequestOptions` | _type_ | per-call `{ signal?: AbortSignal }` passed through an endpoint callable's `.withOptions(...)`; caller abort is distinct from timeout — [guide](../guide/client.md#per-call-cancellation) |
| `ContractClientConfig` | _type_ | per-tenant / resource-scoped client config — dynamic `pathPrefix` + `stripPrefixKeys` ([guide](../guide/client.md#contractclientconfig--per-tenant--resource-scoped-clients)) |
| `contractEndpointMatchers` | function | compile exact pathname matchers for selected HTTP contract operations and expected-401 policy |
| `PathPrefixArgs` | _type_ | required string-valued keys exposed to a typed dynamic `pathPrefix` callback |
| `createHttpClient` | function | the Ky-based HTTP transport; on Next.js SSR its first attempt stays request-memoizable while every retry is a distinct transport attempt — [guide](../guide/client.md#createhttpclient) |
| `ApiError` | class | a non-2xx or client failure, with `code` / `status` / `details` / `hint`, optional readonly `traceId` from `x-request-id`, and standard `cause` preserving an injected transport failure |
| `HttpClient` | _type_ | the transport interface `createClient` builds on |
| `ConfiguredHttpClient` | _type_ | a framework-created `HttpClient` carrying its readonly `baseUrl` for URL builders |
| `HttpClientConfig` | _type_ | config for `createHttpClient`; retry `limit` counts retries after the initial attempt (default 2 = at most 3 GET attempts), with `statusCodes: []` by default; `fetch` installs an explicit transport and is mutually exclusive with the legacy Bun-only `unix` option — [details](../guide/client.md#createhttpclient) |
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
| `createLiveStateController` | function | keep typed application state current across one source-owned snapshot/event generation with finite pre-snapshot buffering, generation fencing and explicit resync — [guide](../guide/realtime.md#snapshot--event-state-synchronization) |
| `LiveStateController` | _type_ | renderer-neutral `start` / `resync` / `getSnapshot` / `subscribe` / `close` handle |
| `LiveStateControllerConfig` | _type_ | typed source, reducer, explicit event/byte bounds, event sizing and isolated error hooks |
| `LiveStateControllerSnapshot` / `LiveStateControllerStatus` | _types_ | current value plus phase, generation, buffer and application/duplicate/gap/refusal counters |
| `LiveStateControllerStatusSchema` | schema | strict runtime validation for controller status metadata |
| `LiveStatePhaseSchema` / `LiveStatePhase` | schema / _type_ | `idle`, `opening`, `live`, `resync-required`, `unavailable` or `closed` |
| `LiveStateStopReasonSchema` / `LiveStateStopReason` | schema / _type_ | explicit gap, overflow, source loss, controller failure and bounded `controller-capacity` reasons |
| `LiveStateEventDecision` | _type_ | provider-owned reducer result: applied state, duplicate or gap |
| `LiveStateSource` / `LiveStateSourceOpenInput` / `LiveStateSourceOpenResult` | _types_ | host binding for one continuous snapshot/event boundary; transport retry and cursor semantics remain host-owned |
| `LiveStateControllerError` / `LiveStateSubscriberError` | _types_ | isolated observer failure payloads that do not change source or subscriber truth |
| `createRetainedTopics` | function | retained last-value store for sticky events — [guide](../guide/realtime.md#sticky-events) |
| `parseSSE` | function | parse an SSE `Response` into an async generator — [guide](../guide/client.md#sse) |
| `parseNDJSON` | function | parse bounded fatal-UTF-8 NDJSON; blank keep-alives are skipped and `finalLine: 'require-newline'` can make the delimiter mandatory — [guide](../guide/client.md#ndjson) |
| `resumableIterator` | function | re-open a long-lived stream from the last delivered cursor, with jittered backoff, a caller-owned terminal item and prompt abort — [guide](../guide/client.md#resumable-streams) |
| `createBackoff` | function | exponential backoff with subtractive jitter as a value: `next()` / `reset()` |
| `ContractStreamFrameSchema` / `ContractStreamFrame` | schema / _type_ | default on-the-wire `data` / safe `error` / `end` envelope of a contract-first stream |
| `ContractStreamFraming` / `ContractStreamCompletion` | _types_ | opt-in item-vs-envelope framing and terminal-vs-stream-end completion policies |
| `StreamFinalLinePolicy` | _type_ | permissive or newline-required final NDJSON line policy |
| `DEFAULT_CONTRACT_STREAM_FRAME_BYTES` | const | default maximum encoded contract-stream frame: 256 KiB |
| `SocketIOClient` | _type_ | low-level client handle; `emit` reports disconnected drops and `emitWithAck` exposes the native Promise primitive used by validated `request()` |
| `SocketIOClientPeerLoaders` | _type_ | inject `socket.io-client` so a bundler can put it in a self-contained artifact |
| `SocketIOClientConfig` | _type_ | config for `createSocketIOClient` (incl. `retain`, `onConnectError`, `onDroppedEmit`) |
| `SocketEventMap` | _type_ | the shape of an event map |
| `RealtimeClient` | _type_ | validated client inferred from a realtime contract |
| `RealtimeClientOptions` | _type_ | transport options plus rejected-event and metadata-only acknowledged-request phase hooks for `createRealtimeClient` |
| `BoundRealtimeClient` | _type_ | validated non-owning `on`/`emit`/`request` client with no `connect`/`disconnect` |
| `RealtimeClientTransport` | _type_ | minimal existing transport capability accepted by `bindRealtimeClient` |
| `BindRealtimeClientOptions` | _type_ | rejection/logger options for a bound existing transport |
| `RealtimeAcknowledgedEvent` | _type_ | event-name union restricted to definitions with an `ack` schema |
| `RealtimeAcknowledgement` | _type_ | validated acknowledgement output inferred from an event definition |
| `RealtimeRequestArguments` | _type_ | request arguments inferred from an acknowledged event tuple |
| `RealtimeRequestOptions` | _type_ | finite positive native acknowledgement `timeoutMs` plus an optional invocation-scoped `onPhase` observer |
| `RealtimeRequestPhaseSchema` / `RealtimeRequestPhase` | schema / _type_ | closed `engine-handoff` / `engine-ack-received` / `settled` / `timeout` / `disconnected` lifecycle |
| `RealtimeRequestPhaseEventSchema` / `RealtimeRequestPhaseEvent` | schema / _type_ | strict metadata-only `{ requestId, event, phase, elapsedMs }` observation |
| `RealtimeRequestPhaseHook` | _type_ | isolated sync/async observer accepted globally by `RealtimeClientOptions.onRequestPhase` or per invocation by `RealtimeRequestOptions.onPhase` |
| `RealtimeRequestTimeoutError` | class | stable `REALTIME_REQUEST_TIMEOUT` rejection |
| `RealtimeRequestDisconnectedError` | class | stable `REALTIME_REQUEST_DISCONNECTED` rejection, including an immediate disconnected call |
| `RealtimeRequestInvalidAcknowledgementError` | class | invalid ack was reported through `onRejected` and the request rejected |
| `RealtimeRequestRejectedError` | class | the peer refused the frame against its own contract and said so — `reason`, `issues` — instead of leaving the sender to time out ([ADR 0106](../decisions/0106-a-refused-frame-answers-its-sender.md)) |
| `REALTIME_REJECTION_KEY` | const | the reserved acknowledgement key a refusal travels under |
| `RealtimeRejectionEnvelope` | _type_ | the wire shape of a refusal |
| `RealtimeRejectionReport` | _type_ | what the sender is told: event, reason, message, issues |
| `RealtimeRejectionIssue` | _type_ | one refused field, already flattened (`path: '0.v'`) |
| `asRealtimeRejection` | function | recognise a refusal in an acknowledgement value, validating it |
| `RealtimeContract` | _type_ | shared server-to-client and client-to-server event registries |
| `RealtimeEventRegistry` | _type_ | string-keyed registry of event definitions |
| `RealtimeEventDefinition` | _type_ | one tuple-shaped event and optional acknowledgement schema |
| `RealtimeEventArguments` | _type_ | tuple inferred from an event definition |
| `RealtimeEmitArguments` | _type_ | emit arguments including an inferred acknowledgement callback |
| `RealtimeEventHandler` | _type_ | handler inferred from an event definition |
| `InferRealtimeEventMap` | _type_ | inferred Socket.IO-compatible event map |
| `RealtimeRejectDirection` / `RealtimeRejectPhase` / `RealtimeRejectReason` / `RealtimeRejectFault` | _types_ | canonical inferred rejection direction, validation phase, reason and fault classification |
| `RealtimeRejectedEvent` | _type_ | structured rejected event with event, direction, phase, reason and fault |
| `RealtimeRejectedEventHook` | _type_ | sync/async observer for structured realtime rejections |
| `ValidatedRealtimeSocket` | _type_ | runtime-validating `on`/`emit` surface inferred from registries; `emit` returns "accepted by the transport" (`false` only for a client-side disconnected drop) |
| `RetainedTopics` | _type_ | the `createRetainedTopics` handle |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |
| `ParseNDJSONOptions` | _type_ | options for `parseNDJSON` |
| `BackoffPolicySchema` / `BackoffPolicy` | schema / _type_ | `minDelayMs`, `maxDelayMs` and a `0`–`1` jitter fraction; a ceiling below the floor is refused |
| `Backoff` | _type_ | the backoff handle returned by `createBackoff` |
| `ResumableIteratorConfig` | _type_ | caller-owned `open` / `advance` / `isTerminal`, retry policy, abort signal and `onAttempt` observer |
| `ResumableAttempt` | _type_ | attempt number, the delay about to be waited and the error that caused it |

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
| `EndpointStreamDescriptor` | _type_ | HTTP-only schema-derived stream declaration: item schema, envelope/item framing, stream-end/terminal completion, NDJSON/SSE encoding and frame/lifetime/heartbeat/idle bounds — [guide](../guide/server.md#contract-first-streams) |
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

## `stitchkit/primitives`

Browser-and-server-safe declarations for facts an application wants to define once. See the
[primitives guide](../guide/primitives.md). Storage, transactions, data-adapter predicates,
schedules, transports and file generation remain application-owned.

| Export | Kind | Summary |
|--------|------|---------|
| `defineLifecycle` | function | immutable finite-state transition declaration, role/payload validation, available-action projection and transition event |
| `LifecycleState` / `LifecycleTransitionDefinition` / `LifecycleDefinition` | _types_ | branded state value and the declaration inferred from application strings |
| `LifecycleTransitionInput` / `LifecycleTransitionResult` / `LifecycleTransitionSuccess` / `LifecycleTransitionFailure` | _types_ | typed execution input and distinct transition/state, role and payload outcomes |
| `LifecycleTransitionEventSchema` / `LifecycleTransitionEvent` | schema / _type_ | canonical event returned for application-atomic persistence |
| `defineOwnerScope` | function | resolve one owner from identity or require the explicit `acrossAllOwners` capability |
| `OwnerScope` / `OwnerScopeDefinition` / `OwnerScopeResolution` | _types_ | branded adapter input and its resolved/refused outcomes |
| `definePermissionMatrix` | function | exhaustive role × operation decisions with server check and client capability projection |
| `PermissionGrantMatrix` / `PermissionCheckResult` | _types_ | compile-time complete matrix and unknown/allowed/denied runtime result |
| `defineMoney` / `createMoneySchema` | functions | fixed-currency JSON-safe minor-unit value and Zod schema |
| `addMoney` / `subtractMoney` / `multiplyMoney` / `shareMoney` / `splitMoney` | functions | exact same-currency arithmetic with explicit indivisible remainder |
| `Money` / `MoneyShare` / `MoneySplit` | _types_ | currency-literal value and remainder-bearing operation results |
| `defineUnitSystem` / `createQuantitySchema` / `addQuantity` | functions | exact decimal quantities and caller-declared finite conversions |
| `Quantity` / `UnitConversion` / `QuantityProjection` | _types_ | unit-literal value, rational conversion and recorded/derived provenance |
| `QuantityProjectionSchema` | schema | transport-safe recorded/derived quantity union |
| `defineDeadlinePolicy` | function | elapsed- or calendar-day projection with explicit timezone, threshold, current time and caller category keys |
| `DeadlineResultSchema` / `DeadlineResult` | schema / _type_ | due instant, remaining/overdue days and projected category |
| `audit` | constant | constructors for explicit `record(changeSchema)` or `omit(reason)` endpoint metadata |
| `assertAuditDeclared` | function | refuse a contract operation with no audit decision |
| `createAuditRecord` | function | validate one declared change and return the canonical event value |
| `AuditPolicy` / `AuditRecordPolicy` / `AuditOmitPolicy` / `CreateAuditRecordInput` | _types_ | audit declaration and record input contracts |
| `AuditRecordSchema` / `AuditRecord` | schema / _type_ | domain-event-shaped audit record |
| `createDomainEventSchema` | function | wrap a typed payload in the canonical event envelope |
| `DomainEventSchema` / `DomainEvent` | schema / _type_ | generic event with stable id, time, subject and optional actor |
| `DomainEventActorSchema` / `DomainEventActor` | schema / _type_ | structured actor identity and application role |
| `DomainEventSubjectSchema` / `DomainEventSubject` | schema / _type_ | generic subject type/id pair |
| `defineDomainEventDelivery` | function | plan routes and dispatch only application-outbox claims by committed event id |
| `DomainEventDestinationSchema` / `DomainEventDestination` | schema / _type_ | transport-neutral destination identity |
| `DomainEventDeliveryOutcomeSchema` / `DomainEventDeliveryOutcome` | schema / _type_ | delivered, retryable, terminal or unknown transport result |
| `DomainEventDeliveryClaimSchema` / `DomainEventDeliveryClaim` | schema / _type_ | application-owned atomic outbox claim |
| `DomainEventOutbox` / `DomainEventRoute` / `DomainEventTransport` | _types_ | host capabilities composed by process-local delivery |
| `DomainEventDeliveryPlan` / `DomainEventDispatchResult` | _types_ | transaction input and bounded dispatch summary |
| `defineExportOperation` / `createExportResultSchema` | functions | one typed contract operation returning a ready managed file or pending operation id |
| `scanMoneyNumberRisks` / `scanOwnerFilterRisks` | functions | source-text migration diagnostics with caller-owned identifiers |
| `SourceText` / `SourceRisk` | _types_ | migration scanner input and exact path/line evidence |

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
| `ShutdownOptionsSchema` / `ShutdownOptions` | schema / _type_ | HTTP/application grace, a separate WebSocket close-handshake bound, bounded forced-completion timeout, retry hint and optional external abort signal |
| `ShutdownStatusSchema` / `ShutdownStatus` | schema / _type_ | live state and request/WebSocket counters; owned streams remain pending through source cleanup |
| `ShutdownResultSchema` / `ShutdownResult` | schema / _type_ | clean/forced result with final counters, outer-force snapshots and `forcedWebSockets` including bounded realtime terminations |
| `ShutdownStateSchema` / `ShutdownState` | schema / _type_ | managed lifecycle state machine |
| `ServiceDef` | _type_ | the result of `implement` |
| `MethodDef` | _type_ | one resolved endpoint inside a service |
| `OperationIdentity` | _type_ | path-free service/action/scope/method identity shared by contract and native tool operations |
| `Handlers` | _type_ | the typed handler map `implement` expects |
| `LifecycleHooks` | _type_ | `onRequest` / pre-body `authorize` / `beforeHandle` / `afterHandle` / `onError` |
| `composeLifecycleHooks` | function | compose HTTP lifecycle phases in declaration order with short-circuit/fallthrough semantics |
| `AuthorizationContext` | _type_ | HTTP pre-body context with validated params, `input: undefined` and no files |
| `RouteGroup` | _type_ | a prefixed group of services with its own hooks; matched errors try group `onError` → global `onError` → standard envelope, keeping the original error on fallback — [precedence](../guide/server.md#lifecycle-hooks) |
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
| `ErrorHookConfig` | _type_ | async observer/renderer config with partial `codeMap` and optional typed `unmappedCode` fallback |
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
| `SocketIOPeerLoaders` | _type_ | `peers: { server, bunEngine }` — literal dynamic imports written in YOUR source, so a bundler puts the optional peers inside a self-contained artifact. Omit for the lazy default |
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
| `streamingRoute` | function | a long-lived subscription route: idle timeout, heartbeat, opening flush, cancellation — [guide](../guide/server.md#long-lived-subscriptions) |
| `ndjsonRoute` | function | `streamingRoute` framed as NDJSON |
| `sseRoute` | function | `streamingRoute` framed as SSE |
| `DEFAULT_STREAM_HEARTBEAT_MS` | const | 5000 — deliberately well under Bun's ten-second idle threshold |
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
| `isPublicIp` | function | whether an address belongs to the public internet; anything unparseable is not |
| `resolveSocketIp` | function | the caller IP for a Socket.IO handshake (proxy-aware) |
| `getClientInfo` | function | caller IP + user-agent |
| `EventBus` | _type_ | the `createEventBus` handle |
| `RateLimitConfig` | _type_ | config for `createRateLimiter` |
| `ClientIpOptions` | _type_ | trusted-proxy config for `extractIp` / `resolveSocketIp` |
| `ParseSSEOptions` | _type_ | options for `parseSSE` |
| `StreamingRouteOptions` | _type_ | options for `streamingRoute` / `ndjsonRoute` / `sseRoute` |
| `StreamingSourceContext` | _type_ | what a streaming source is given, including the cancellation `signal` |
| `StreamingFormat` | _type_ | `'ndjson' \| 'sse'` |
| `createUnixClientTransport` | function | owned Fetch-compatible Unix-socket transport on Bun and Node; every redirect stays on the socket — [guide](../guide/client.md#unix-domain-sockets) |
| `UnixClientTransportConfig` | _type_ | absolute socket path plus request/header/connection/redirect bounds and an explicit bounded-or-streaming response policy |
| `UnixClientTransport` | _type_ | `{ fetch, closed, close() }`; `close()` settles owned active work |
| `UnixResponseBodyMode` | _type_ | `bounded \| streaming`; bounded is the 16 MiB cumulative default, streaming keeps pull-driven buffering without a lifetime total |
| `UnixClientTransportError` | class | stable transport failure with `code` and dispatch certainty in `delivery` |
| `UnixClientTransportErrorCode` | _type_ | finite Unix transport failure-code union |
| `UnixClientDeliveryState` | _type_ | `not-dispatched \| possibly-dispatched \| response-received`; input to application retry policy, never an implicit retry |

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

## `stitchkit/application`

Server-only process-local application composition. See the
[application kernel guide](../guide/application-kernel.md) and
[architecture](../architecture/application-kernel.md). Complete consumer
cutovers are covered by the executable
[migration recipes](../guide/application-migration-recipes.md).

### Kernel and resources

| Export | Kind | Summary |
|--------|------|---------|
| `createApplication` | function | compose a validated resource DAG into one non-restartable startup, readiness, admission and shutdown state machine |
| `ApplicationResourceFailure` | _type_ | one resource failure with the cause its phase label cannot carry — delivered to `onResourceFailure` |
| `ApplicationResourcePhase` | _type_ | the phase a managed resource failed in — the vocabulary of `ApplicationResourceShutdown.failures` |
| `ApplicationShutdownOptionsSchema` / `ApplicationShutdownOptions` | schema / _type_ | the two shutdown budgets and an abort signal — without the HTTP-only `retryAfterSeconds` |
| `ApplicationShutdownBudgetSchema` / `ApplicationShutdownBudget` | schema / _type_ | the same two budgets without a signal — `ApplicationConfig.shutdown`, the default for `shutdown()` and the only budget a failed startup's rollback can read |
| `ActivityTokenBrand` | const | the brand symbol `ActivityToken` carries, exported so `ActivityProjection` is implementable |
| `defineManagedResource` | function | retain the exact typed resource declaration; every invoked start is rollback-eligible |
| `managedServerResource` | function | own a managed server's lifecycle without copying its HTTP/WebSocket shutdown machine — a thunk is called during `start`, and the handle is published to dependants |
| `managedResourceDependencyId` | function | the id of a dependency declared either as a string or as the resource itself |
| `createApplicationHealthHandler` | function | build a Fetch-clean liveness or readiness response from the sanitized application snapshot |
| `createApplicationOperationalHandlers` | function | compose always-readable status plus the canonical readiness/liveness handlers |
| `ApplicationAdmissionError` | class | stable `APPLICATION_NOT_ACCEPTING` rejection from `admission.run(...)` |
| `ApplicationConfig` / `ApplicationHandle` | _type_ | application declaration and its start/snapshot/subscription/admission/shutdown handle |
| `ApplicationAdmission` / `ApplicationOperationLease` | _type_ | atomic process-local admission and idempotent release primitive |
| `ManagedResource` / `ManagedResourceContext` / `ManagedResourceStartResult` | _type_ | resource lifecycle callbacks, shared deadlines, health reporting, separate readiness/completion promises and the value a resource publishes to its dependants |
| `ManagedResourceDependency` | _type_ | a dependency named by id or given as the resource itself — the second form is what `context.use(...)` can type |
| `ManagedResourcePublished` | _type_ | the value type `context.use(resource)` returns, recovered from that resource's own `start` |
| `ManagedResourcePublishesNoValue` | _type_ | what `context.use(...)` returns for a resource that publishes nothing — a branded refusal rather than `never`, so reading it does not silently compile |
| `ManagedServerResourceConfig` | _type_ | the server or a sync/async factory receiving `ManagedResourceContext`, plus stable ID, dependencies and server shutdown policy (`retryAfterSeconds`, `realtimeCloseTimeoutMs`) |
| `ManagedServerResource` | _type_ | the resource `managedServerResource` returns, whose `start` publishes the `ManagedServerHandle` |
| `ApplicationHealthHandlerOptions` / `ApplicationHealthHandlerOptionsSchema` | _type_ / schema | liveness/readiness selection and sanitized `Retry-After` policy |
| `ApplicationOperationalHandlers` / `ApplicationOperationalHandlersOptions` / `ApplicationOperationalHandlersOptionsSchema` | _type_ / schema | conventional status/readiness/liveness route surface and shared retry policy |

### Bounded admission

| Export | Kind | Summary |
|--------|------|---------|
| `createBoundedAdmission` | function | process-local no-queue global/per-key concurrency and rate leases, optionally composed with application admission |
| `BoundedAdmissionPolicySchema` / `BoundedAdmissionPolicy` | schema / _type_ | finite global budget and optional finite per-key budget with `maxKeys`, declared either as one flat ceiling or as a resolver — never both |
| `BoundedAdmissionPerKeyLimitsSchema` / `BoundedAdmissionPerKeyLimits` | schema / _type_ | one key's resolved ceiling: `maxConcurrent` and optional `rate` |
| `BoundedAdmissionPerKeyLimitResolver` | _type_ | `(key) => limits`, resolved on a key's first admission and cached until the key is evicted |
| `BoundedRateBudgetSchema` / `BoundedRateBudget` | schema / _type_ | `{ limit, intervalMs }` monotonic sliding-window budget |
| `BoundedAdmissionStateSchema` / `BoundedAdmissionState` | schema / _type_ | `accepting \| draining \| closed` |
| `BoundedAdmissionRefusalReasonSchema` / `BoundedAdmissionRefusalReason` | schema / _type_ | exact local/upstream refusal vocabulary |
| `BoundedAdmissionSnapshotSchema` / `BoundedAdmissionSnapshot` | schema / _type_ | absolute active/lifetime/refusal/rate-accounting counters |
| `BoundedAdmission` / `BoundedAdmissionConfig` / `BoundedAdmissionClock` | _type_ | handle, policy/upstream/clock configuration and monotonic clock seam |
| `BoundedAdmissionResult` / `BoundedAdmissionLeaseResult` / `BoundedAdmissionRefusedResult` | _type_ | explicit leased-or-refused acquisition result; retry time exists only for rate bounds |
| `BoundedOperationLease` | _type_ | idempotent release lease, optionally carrying its key |
| `BoundedOperationRunContext` / `BoundedOperationRunOptions` | _type_ | underlying work signal and caller abort/timeout wait budget |
| `BoundedAdmissionDrainOptions` / `BoundedAdmissionDrainResult` / `BoundedAdmissionForceResult` | _type_ | bounded drain inputs and honest remaining-work results |
| `BoundedAdmissionRefusalError` | class | `run()` refusal with reason and optional `retryAfterMs` |
| `BoundedOperationWaitError` | class | caller wait ended as `cancelled` or `timed-out`; underlying capacity remains leased until work settles |

### Bounded delivery

| Export | Kind | Summary |
|--------|------|---------|
| `createBoundedChannel` | function | finite single-reader async channel with explicit ordered or latest-value policy |
| `BoundedChannelPolicySchema` / `BoundedChannelPolicy` | schema / _type_ | `ordered \| latest` retention policy |
| `BoundedChannelStateSchema` / `BoundedChannelState` | schema / _type_ | `open \| draining \| closed \| failed` |
| `BoundedChannelSnapshotSchema` / `BoundedChannelSnapshot` | schema / _type_ | exact retained count/bytes, waiter and outcome counters |
| `BoundedChannel` / `BoundedChannelConfig` / `BoundedChannelCloseOptions` | _type_ | iterator/offer handle, explicit count/byte/size policy and drain/discard close mode |
| `BoundedChannelOfferResult` | _type_ | `delivered`, `queued`, `coalesced`, or reasoned `refused` outcome |
| `BoundedChannelReaderError` | class | refusal of a second concurrent pending `next()` |
| `createCreditWindow` | function | finite byte-credit lease window with exact once-only replenishment |
| `CreditWindow` / `CreditWindowSnapshot` / `CreditWindowSnapshotSchema` | _type_ / schema | byte-credit handle and absolute accounting record |
| `CreditAcquireResult` / `CreditLease` | _type_ | reasoned refusal or idempotently releasable byte-credit lease |
| `CreditAcquireWaitOptions` | _type_ | `signal` / `timeoutMs` for the waiting `acquire` overload; absent budget waits until credit, close or abort |
| `CreditWaitResult` / `CreditWaitRefusalReason` | _type_ | waiting-acquire outcome; `insufficient-credit` is absent by construction, `timed-out` and `aborted` replace it |

### Bounded diagnostic journal

| Export | Kind | Summary |
|--------|------|---------|
| `createDiagnosticJournal` | function | create one schema-owned FIFO JSONL writer with bounded retained memory, exclusive local path ownership and finite rotation |
| `DiagnosticJournalConfig` / `DiagnosticJournal` | _type_ | owner schema/path/limits/failure observer and the synchronous `submit`, bounded-wait `flush`/`close`, status handle |
| `DiagnosticJournalLimitsSchema` / `DiagnosticJournalLimits` | schema / _type_ | positive event, pending-item, pending-byte, file-byte and retained-file limits |
| `DiagnosticJournalLockPolicySchema` / `DiagnosticJournalLockPolicy` | schema / _type_ | `refuse` (default) or `reclaim-stale`, which reclaims only a lock whose recorded owner is provably gone |
| `DiagnosticJournalSubmitResultSchema` / `DiagnosticJournalSubmitResult` | schema / _type_ | accepted epoch/sequence or explicit invalid, oversized, capacity, closed or failed refusal |
| `DiagnosticJournalStatusSchema` / `DiagnosticJournalStatus` | schema / _type_ | state, limits, exact admission/write/failure counters, pending ownership, rotations, partial tails and last safe sequences |
| `DiagnosticJournalFrameSchema` / `DiagnosticJournalFrame` | schema / _type_ | version-1 JSONL frame carrying process epoch, contiguous accepted sequence and schema-validated JSON event |
| `DiagnosticJournalWaitResultSchema` / `DiagnosticJournalWaitResult` | schema / _type_ | flush settlement boundary with truthful settled, timed-out or cancelled result |
| `DiagnosticJournalCloseResultSchema` / `DiagnosticJournalCloseResult` | schema / _type_ | physical close or caller timeout/cancellation without pretending an active write stopped |
| `DiagnosticJournalStateSchema` / `DiagnosticJournalState` | schema / _type_ | `open \| draining \| closed \| failed` |
| `DiagnosticJournalRefusalReasonSchema` / `DiagnosticJournalRefusalReason` | schema / _type_ | `closed \| failed \| invalid \| oversized \| item-capacity \| byte-capacity` |
| `DiagnosticJournalFailurePhaseSchema` / `DiagnosticJournalFailurePhase` | schema / _type_ | internal `write \| rotation \| close` failure phase exposed only to status and the isolated observer |
| `DiagnosticJournalWaitOptions` / `DiagnosticJournalFailure` | _type_ | caller wait signal/timeout and isolated internal failure callback record |

`accepted` is bounded in-memory admission and `written` is completed append, not `fsync` or durable
delivery. The journal has no reader/replay/upload API. See the
[guide](../guide/application-kernel.md#bounded-local-diagnostic-journal),
[architecture](../architecture/diagnostic-journal.md) and [ADR
0134](../decisions/0134-diagnostic-journal-is-bounded-local-evidence.md).

### Managed schedules

| Export | Kind | Summary |
|--------|------|---------|
| `createManagedSchedule` | function | fixed-rate process-local timer that activates after top-level readiness and participates in drain |
| `ManagedScheduleOverlapSchema` / `ManagedScheduleOverlap` | schema / _type_ | `skip`, `queue-one` or bounded `parallel` overlap policy |
| `ManagedScheduleErrorPolicySchema` / `ManagedScheduleErrorPolicy` | schema / _type_ | `continue` or `stop-schedule` after an observed callback failure |
| `ManagedScheduleDescriptorSchema` / `ManagedScheduleDescriptor` | schema / _type_ | immutable public schedule identity and cadence policy |
| `ManagedScheduleStatusSchema` / `ManagedScheduleStatus` | schema / _type_ | absolute schedule state, revision, counters and timestamps |

Schedule authoring additionally exports `ManagedSchedule`, `ManagedScheduleConfig`,
`ManagedScheduleRunContext`, `ManagedScheduleClock` and `ManagedScheduleTimer`.
The clock exposes monotonic cadence/deadline arithmetic and a wall-clock projection for portable
status timestamps; it is a deterministic test boundary, not a durable scheduler.

### Application and activity projection

| Export | Kind | Summary |
|--------|------|---------|
| `createActivityProjection` | function | aggregate anonymous process-local activity into declared bounded stages and absolute snapshots |
| `createApplicationSnapshotSink` | function | latest-value delivery with one write in flight and one replaceable pending revision |
| `applicationLifecycleEvent` | function | project a sanitized lifecycle fact from a canonical application snapshot |
| `createApplicationEventSink` | function | bounded failure-isolated lifecycle-event delivery; events are not canonical state |
| `ActivitySnapshotSchema` / `ActivitySnapshot` | schema / _type_ | epoch, monotonic revision, timestamps, declared stages and aggregate counts |
| `ApplicationSnapshotSinkStatusSchema` / `ApplicationSnapshotSinkStatus` | schema / _type_ | immutable latest-value sink delivery and coalescing counters |
| `ApplicationLifecycleEventSchema` / `ApplicationLifecycleEvent` | schema / _type_ | sanitized operator-facing application lifecycle fact |

Activity authoring additionally exports `ActivityId`, `ActivityIdSchema`,
`ActivityStageId`, `ActivityStageIdSchema`, `ActivityStageSnapshot`,
`ActivityStageSnapshotSchema`, `ActivityLiveState`, `ActivityLiveStateSchema`,
`ActivityProjection`, `ActivityProjectionConfig`,
`ActivityProjectionSubscriberError`, `ActivityToken` and `ActivityTransition`.
Latest-value delivery exports `ApplicationSnapshotSink`,
`ApplicationSnapshotSinkConfig`, `ApplicationSnapshotSinkError` and
`RevisionedApplicationSnapshot`; event delivery exports `ApplicationEventSink`
and `ApplicationEventSinkConfig`.

### Canonical application records

The entrypoint exports each Zod schema beside its inferred type:
`ApplicationIdSchema` / `ApplicationId`, `ApplicationLifecycleSchema` /
`ApplicationLifecycle`, `ApplicationHealthSchema` / `ApplicationHealth`,
`ManagedResourceStateSchema` / `ManagedResourceState`,
`ApplicationAdmissionSnapshotSchema` / `ApplicationAdmissionSnapshot`,
`ManagedResourceSnapshotSchema` / `ManagedResourceSnapshot`,
`ApplicationSnapshotSchema` / `ApplicationSnapshot`,
`ApplicationStatusProjectionSchema` / `ApplicationStatusProjection` with
`projectApplicationStatus` — what a status or probe endpoint may publish, and
the function that derives it from a snapshot,
`ApplicationResourceShutdownSchema` / `ApplicationResourceShutdown`, and
`ApplicationShutdownResultSchema` / `ApplicationShutdownResult`.

## `stitchkit/application/grammy`

Isolated optional-peer lifecycle adapters. Importing `stitchkit/application`
does not resolve grammY.

| Export | Kind | Summary |
|--------|------|---------|
| `grammyPollingResource` | function | adapt an injected bot's long polling with distinct `onStart` readiness, observed completion and one stop chain |
| `createGrammyWebhookResource` | function | return a managed resource plus admission-guarded `handleUpdate`; HTTP hosting and webhook registration stay application-owned |
| `GrammyWebhookUnavailableError` | class | stable `GRAMMY_WEBHOOK_NOT_ACCEPTING` rejection after webhook admission closes |
| `GrammyPollingResourceConfig` | _type_ | injected bot, polling options, resource graph policy and isolated error observer |
| `GrammyWebhookResourceConfig` / `GrammyWebhookResource` | _type_ | injected webhook bot declaration and `{ resource, handleUpdate }` handle |
| `GrammyUpdate` | _type_ | exact update input inferred from the injected grammY bot context |

## `stitchkit/application/opentelemetry`

Type-only optional-peer adapter for applications that already own an
OpenTelemetry SDK and exporter. Its observable gauges pull absolute canonical
snapshots; the adapter owns no SDK lifecycle, polling or delta state.

| Export | Kind | Summary |
|--------|------|---------|
| `createApplicationOpenTelemetry` | function | register fixed observable application, resource, admission, schedule and activity gauges on an injected Meter |
| `ApplicationOpenTelemetryConfig` | _type_ | injected meter and canonical application/activity/schedule pull sources plus isolated diagnostic hook |
| `ApplicationOpenTelemetryBinding` | _type_ | idempotent exact callback removal and closed state |
| `ApplicationTelemetryMeter` | _type_ | minimal structural `Meter.createObservableGauge` boundary compatible with `@opentelemetry/api` |
| `ApplicationOpenTelemetryCollectionError` | _type_ | isolated instrument-name/error diagnostic without product/provider attributes |

---

## `stitchkit/agent-runtime`

Server-only optional application runtime. See the
[agent runtime guide](../guide/agent-runtime.md).

| Export | Kind | Summary |
|--------|------|---------|
| `createAgentRuntime` | function | compose durable acceptance, stream loop, checkpoints, coordination, managed tools and winner-only terminal publication; reconciles same-owner terminal/interrupt/head CAS races before releasing the lane |
| `createDeferredAgentToolSurface` | function | bounded canonical catalog search plus durable same-run activation of direct `mountAgent` tools; supports one immutable surface or a finite identity-specific registry |
| `DeferredAgentToolSearchInputSchema` / `DeferredAgentToolMatchSchema` / `DeferredAgentToolReceiptSchema` | schema | bounded search input, public match and versioned durable selection receipt |
| `DeferredAgentToolSurfaceConfig` / `DeferredAgentToolCommonConfig` / `DeferredAgentToolSurfaceDefinition` / `DeferredAgentToolController` | _type_ | finite catalogs, selector, pin, budget and `mount`/`prepareStep` composition contracts |
| `DeferredAgentRuntimeToolDefinition` / `DeferredAgentToolMountConfig` | _type_ | peer-free Agent-only runtime definition and canonical mount configuration accepted by the controller |
| `DeferredAgentToolManifestEntry` / `DeferredAgentToolSearchContext` / `DeferredAgentToolReceipt` | _type_ | canonical selector input and inferred durable receipt records |
| `DeferredAgentToolEvent` | _type_ | PII-free search/step evidence with surface, provenance, counts, canonical schema bytes and ceilings |
| `defineAgentProtocol` | function | declare context, input metadata, canonical parts and optional pre-CAS terminal acceptance (`allow-empty`, `require-output` or callback) |
| `hasAgentTerminalOutput` | function | generic `require-output` predicate for non-blank text, generated files, structured provider parts and explicit tool-only policy stops |
| `AgentMessageSchema` / `AgentRunSchema` / `AgentSnapshotSchema` | schema | versioned canonical engine records |
| `AgentRunQueuePrioritySchema` | schema | durable opt-in priority for queued `interrupt-next` runs |
| `AgentRuntimeStore` | _type_ | aggregate CAS transaction boundary for message, run and compaction mutations |
| `createAgentRuntimeStore` | function | build the aggregate store from one coherent transaction driver; framework owns every state transition |
| `AgentRuntimeStoreDriver` | _type_ | ORM-neutral transaction over a bounded head, normalized runs/admissions, product history and indexed run recovery |
| `AgentRuntimeHeadSchema` | schema | constant-size conversation identity plus monotonic runtime version |
| `AgentStoredRunSchema` | schema | canonical normalized run with an optional retained terminal assistant |
| `AgentAdmissionReceiptSchema` | schema | durable idempotency receipt with canonical input and assigned run/assistant identities |
| `AgentHistoryMutationSchema` | schema | typed canonical message mutation applied inside the winning state transaction |
| `RecoverAgentRunSchema` | schema | explicit abandon/requeue recovery decision; acquired runs require replay-safe evidence |
| `createMemoryAgentRuntimeStore` | function | process-local reference adapter, not production durability |
| `purgeAgentConversation` | function | dispatch optional atomic deletion; returns `unsupported`, `active`, `conflict`, `purged` or `already_purged` |
| `AgentConversationPurgeInputSchema` / `AgentConversationPurgeInput` | schema / _type_ | conversation ID and optional expected snapshot version |
| `AgentConversationPurgeResultSchema` / `AgentConversationPurgeResult` | schema / _type_ | typed deletion/refusal outcomes; active refusal includes run IDs |
| `AgentConversationPurgedError` | class | runtime mutation rejected because its conversation ID is permanently purged |
| `AgentConversationPurgeDriver` | _type_ | optional `driver.conversations` capability: serialized tombstone read and atomic removal of all owned records |
| `projectAgentHistory` | function | asynchronously project canonical records and resolved multimodal files into provider-valid AI SDK messages |
| `defineModelRegistry` | function | typed language-model descriptors, capabilities and provider construction |
| `AgentModelCatalogSchema` / `AgentModelCatalog` | schema / _type_ | provider-neutral complete/partial model catalog with separately sourced popularity, metrics, prices and observation time |
| `AgentModelCatalogEntrySchema` / `AgentModelCatalogEntry` | schema / _type_ | one canonical provider model descriptor with optional price, popularity and metric evidence |
| `AgentModelPriceSchema` / `AgentModelPrice` | schema / _type_ | normalized per-token input/output pricing and source currency |
| `AgentModelPopularitySchema` / `AgentModelPopularity` | schema / _type_ | independently sourced ranked popularity observation with window and timestamp |
| `AgentModelMetricSchema` / `AgentModelMetric` | schema / _type_ | independently sourced benchmark measurement with provenance and observation time |
| `AgentModelCatalogProvider` | _type_ | abortable live catalog loader supplied by a provider adapter or application |
| `AgentModelSearchInputSchema` / `AgentModelSearchInput` | schema / _type_ | bounded catalog text query and result ceiling |
| `AgentModelSearchResultSchema` / `AgentModelSearchResult` | schema / _type_ | exact bounded catalog projection with total match count |
| `searchAgentModelCatalog` | function | deterministic bounded search over a loaded canonical catalog |
| `AgentModelSelectionSchema` / `AgentModelSelection` / `AgentModelSelectionStore` | schema / _type_ | durable per-conversation model choice; runtime resolvers receive run and snapshot to recover the model pinned to input metadata |
| `createMemoryAgentModelSelectionStore` | function | process-local selection reference adapter |
| `AgentConversationReader` | _type_ | optional bounded conversation-summary and message-history reader; not part of the required runtime store contract |
| `AgentConversationSummarySchema` / `AgentConversationSummary` | schema / _type_ | bounded durable conversation list item with version, activity and preview |
| `AgentConversationPageSchema` / `AgentConversationPage` | schema / _type_ | cursor-paged conversation summaries |
| `AgentConversationMessagePageSchema` / `AgentConversationMessagePage` | schema / _type_ | cursor-paged durable message history |
| `composeAgentPrompt` | function | ordered prompt contributions and provenance-aware signed context budget; irreducible reservation deficits are `oversized`, not compactable history |
| `structuredCompaction` | function | summarize a provider-valid snapshot range and replace it through CAS |
| `selectCompactableHistory` | function | which oldest whole complete turns may be summarised away — the half of compaction that needs no store (→ ADR 0142) |
| `SelectCompactableHistoryOptions` / `CompactableHistory` | _type_ | message list, retained-turn count and evidence policy in; `leadingSummary`, `compactable` and `retained` out |
| `createAgentSessionCoordinator` | function | strict process-local queue/interrupt/supersede lifecycle |
| `AgentRuntimeStopPolicy` | _type_ | named custom AI SDK stop condition persisted and published on policy stop |
| `AgentRuntimePrepareStep` | _type_ | per-run controlled step callback with typed domain context and managed run signal/fence |
| `AgentContextOverflowError` | class | deliberate application budget refusal thrown from `loop.prepareStep`; terminalizes as `context_overflow` without classifying arbitrary error text |
| `AgentRuntimeRecordIds` | _type_ | optional caller-provided input, run and assistant IDs for stable application records |
| `AgentRuntimeAdmission` | _type_ | canonical committed input, assigned run, pending assistant projection, compatibility IDs and snapshot version |
| `AgentAdmissionEventSchema` | schema | post-commit admission projection; removes store rereads but does not imply exactly-once delivery |
| `AgentRunMetricsSchema` | schema | optional provenance-aware usage and timings; `partial` says the provider never reported the run finished, so the figure beside it is not a confirmed total |
| `AgentRuntimeRecoverOptions` | _type_ | bounded paged startup recovery with causal per-conversation scheduling, context resolver and explicit evidence policy |
| `AgentRuntimeConflictError` | class | thrown when a store mutation loses to a concurrent writer — catchable by type from `stitchkit/agent-runtime` |
| `AgentSessionCloseOptions` | _type_ | `gracePeriodMs` for natural settlement, then abort, then `forceTimeoutMs` for bounded settlement after it |
| `AgentSessionCloseResult` | _type_ | what `close()` achieved: `settled`, or `timedOut` with `remaining` runs still in flight. Only omitting `forceTimeoutMs` guarantees nothing is in flight on return |
| `AgentHistoryProjectionOptions` | _type_ | storage-neutral file resolver, explicit unresolved-file behavior, and how an interrupted turn reaches the model (`interruptedAssistant`) |
| `createAgentToolFenceLifecycle` | function | pre-effect and post-effect run ownership fence for `mountAgent`; compose beside application idempotency for [durable operations](../guide/mcp-and-agents.md#durable-application-owned-execution) |
| `AgentRuntimeEventSchema` | schema | transient stream lifecycle plus post-commit admission/checkpoint/run-state/terminal projections |
| `createAgentObservability` | function | separate agent-run sink over the shared bounded observability lifecycle |

### Complete runtime inventory

The entrypoint deliberately exports the schemas beside their inferred types so persistence and
transport adapters validate the same records. Runtime composition types are `AgentRuntime`,
`AgentRuntimeConfig`, `AgentRuntimeInput`, `AgentRuntimeProtocolInput`, `AgentRuntimeRunContext`,
`AgentRuntimeResult`, `AgentRuntimeInterruptInput`, `AgentRuntimeRecoveryInput`,
`AgentRuntimeRecoveryDecision`, `AgentRuntimeRecoveryOutcome`, `AgentRuntimePublisher`,
`AgentInputPolicy`, `AgentStopReason`, `AgentCoordinatedRun`, `AgentRunTicket`,
`AgentSessionCoordinator`, `AgentCompactionContext`, `AgentCompactionResult` and
`StructuredCompactionConfig`.

A provider refusal is classified rather than phrased. `classifyProviderFailure` returns an
`AgentProviderFailure` — an `AgentProviderFailureReason` (`insufficient-credits`, `rate-limited`,
`model-unavailable`, `context-overflow`, `timeout`, `cancelled`, `unknown`), the provider's `status`
when it supplied one, whether the same request is `retryable` unchanged, and the `evidence` the
answer rests on: `status` is the provider stating its own answer, `message` is us reading its prose,
and `none` is an honest refusal to guess. The sentence a user reads stays with the application —
its tone and its decision about what to admit are not the core's to make. `isToolResultFailure`
recognises a failure carried inside a *successful* tool result, in both the bare and the
`{ value: … }` envelope. Both are plain functions and need no runtime. → ADR 0141

`normalizeOpenRouterUsage` is the same normalisation `openRouterProvider`
applies, exported so an application calling the SDK directly gets provenance-correct numbers
without adopting the runtime.

`AgentContextUsage` reaches every step through `AgentRuntimeRunContext.contextUsage`: how full the
model's context is, as `usedTokens` (an `AgentUsageValue`, so it carries the provenance that says
where the number came from) beside the model's declared `contextWindow`. It is the **last completed
step's prompt size**, not the run's cumulative input tokens — cumulative counts every step's prompt
again and is a multiple of the real fill. Before the first step lands there is no provider-reported
number and the provenance is `unavailable`, which is a different fact from zero. No fraction is
exposed: dividing is one line where it is rendered, and the output reserve belongs to the
consumer's prompt budget rather than to this layer.

Canonical protocol exports are `AgentProtocol`, `AgentProtocolConfig`, `AgentTerminalAcceptance`,
`AgentTerminalAcceptanceInput`, `hasAgentTerminalOutput`, `AgentRecordIdSchema`, `AgentRecordVersionSchema`,
`AgentTimestampSchema`, `AgentJsonObjectSchema`, `AgentProviderEnvelopeSchema`,
`AgentProviderEnvelope`, `AgentMessagePartSchema`, `AgentMessagePart`, `AgentTextPartSchema`,
`AgentReasoningPartSchema`, `AgentFilePartSchema`, `AgentSourcePartSchema`,
`AgentToolCallPartSchema`, `AgentToolResultPartSchema`, `AgentOpaquePartSchema`,
`AgentControlPartSchema`, `AgentMessageRoleSchema`, `AgentMessageStatusSchema`, `AgentMessage`,
`AgentAssistantPlaceholderSchema`, `AgentAssistantPlaceholder`, `AgentRunStateSchema`,
`AgentTerminalReasonSchema`, `AgentTerminalReason`, `AgentRunQueuePrioritySchema`,
`AgentRunQueuePriority`, `AgentRun`, `AgentSnapshot`,
`AgentUsageValueSchema`, `AgentCostValueSchema`, `AgentUsageSchema`, `AgentUsage` and
`AgentRunMetrics`.

`AgentProvenanceSchema` / `AgentProvenance` is the entrypoint's single vocabulary for **how a
number came to be known**: `provider-reported` (the provider stated it about a request it served),
`measured` (this process counted it exactly, before any request was made), `computed` (arithmetic
over other values — a sum of exact numbers is still `computed`), `estimated` (a heuristic) and
`unavailable` (not known, so `value` is absent, which is a different fact from a reported zero).
Each surface declares the subset it can produce: `AgentUsageValueSchema` and `AgentCostValueSchema`
describe a request that has already happened and never say `measured`; `AgentTokenCountSchema`
describes a prompt being composed and never says `provider-reported`. Every token count is an
integer — `AgentUsageValueSchema` and `AgentTokenCountSchema` refuse a fractional `value`, and a
provider figure that is not a whole number is normalised to `unavailable` rather than thrown.
`AgentCostValueSchema.value` stays fractional, because money is.

`runs.inputPolicy` takes `queue` (default), `inject`, `interrupt`, `interrupt-next` or `supersede`, or a function of
the raw input returning one. `inject` lets a run in flight take a newly arrived input into its prompt
at a step boundary and answer it too; the absorption is committed in the **same transaction** as that
run's terminal record, via `CommitRunTerminal.absorb`, so a run that ends any other way leaves an
ordinary queued successor. The absorbed run ends with `terminalReason: 'absorbed'`, run state
`'superseded'`, `absorbedIntoRunId` naming the run that answered it, and **no assistant message of
its own**; a submission on its idempotency key resolves through that pointer to the answer
(→ ADR 0113).

`interrupt-next` interrupts the active run, waits for its real settlement and then executes the new
input before ordinary pending work. Ordinary work is not dropped or re-admitted, and urgent work is
FIFO within its own class. `AgentRun.queuePriority` persists the pending class;
`AgentRun.executionSequence` persists the actual first-acquisition order, so recovery and canonical
history preserve the same `A → C → B` order across equal timestamps and scan pages (→ ADR 0127).

With `queue`, a durable successor admission is not prompt eligibility: the current executor sees
only records through its own run boundary. Snapshot history is normalized to causal turn order
(assigned input(s), assistant, then successor input(s)) even when the storage codec physically
appended the successor before the predecessor checkpoint.

`AgentRuntimeStore` has two **bounded** reads beside `loadSnapshot`:
`loadRun({ conversationId, runId })` returns an `AgentRunView` — the run, the conversation version it
was read at, and the retained answer once the run is terminal — or `undefined`; `listActiveRuns(conversationId)`
returns the runs that have not ended in durable execution/priority order. Neither reads history, so
neither grows with the length of the conversation, and neither needs anything new from
`AgentRuntimeStoreDriver`. `loadSnapshot` and every mutation result still carry the whole
conversation — that is what the store's reducer validates against, and what the runtime builds a
prompt from (→ ADR 0112).

`AgentRuntimeStore.purgeConversation` is optional; `purgeAgentConversation(store, input)` explicitly
handles unsupported stores. Official memory and initialized SQLite stores refuse active runs,
remove every owned payload and reserve the conversation ID permanently. Empty snapshots are not
deletion receipts. Consumer metadata, files, event logs and UI cache invalidation remain outside
the transaction. See [purging a conversation](../guide/agent-runtime.md#purging-a-conversation).

Store command/result exports are `AcceptInputAndAssignRun`, `AcceptInputAndAssignRunSchema`,
`AcquireAgentRun`, `AcquireAgentRunSchema`, `CheckpointRunAssistant`,
`CheckpointRunAssistantSchema`, `CommitRunTerminal`, `CommitRunTerminalSchema`,
`RequestRunInterrupt`, `RequestRunInterruptSchema`, `AgentRunView`, `AgentRunViewSchema`,
`runStateForTerminalReason`,
`ACTIVE_AGENT_RUN_STATES`, `RecoverAgentRun`, `ReplaceCompactedRange`,
`ReplaceCompactedRangeSchema`, `AgentStoreMutationResult`, `AgentStoreMutationResultSchema`,
`AgentStoreAppliedSchema`, `AgentStoreConflictSchema`, `AgentStoreDuplicateSchema`,
`AgentStoreNotFoundSchema`, `AgentAdmissionReceipt`, `AgentAdmissionReceiptSchema`,
`AgentRuntimeHead`, `AgentStoredRun`, `AgentStoreCompareAndSwapResult`, `AgentHistoryMutation`,
`AgentRecoverableDescriptor`, `AgentRecoverableDescriptorSchema`, `AgentRecoverablePage` and
`AgentRecoverablePageSchema`.

History and context-budget exports are `projectAgentHistoryDetailed`,
`AgentHistoryProjectionDecision`, `AgentHistoryProjectionResult`, `selectAgentHistory`,
`SelectAgentHistoryOptions`, `AgentHistoryBudgetDecision`, `AgentHistoryBudgetResult`,
`AgentPromptBudget`, `AgentPromptSection`, `AgentPromptSectionContext`, `AgentTokenCount`,
`AgentTokenCountSchema`, `ComposeAgentPromptOptions` and `ComposedAgentPrompt`. Whole-turn history
selection never splits a tool chronology and reports why every canonical record was retained or
removed. `AgentHistoryEvidencePolicy` is the shared opt-in for marked failed-assistant evidence in
projection, budgeting and structured compaction; `isAssistantHistoryEvidence` applies it. The
compatibility default omits it. Approval message schemas are
`AgentToolApprovalRequestPartSchema` and `AgentToolApprovalResponsePartSchema`.

Model exports are `AgentLanguageModelProvider`, `AgentModelCapability`,
`AgentModelCapabilitySchema`, `AgentModelDescriptor`,
`AgentModelDescriptorSchema`, `AgentModelRegistry`, `AgentModelRegistryConfig`,
`AgentModelRegistrySnapshot`, `AgentModelRegistrySnapshotSchema`, `AgentModelSnapshotPolicy`,
`AgentResolvedModel` and `validateAgentModelSnapshot`. Registry `preflight` validates availability,
provider and required capabilities without constructing the model; runtime `models.preflight`
runs before durable admission.

Delivery exports are `AgentAdmissionEventSchema`, `AgentCheckpointEventSchema`,
`AgentRunStateEventSchema`, `AgentTerminalEventSchema`, `AgentTransientDeltaEventSchema`,
`AgentReasoningStartEventSchema`, `AgentReasoningDeltaEventSchema`,
`AgentReasoningEndEventSchema`, `AgentToolStatusEventSchema`, `AgentRuntimeEvent`,
`AgentRuntimeEventCursor`, `AgentRuntimeEventCursorSchema`, `AgentRuntimeCursorAdvance`,
`advanceAgentRuntimeEventCursor`, `agentDurableEventId`, `AgentRuntimeEventSink`,
`AgentRuntimeEventSinkConfig` and `createAgentRuntimeEventSink`. Cursor gaps require a canonical
snapshot reload; the bounded sink isolates transport failure and supports a typed projection step.

Managed effects and operator telemetry additionally export `AgentToolFenceConfig`,
`AgentToolFenceContext`, `AgentObservability`, `AgentRunEvent`, `AgentRunEventSchema`,
`AgentRunStartedEvent`, `AgentRunStartedEventSchema`, `AgentStepFinishedEvent`,
`AgentStepFinishedEventSchema`, `AgentRunTerminalEvent`, `AgentRunTerminalEventSchema`,
`AgentRunSinkConfig`, `AgentRunSinkDrop` and `AgentRunSinkError`. A monotonic run `fencingToken`
may accompany checkpoint/terminal writes and tool context; internal causes are redacted unless an
operator-only observability sink explicitly opts in.

## `stitchkit/agent-runtime/harness`

Server-only evolving facade over the canonical Agent runtime. It requires the optional `ai` peer
and introduces no store, queue or model-provider implementation of its own.

| Export | Kind | Summary |
|--------|------|---------|
| `createHeadlessAgentHarness` | function | compose one `createAgentRuntime` with caller-supplied model resolution, bounded resources, tools and prompt policy; adds canonical `snapshot` |
| `HeadlessAgentHarness` / `HeadlessAgentHarnessConfig` | _type_ | runtime facade and injected ownership boundary |
| `HeadlessAgentModelResolver` | _type_ | per-run preflight/resolve port returning the actual `AgentResolvedModel` |
| `AgentHarnessResourceSchema` / `AgentHarnessResource` | schema / _type_ | strict instruction, skill or resource with name, text and provenance |
| `AgentHarnessResourceKindSchema` / `AgentHarnessResourceKind` | schema / _type_ | closed `instruction`, `skill` or `resource` vocabulary |
| `AgentHarnessResourceResult` | _type_ | one loader result containing resources and diagnostics |
| `AgentHarnessResourceDiagnosticSchema` / `AgentHarnessResourceDiagnostic` | schema / _type_ | bounded caller evidence; observer failure is isolated |
| `AgentHarnessLimitsSchema` / `AgentHarnessLimits` | schema / _type_ | resource count, total UTF-8 bytes and diagnostic ceilings |
| `AgentHarnessProfileEventSchema` / `AgentHarnessProfileEvent` | schema / _type_ | actual model descriptor, non-content resource provenance and sorted direct tool identities applied to one run |
| `createAgentHarnessFileResources` | function | discover explicit instruction/skill/resource roots with symlink containment, bounded summaries and direct exact reads |
| `AgentHarnessFileRootSchema` / `AgentHarnessFileRoot` | schema / _type_ | caller-owned absolute path, public root ID and resource kind |
| `AgentHarnessFileLimitsSchema` / `AgentHarnessFileLimits` | schema / _type_ | file count, depth, per-file and aggregate byte ceilings |
| `AgentHarnessFileResources` | _type_ | loader plus direct `read_resource` definition for lazy exact content |
| `createAgentHarnessControlServer` | function | transport-neutral correlated requests, observer attachments and exclusive controller leases |
| `AgentHarnessControlServer` / `AgentHarnessControlConnection` | _type_ | host server and detachable connection lifecycle; `deliver` is serialized, while required out-of-band `onOverflow` closes/aborts a slow transport before reconnect |
| `AgentHarnessControlServerConfig` | _type_ | explicit per-connection pending-event and server-wide concurrent attachment-snapshot bounds for failure-isolated control delivery |
| `AgentHarnessPendingApproval` / `AgentHarnessApprovalDecision` | _type_ | exact durable pending request and allow/deny successor input |

Resources default to at most 64 entries, 1 MiB of total UTF-8 text and 128 diagnostics. Duplicate
names and exceeded bounds fail before the provider step. Recovery remains the underlying runtime's
explicit policy; use the Bun or Node SQLite leaf for durable reopen.

## `stitchkit/agent-runtime/coding-tools`

Server-only evolving, peer-free direct runtime tools. `createAgentCodingTools(config)` returns
`read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `search_files`, optional
`run_command` and, when an
artifact store is supplied, `read_output`.

| Export | Kind | Summary |
|--------|------|---------|
| `createAgentCodingTools` | function | construct direct host-authorized bounded file, listing, glob, search, exact-snippet edit, shell and artifact runtime-tool definitions; every ordinary refusal is a typed code with an instructive `hint`, and filesystem operations use Linux `/proc/self/fd` or the packaged macOS Node-API backend and otherwise fail closed |
| `AGENT_CODING_TOOL_NAMES` | const | the mounted tool names — `read_file`, `write_file`, `edit_file`, `list_directory`, `glob`, `search_files`, `run_command`, `read_output` |
| `AgentCodingToolDefinition` | _type_ | peer-free structural direct-tool shape accepted by the canonical runtime-tool surface |
| `AgentCodingToolConfig` | _type_ | absolute root, required authorization callback, finite executable alias map, exact child environment and optional limits |
| `AgentCodingToolAuthorizationSchema` / `AgentCodingToolAuthorization` | schema / _type_ | discriminated read/write/search/patch/shell/artifact decision presented to host policy before effect |
| `AgentCodingToolLimitsSchema` / `AgentCodingToolLimits` | schema / _type_ | explicit path/read/write/argument-count/argument-byte/output/artifact/timeout/termination-grace ceilings |
| `AgentCodingArtifactStore` | _type_ | host-owned opaque artifact write and bounded read boundary |
| `FileReadInputSchema` / `FileReadOutputSchema` | schema | bounded strict-UTF-8 byte slice; offsets must align with UTF-8 code-point boundaries |
| `FileWriteInputSchema` / `FileWriteOutputSchema` | schema | create-only by default or explicit atomic replacement; symlink targets fail closed |
| `createShellInputSchema` / `ShellOutputSchema` | schema | enumerated executable alias plus arguments and concrete relative cwd; explicit exited/timeout/output-limit/cancelled outcome |

File/search operations pin directory descriptors across authorization and the actual effect;
resource discovery uses the same ancestor-safe traversal. This closes parent rename/symlink races
without claiming an executable sandbox. The default ceilings are 4,096 path bytes, 256 KiB read/write/output, 128 shell arguments, 64 KiB
of aggregate argument text, 4 MiB per artifact and 30 seconds. The root is a path-resolution
boundary, not an OS sandbox; executable behavior, process
isolation, credentials and external-effect idempotency remain host responsibilities.

## `stitchkit/agent-runtime/browser`

Browser-safe canonical agent data. It re-exports the run, message, part, usage,
terminal and provider-envelope schemas/types listed under
`stitchkit/agent-runtime`, together with all runtime delivery event schemas,
`AgentRuntimeEventCursorSchema`, `advanceAgentRuntimeEventCursor`,
`AgentControlRequestSchema` / `AgentControlRequest`, `AgentControlResponseSchema` /
`AgentControlResponse`, `AgentControlDeliverySchema` / `AgentControlDelivery`, `AgentMultiSessionCursorSchema` /
`AgentMultiSessionCursor`, `AgentConversationView`, `AgentControlView`,
`advanceAgentMultiSessionCursor`, `createAgentControlView`, `reduceAgentControlSnapshot`,
`reduceAgentControlEvent` and
`agentDurableEventId`. It imports no model provider, executor, store, event sink
or Node context module.

Use this entrypoint from client components and shared DTO packages. The full
`stitchkit/agent-runtime` entrypoint remains server-only.

---

## `stitchkit/agent-runtime/openrouter`

| Export | Kind | Summary |
|--------|------|---------|
| `openRouterProvider` | function | isolated `@openrouter/ai-sdk-provider` language-model factory |
| `openRouterModelCatalog` | function | complete tool-capable text catalog plus independent weekly popularity and available benchmark observations |
| `OpenRouterProviderSettings` | _type_ | official provider settings accepted by the factory |
| `OpenRouterModelCatalogOptions` / `OpenRouterCatalogFetch` | _type_ | credential, timeout, clock and injected fetch boundary for catalog loading |

## `stitchkit/agent-runtime/sqlite/bun`

Bun built-in SQLite persistence. The entrypoint imports `bun:sqlite` and is not
loaded by the neutral, browser or Node runtime surfaces.

| Export | Kind | Summary |
|--------|------|---------|
| `createBunSqliteAgentRuntimeStore` | function | open an owned Bun SQLite connection, initialize/validate schema v1 and return `{ store, conversations, close }` |
| `BunSqliteAgentRuntimeStoreConfig` | _type_ | database filename plus optional create and initialization policies |
| `createSqliteAgentRuntimeStore` | function | build the normalized store over an injected synchronous SQLite boundary |
| `initializeAgentRuntimeSqlite` | function | initialize or validate only Stitchkit's namespaced SQLite schema |
| `AgentRuntimeSqliteDatabase` / `AgentRuntimeSqliteStatement` / `AgentRuntimeSqliteValue` | _type_ | minimal runtime-neutral synchronous SQLite boundary |
| `SqliteAgentRuntimeStore` / `SqliteAgentRuntimeStoreConfig` | _type_ | durable store handle, owned connection lifecycle and initialization policy |

---

## `stitchkit-tui`

Separate optional evolving Bun/OpenTUI package over a caller-composed headless harness.

| Export | Kind | Summary |
|--------|------|---------|
| `defineAgentTui` | function | typed config for title/theme/status rows, model catalog, context, commands, runtime bundle and optional host-evidenced recovery policy; the default never requeues acquired effects |
| `runAgentTui` | function | start one fresh durable conversation and terminal controller, recover durable work and publish its authenticated local session; `initialConversationId` is an explicit resume override |
| `defineTuiCommand` / `resolveTuiCommand` | function | typed composable slash-command registry; unknown slash input remains an ordinary model prompt |
| `createAgentTuiController` | function | single admission, selection, approval, interruption and conversation-switch owner over the harness |
| `startAgentTuiSessionHost` / `createAgentTuiClient` | function | authenticated mode-`0600` Unix-socket host/client for status, submit and interrupt through that controller |
| `listAgentTuiSessions` | function | discover live local terminal session IDs and their current conversation |
| `createAgentTuiComposer` / `navigateAgentTuiHistory` | function | multiline draft and reversible prompt-history state |
| `defaultAgentTuiStatusLine` / `AgentTuiStatusLineFormatter` | function / _type_ | terminal-native default rows and a host formatter over model capacity, durable snapshot, activity, workspace and local identities; `statusLine: false` hides the rows |
| `createAgentTuiDiagnosticRecorder` / `AgentTuiDiagnosticEventSchema` | function / schema | bounded per-session metadata journal that rejects prompt, reasoning, tool-input and provider-cause payloads before disk admission |

The `stitchkit-agent` binary loads `stitchkit.agent.ts` by default and also exposes `sessions`,
`status`, `send` and `interrupt`. `--workspace` addresses a host outside the caller's cwd,
`send --idempotency-key` accepts caller-owned retry identity, and `interrupt` defaults to the
active run returned by `status`. Session descriptors and sockets are local control credentials,
not a remote API.
Interactive `/resume` and `/sessions` open the durable conversation picker. `/clear` creates a new
conversation and keeps the previous one available there; it is not a viewport-only operation.
The slash palette owns its highlighted selection: Up/Down move it, Tab completes it, Enter runs
the exact command and Escape dismisses it. Partial input is never submitted while the palette is
active; unknown slash text with no match remains an ordinary model prompt.

### `stitchkit-tui/core`

Renderer-neutral state only. This entrypoint imports neither React/OpenTUI nor the agent runtime.

| Export | Kind | Summary |
|--------|------|---------|
| `createTerminalCollection` / `reduceTerminalCollection` | function | identity-stable live collection selection, reconciliation, windowing and resize |
| `createTerminalFeedViewport` / `reduceTerminalFeedViewport` | function | generic follow-tail, history anchoring, unseen and bounded visible-range state |
| `createTerminalPaneState` / `reduceTerminalPaneState` | function | bounded split-pane focus, resize and single-pane collapse |
| `createTerminalCommandPalette` / `terminalCommandMatches` | function | bounded command filtering and keyboard selection over a collision-validated registry |
| `resolveExactTerminalCommand` / `validateTerminalCommands` | function | exact dispatch and fail-closed name/alias validation |
| `createTerminalOperationState` / `reduceTerminalOperationState` | function | confirmation and single-pending-operation lifecycle |

## `stitchkit/agent-runtime/sqlite/node`

Node 22.5+ built-in SQLite persistence. It shares the schema and semantics of
the Bun leaf but imports only `node:sqlite`.

| Export | Kind | Summary |
|--------|------|---------|
| `createNodeSqliteAgentRuntimeStore` | function | open an owned Node `DatabaseSync`, initialize/validate schema v1 and return `{ store, close }` |
| `NodeSqliteAgentRuntimeStoreConfig` | _type_ | database filename plus optional read-only and initialization policies; read-only requires an initialized schema |
| `createSqliteAgentRuntimeStore` / `initializeAgentRuntimeSqlite` | function | shared normalized adapter and namespaced schema lifecycle |
| `AgentRuntimeSqliteDatabase` / `AgentRuntimeSqliteStatement` / `AgentRuntimeSqliteValue` | _type_ | minimal runtime-neutral synchronous SQLite boundary |
| `SqliteAgentRuntimeStore` / `SqliteAgentRuntimeStoreConfig` | _type_ | durable store handle, owned connection lifecycle and initialization policy |

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
| `mountAgent` | function | a Vercel AI SDK `ToolSet` from a service; failed executions reject through the SDK tool-error channel with a safe typed envelope, while successful output is never classified by field name — [guide](../guide/mcp-and-agents.md#ai-agents--mountagent) |
| `defineRuntimeTool` | function | define one validated pathless operation for explicit MCP, Agent and/or CLI surfaces — [guide](../guide/mcp-and-agents.md#pathless-runtime-tools-and-multimodal-results) |
| `createRuntimeToolFactory` | function | bind shared identity and Zod-validated per-call context for runtime tools — [guide](../guide/mcp-and-agents.md#pathless-runtime-tools-and-multimodal-results) |
| `createToolInvoker` | function | compile an exposure-aware in-process dispatcher over the canonical tool runner; use peer-free `stitchkit/tools/invoker`, or the full `stitchkit/tools` adapter barrel — [guide](../guide/mcp-and-agents.md#in-process-calls--createtoolinvoker) |
| `createCli` | function | a command-line program from contracts — [guide](../guide/cli.md) (also on `stitchkit/cli`) |
| `defineCliCommand` | function | define one typed CLI-only command with optional post-validation `present` and successful `exitCode` policy — [guide](../guide/cli.md#native-binary-commands) (also on `stitchkit/cli`) |
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
| `CliConfig` | _type_ | config for `createCli`, including program-level `defaultCommand` selection and command-scoped `optionAliases` / `positionals` policy |
| `CliPresentationPolicyConfig` | _type_ | reusable default-command, short-alias and explicit-positional policy inherited by `CliConfig` |
| `CliSurfaceSource` | _type_ | static managed surface or identity-dependent surface factory for `createCli` |
| `CliCommandDefinition` | _type_ | Zod-first CLI-only command union |
| `CliCommandDefinitionBase` | _type_ | native command name, description and input schema |
| `CliCommandDefinitionWithOutput` | _type_ | native command with declared output schema, validated handler result and typed optional `present` / `exitCode` callbacks |
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
| `defineAsyncOperation` | function | runtime-only start/status/wait plus configured cancel/result/artifacts definitions; see the [durable application-owned recipe](../guide/mcp-and-agents.md#durable-application-owned-execution) |
| `defineAsyncOperationContract` | function | define one canonical Zod-first HTTP contract for start/status/wait plus optional capabilities; execution and recovery remain application-owned |
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
| `runAgentStoreConformance` | function | reusable black-box duplicate/coalescing/stale/recovery contract for durable agent-store adapters |
| `AgentStoreConformanceConfig` | _type_ | `{ createStore(context), cleanup?(context) }` — the factory the contract runs against, plus a teardown that runs once whether the scenario passed or failed |
| `AgentStoreConformanceContext` | _type_ | `{ conversationIds }` — every conversation the scenario will mutate, handed over **before** the first mutation so an adapter can provision application-owned parent rows; a zero-argument factory stays valid |
| `runManagedResourceConformance` | function | run the canonical deterministic lifecycle matrix against a fresh consumer-owned `ManagedResource` fixture; resolves `void` or throws `ManagedResourceConformanceError` with a stable scenario ID and normalized trace |
| `ManagedResourceConformanceScenarioIdSchema` / `ManagedResourceConformanceScenarioId` | schema / _type_ | stable clean, rollback, readiness/completion, activation, shutdown-race and forced-cleanup scenario vocabulary |
| `ManagedResourceConformanceScenarioSchema` / `ManagedResourceConformanceScenario` | schema / _type_ | discriminated scenario record including whether the controlled resource is required |
| `ManagedResourceConformanceTraceEntrySchema` / `ManagedResourceConformanceTraceEntry` | schema / _type_ | sequence-numbered phase/outcome diagnostic without timestamps or generated IDs |
| `ManagedResourceConformancePhaseSchema` / `ManagedResourceConformancePhase` | schema / _type_ | lifecycle and disposal trace phases |
| `ManagedResourceConformanceTraceOutcomeSchema` / `ManagedResourceConformanceTraceOutcome` | schema / _type_ | normalized `enter`, `resolve` or `reject` outcome |
| `ManagedResourceConformanceConfig` | _type_ | fresh-fixture factory, optional scenario subset and emergency watchdog bound |
| `ManagedResourceConformanceFactoryInput` / `ManagedResourceConformanceControls` | _type_ | current discriminated scenario and caller-controlled startup, readiness, completion, activation, close and force promises |
| `ManagedResourceConformanceFixture` | _type_ | tested resource plus required bounded disposal callback |
| `ManagedResourceConformanceError` | class | `MANAGED_RESOURCE_CONFORMANCE_FAILED` diagnostic carrying scenario, expected phase subsequence and observed trace |
| `createAgentRaceBarrier` / `createAgentRaceDriver` / `createAgentRaceTrace` | function | bounded named barriers and exact partial-order traces for deterministic runtime race probes |
| `AgentRaceBarrier` / `AgentRaceDriver` / `AgentRaceTrace` / `AgentRaceTraceEntry` | _type_ | public packed-consumer types for the deterministic race harness |
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
| `RealtimeProbeFixture` / `RealtimeProbeScenario` | _type_ | driver input and supported event/ack/local-invalid/peer-refusal/disconnect/timeout scenario vocabulary |
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

## `stitchkit/telegram`

Peer-free server-only Telegram platform primitives. Importing this resolves no
bot library; `stitchkit/application/grammy` remains the lifecycle adapter for an
injected grammY bot. → ADR 0143

| Export | Kind | Summary |
|--------|------|---------|
| `verifyTelegramInitData` | function | verify a Mini App `initData` signature against the bot token in constant time, before reading anything out of it |
| `VerifyTelegramInitDataOptions` | _type_ | raw `initData`, bot token, optional `maxAgeSeconds` bound and injected clock |
| `TelegramInitDataVerification` | _type_ | `{ valid: true, data }` or a refusal carrying its reason |
| `TelegramInitData` | _type_ | verified `user`/`receiver`, `authDate`, `ageSeconds`, `queryId`, `startParam`, `chatType`, `chatInstance` and every signed pair in `raw` |
| `TelegramInitDataUser` | _type_ | camelCase user record inferred from Telegram's signed `user` payload |
| `TelegramInitDataRefusal` | _type_ | `missing-hash` / `signature-mismatch` / `malformed` / `expired` — an expired string is not a forged one |
| `classifyTelegramSendFailure` | function | name a refused Bot API send and separate "retry this send" from "stop addressing this recipient" |
| `TelegramSendFailure` | _type_ | reason, `status`, Telegram-stated `retryAfterSeconds`, `retryable`, `recipientUnreachable` and which evidence produced the answer |
| `TelegramSendFailureReason` | _type_ | `blocked-by-user` / `user-deactivated` / `chat-not-found` / `not-started` / `rate-limited` / `message-invalid` / `server-error` / `unknown` |

---

## `stitchkit/declaration`

Zod-only, dependency-free. The **project declaration**: the single
machine-readable statement a repository makes about itself, read by the project,
by the scaffolder that writes the first copy, and by whatever builds a source and
binds the artifact into a deployment. It ships from the framework so those
readers cannot hold different copies of the same schema.

`identity` identifies the repository-local buildable source/artifact, not a product project, checkout
or harness workspace. Product↔repository membership is explicit and many-to-many, owned by an
external registry; dependency edges do not establish membership. Private companion context is never
required in this public schema. See [identity boundaries](../guide/declaration.md#identity-is-not-product-membership).

**Declaring yourself is optional.** A project with no `project.json` is a
complete project: nothing else in the framework imports this entrypoint, no
build, test or start path looks for a declaration, and its absence is never an
error or a warning.

The rule the schema exists to hold: **a declaration must be complete and
meaningful when no machine exists**. A field that cannot be filled in without
knowing where the code will run is a binding supplied by the deployment, not a
declaration made by the repository.

**Structure is the guarantee**: nothing here requires a value of the place. A
command is `executable` plus an `args` array, no part may be an absolute path or
carry an inline value (`--port=8080` must be `['--port', '8080']`), paths are
repository-relative, bindings are named by variable and never valued, and a
listener's variables must exist in `env.variables` with matching shapes.

**Hygiene is the filter**: every remaining free string is checked against
`namesAMachine` — a scheme, a protocol-relative host, an absolute or
home-relative path, a Windows drive, a `host:port` pair, a bare IPv4 literal —
and a number after a port flag is refused. It catches known shapes; it is not a
secret scanner, and a secret or hostname written as a plain argument passes.

Unknown keys are **refused**, not stripped. A key one reader does not recognise
is a disagreement between programs that never meet, and discarding it silently
is how a partially understood declaration becomes a running, wrong deployment.

| Export | Kind | Summary |
|--------|------|---------|
| `ProjectDeclarationSchema` / `ProjectDeclaration` | schema / _type_ | the declaration: `schemaVersion`, `kind`, `identity`, `roles`, `build`, `requires`, `release`, `env` |
| `parseProjectDeclaration` | function | parse a declaration, refusing an unrecognised `schemaVersion` **before** any field is read |
| `PROJECT_DECLARATION_SCHEMA_VERSION` | constant | the declaration format this build understands — the number a reader refuses on |
| `namesAMachine` | function | why a string names a particular machine, or `undefined` — the one predicate every free string is checked against |
| `findProjectRole` | function | the role with a given name, or `undefined` |
| `ProjectIdentitySchema` / `ProjectIdentity` | schema / _type_ | `slug`, `name`, `version` and a per-locale `description` |
| `ProjectRoleSchema` / `ProjectRole` | schema / _type_ | one runnable role: a `workingDirectory` inside the source, per-mode `commands`, an optional `listener`, and `drainFloorMs` |
| `ProjectCommandSchema` / `ProjectCommand` | schema / _type_ | `executable` plus `args` — argv, never a shell string |
| `ProjectRoleCommandSchema` / `ProjectRoleCommand` | schema / _type_ | a command run under a supervisor: additionally never a script runner, because a launcher duplicates the shutdown signal |
| `ProjectListenerSchema` | schema | `portVariable`, `bindVariable` and `readinessPath` — **absent means the role has no listener at all** |
| `ProjectRunModeSchema` | schema | the run modes a role declares commands for |
| `ProjectBuildSchema` | schema | build `command`, the set of `artifacts` it produces — more than one path is normal — and any declared data `inputs` |
| `ProjectBuildInputSchema` / `ProjectBuildInput` | schema / _type_ | data the build may read: a `name`, a frozen export `path` inside the source, and the `sha256:` `digest` that pins its bytes. **Absent `inputs` means the build reads no data** — an answer, not a gap |
| `ProjectRequirementSchema` / `ProjectRequirementPhaseSchema` | schema | something the code needs but does not provide, and the `phases` — `release`, `start` — it is needed in |
| `ProjectReleaseSchema` / `ProjectMigrationsSchema` | schema | what must happen once before roles start; migrations are declared as `engine`, `root` and `lockfile` — **bytes, not a command to run** |
| `ProjectEnvVariableSchema` / `ProjectEnvVariable` / `ProjectEnvShapeSchema` | schema / _type_ | a variable a deployment must supply: `name`, `shape`, `required`, and `members` for an enum |
| `ProjectSlugSchema` | schema | lowercase hyphen-separated identity everything else is named after |
| `ProjectDescriptionSchema` | schema | description per locale tag |
| `RepositoryPathSchema` | schema | a path inside the source — absolute, `..`, `~` and Windows paths are refused |
| `BindingVariableSchema` | schema | the NAME of an environment variable a deployment fills in |

Version handling is **fail-closed**: an unrecognised `schemaVersion` is refused,
never assumed compatible, and refused before any field is read so a newer
declaration reports as a version this build cannot serve rather than as a list of
unrecognised keys.

To compose a stricter declaration, build on the exported member schemas — for
example `ProjectDeclarationSchema.safeExtend({ identity: … })`, which keeps the
boundary refinements in force. `ProjectDescriptionSchema` is a record, so narrow
it by replacing the field rather than extending it.

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
| `createUnixClientTransport` | function | the same fail-closed Bun/Node Unix client adapter exported by `stitchkit/server` |
| `implement` / `createImplement` / `createScopedImplement` / `createScopedImplementRegistry` / `createMultipartStream` | function | bind a contract to typed handlers, optionally typed per endpoint scope (same as `/server`) |
| `NodeServerConfig` | _type_ | config for `serveNode` |
| `NodeServerHandle` | _type_ | managed Node handle (`url`, `port`, `runtime`, `status`, `shutdown`) |
| `NodeRuntimeServer` | _type_ | concrete `srvx/node` runtime escape hatch |
| `NodeSocketLifecycle` | _type_ | Bun-free Socket.IO lifecycle accepted by `serveNode` |
| `HandlerConfig` / `ServiceDef` / `RawRoute` / `RawRouteContext` | _type_ | runtime-neutral handler types; raw routes default their host server to `unknown` |
| `SocketIORequestPolicy` / `SocketIOServerConfig` / `SocketIOPeerLoaders` / `SocketIOServerHandle` | _type_ | runtime-neutral handshake policy, config, optional-peer loaders and the Bun-free Node handle with `io`, `attach` and lifecycle |
| `UnixClientTransportConfig` / `UnixClientTransport` | _type_ | Unix socket bounds, explicit response-body mode and owned Fetch-compatible handle |
| `UnixResponseBodyMode` | _type_ | finite cumulative `bounded` mode or explicit pull-driven `streaming` mode |
| `UnixClientTransportError` / `UnixClientTransportErrorCode` / `UnixClientDeliveryState` | class / _type_ | stable failure plus dispatch certainty; no cross-transport fallback |
| `AppError` + `appError` / `badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `rateLimited` | — | error helpers (same as `/contract`) |

---

## `stitchkit/cli`

Server-only. Composes contract/runtime managed operations and CLI-only native
commands into one command-line program. Light by design: needs neither the MCP
SDK nor the `ai` peer.

| Export | Kind | Summary |
|--------|------|---------|
| `createCli` | function | build and run a CLI from contracts — [guide](../guide/cli.md) |
| `defineCliCommand` | function | define one Zod-typed CLI-only executable command with optional validated-result presentation/exit policy |
| `parseCliArgs` | function | argv → typed tool args against a schema (advanced) |
| `pollUntilDone` | function | the generic `--wait` poller (advanced) |
| `emitResult` | function | write a pretty or compact `ToolResult` record to stdout/stderr + exit code (advanced) |
| `DEFAULT_EXIT_CODES` | const | the default `ToolResult.code` → exit-code map |
| `CliConfig` | _type_ | config for `createCli`; `defaultCommand`, `optionAliases` and `positionals` define the shared command presentation policy |
| `CliPresentationPolicyConfig` | _type_ | shared command presentation-policy subset of `CliConfig` |
| `CliSurfaceSource` | _type_ | static service/runtime array or identity-dependent factory |
| `CliCommandDefinition` | _type_ | native command definition union |
| `CliCommandDefinitionBase` | _type_ | native command name, description and input schema |
| `CliCommandDefinitionWithOutput` | _type_ | native command with validated declared output and typed optional `present` / successful `exitCode` callbacks |
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
| `EntityCacheMembership` / `EntityCacheMembershipPolicy` | _type_ | per-exact-query `include | exclude | unknown` filter decision and unknown invalidation policy |
| `EntityCacheTotalPolicy` / `EntityCacheTotalDeltaInput` | _type_ | evidence-aware reconciliation of numeric totals on paginated cache shapes |
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
