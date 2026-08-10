# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

A release that breaks a public API leads its entry with a **`### ⚠️ Breaking
changes`** section (with before → after migration snippets); a version without
that section is purely additive. To move a project across versions, see
[`docs/guide/upgrading.md`](docs/guide/upgrading.md). **0.1.0–0.7.0 were all
additive**; the first breaking change landed in 0.10.0. Grep the file for
`⚠️ Breaking changes` to find every one.

## [Unreleased]

## [0.46.0] — 2026-08-10

### ⚠️ Breaking changes

- **`STITCH_ERROR_STATUS` gained `REALTIME_CONTRACT_VIOLATION`** — realtime
  contract failures use the framework error model instead of a bare `ZodError`.
  An exhaustive `satisfies Record<StitchErrorCode, …>` code map no longer
  compiles until the new code is added.
  `// before: { …, INTERNAL_SERVER_ERROR: 'internal' } satisfies Record<StitchErrorCode, string>` →
  `// after:  { …, INTERNAL_SERVER_ERROR: 'internal', REALTIME_CONTRACT_VIOLATION: 'internal' } satisfies Record<StitchErrorCode, string>`
- **`RealtimeRejectedEvent.error` is an `AppError`, not a `z.ZodError`** — the
  rejection envelope carries `reason` and `fault`, and the original `ZodError`
  (when one exists) moves to `error.cause`.
  `// before: onRejected: ({ error }) => error.issues` →
  `// after:  onRejected: ({ error }) => error.details?.issues (cause: error.cause)`
- **CLI construction is strict about reserved names.** A contract field or tool
  named `json`, `wait`, `quiet`, `dry-run`, `help`, `version`, `wait-timeout` or
  `output-dir` now **throws while building the CLI** instead of being silently
  shadowed; unknown flags, repeated scalar flags, a plain flag combined with a
  dotted flag over the same root, and `--json=<junk>` all exit non-zero instead
  of corrupting arguments.
  `// before: app schedule_job --wait 2h  → {"path":"2h"}, exit 0` →
  `// after:  building a CLI over a contract with a "wait" field throws`
- **`createToolLogger` writes to `console.error` by default** (stderr). stdout
  is the JSON-RPC channel of a stdio MCP server, and the old `console.info`
  default corrupted it. Pass `log` to redirect.
  `// before: createToolLogger() → stdout` → `// after: createToolLogger() → stderr`
- **An origin-less `cors` config is a construction error, not a wildcard.**
  `createServer({ cors: {} })` and `cors: { origin: undefined }` used to emit
  `Access-Control-Allow-Origin: *`; a missing security setting no longer picks
  the most permissive behaviour. Allowing every origin stays available as an
  explicit opt-in.
  `// before: cors: {}  → Access-Control-Allow-Origin: *` →
  `// after:  cors: { origin: '*' }  (explicit), cors: {} throws`
- **JSON coercion skips unions with any string member.** A tool argument
  declared `z.union([z.string()…, T])` (including constrained strings: `uuid`,
  `email`, `min`) receives the raw string; a double-serialized value is only
  repaired when NO union member accepts a string. Identifiers such as `"123"`
  or `"null"` can no longer silently change type.
  `// before: union[uuid, number] + "123" → 123` →
  `// after:  union[uuid, number] + "123" → validation error on the string`
- **Default audit masking matches whole words.** `sanitizePayload`/`redact`
  mask a key when one of its words is a secret term (`sessionToken`,
  `X-Api-Key`), and keep identifiers that merely contain one (`authorId`,
  `sessionCount`, `tokenizer`) — previously matching was substring-based and
  destroyed audit identifiers. Pass `sensitiveKeys` to restore any custom
  policy.
  `// before: authorId → "[redacted]"` → `// after: authorId survives, sessionToken → "[redacted]"`

### Added

- **Bounded in-memory state.** `createCache({ maxEntries })` and
  `createCacheBridge({ maxFreshKeys })` use deterministic oldest-first eviction;
  cache bridges expose `clearFresh()` and expire markers at the end of their
  freshness window.
- **Directly testable MCP preparation.** Immutable MCP descriptors are prepared
  by a dedicated module while the public `stitchkit/tools` surface remains
  unchanged.
- **Structured realtime contract failures.** Rejections identify event,
  direction, phase and local/peer fault through the registered
  `REALTIME_CONTRACT_VIOLATION` error code and `StitchLogger`.

### Fixed

- **Realtime rooms and reconnect recovery.** Server, connected-socket and
  emit-only room targets now resolve only the capabilities they use; manual
  `connect()` recovers after Socket.IO exhausts its automatic retry budget.
- **Fail-closed endpoint ownership.** MCP Host/Origin checks, implementation
  lookup, auth middleware and object registries reject prototype-chain and
  missing-handler fallthroughs.
- **Model-controlled I/O is bounded.** Guarded fetches enforce one header
  deadline across DNS and every redirect hop plus a separate body deadline
  (`ViewFileOptions.timeoutMs`, `DownloadToolConfig.timeoutMs`,
  `CliConfig.downloadTimeoutMs`); `view_file` caps the number of requested
  targets, charges its byte budget by what was actually read and never
  downloads a `video/*` body.
- **Observability cannot break observed work.** Audit projection, sanitization,
  size measurement and async sinks tolerate bigint, cycles, unreadable getters
  and sink failures; trace sampling flags are preserved exactly.
- **Browser response parity.** Blob failures follow the same `ApiError` and
  `network_error` normalization path as JSON and raw-response requests.
- **CLI parsing is strict.** Reserved-name collisions, misplaced positional
  arguments, unknown flags and unsupported options fail with direct diagnostics;
  stdio defaults never write logs into the JSON-RPC channel.
- **MCP/OAuth policy validation.** MRTR policy is validated while building the
  surface, audit rows carry round/outcome metadata, and CIMD resolution has
  strict HTTP caching plus two-level rate limits
  (`CimdCachePolicy.maxResolutionsPerClient` / `maxResolutions` per
  `resolutionWindowMs`) with separate positive/negative cache pools, so a flood
  cannot evict warmed clients and one client cannot lock out the rest.
- **Contract presentation correctness.** JSON coercion no longer corrupts
  string unions, query dehydration retains successful prefetched data, SSE
  cancellation is quiet while generator failures remain visible, and static
  routes reject symlinks escaping their declared root.

## [0.45.0] — 2026-08-10

### Added

- **Zod-first realtime contracts over Socket.IO.** `defineRealtimeContract`
  describes variadic event tuples and acknowledgements once;
  `bindRealtimeServer` and `createRealtimeClient` infer both event maps and
  validate inbound arguments, outbound payloads and acknowledgement values.
  Handshake auth, rooms and delivery policy remain application-owned, while
  durable subscriptions, retained events and the cache bridge keep their
  existing Socket.IO behavior.

## [0.44.1] — 2026-08-10

### Documentation

- **Clarified dual-era MCP output semantics.** The migration guide and 0.44.0
  release notes now distinguish exact JSON roots on protocol `2026-07-28` from
  the official legacy codec's `{ result: value }` adaptation, with a pinned
  consumer E2E example for both eras.

## [0.44.0] — 2026-08-10

### ⚠️ Breaking changes

- **MCP uses the split TypeScript SDK v2 packages and a closeable stateless
  handler.** Replace `@modelcontextprotocol/sdk` with
  `@modelcontextprotocol/server@^2` for server surfaces and
  `@modelcontextprotocol/client@^2` only for hosts/tests. `createMcpHandler`
  now returns `{ fetch, close }`; mount it through `createMcpHttpRoute` and
  close it during graceful shutdown. HTTP session modes, event stores and
  `Mcp-Session-Id` continuity are removed.

  ```ts
  // before
  const handleMcp = createMcpHandler({ ...config, sessionMode: 'stateless' })
  rawRoutes: [{ method: 'ALL', path: '/mcp', handler: handleMcp }]

  // after
  const mcp = createMcpHandler({ ...config, legacy: 'serve' })
  rawRoutes: [createMcpHttpRoute({ path: '/mcp', handler: mcp })]
  await mcp.close()
  ```

- **Stdio servers return an owned transport handle.** Keep and close the result;
  `legacy: 'serve' | 'reject'` controls official protocol-era negotiation.

  ```ts
  // before
  await createStdioMcpServer(config)

  // after
  const stdio = await createStdioMcpServer({ ...config, legacy: 'serve' })
  await stdio.close()
  ```

- **OAuth client registration is one explicit policy object with CIMD as the
  default.** Move application-owned clients under `clientRegistration`.
  Dynamic Client Registration is disabled unless `dcr` is supplied, and only
  then appears in discovery or mounts `/register`.

  ```ts
  // before
  mountOAuthProvider({ ...config, clients })

  // after
  mountOAuthProvider({
    ...config,
    clientRegistration: {
      preRegistered: { get: clients.get },
      // optional: dcr: { register: clients.register, get: clients.get }
    },
  })
  ```

- **OAuth consent returns the scopes it actually approved.** `authorizeUser`
  must return `approvedScopes`; token issuance no longer assumes that every
  requested scope was approved. Missing or malformed values fail loudly at the
  boundary.

  ```ts
  // before
  authorizeUser: async () => ({ userId })

  // after
  authorizeUser: async (_req, request) => ({
    userId,
    approvedScopes: request.scope?.split(' ') ?? [],
  })
  ```

- **MCP non-object outputs keep their declared JSON shape in the modern
  protocol.** MCP `2026-07-28` permits any JSON root value, so Stitchkit no
  longer adds an artificial `result` property on that wire path. When
  `legacy: 'serve'` negotiates a supported older era, the official SDK codec
  still adapts a non-object value to `{ result: value }`.

  ```ts
  // before: structuredContent === { result: ['a', 'b'] }
  // modern 2026-07-28: structuredContent === ['a', 'b']
  // supported legacy:  structuredContent === { result: ['a', 'b'] }
  ```

### Added

- **MCP `2026-07-28` transport semantics.** HTTP and stdio use official v2
  factories, support deterministic modern discovery, explicit cache hints,
  strict Host/Origin and protocol-header validation, cancellation and one
  optional legacy stateless boundary without a parallel framework transport.
- **Typed multi-round `input_required`.** Contract and runtime tools can declare
  a Zod input gate. Signed continuation state is bound to principal, operation
  and original arguments; accepted content reaches `ctx.mcpInput`, while every
  attempt retains isolated context, lifecycle and tool hooks.
- **Client ID Metadata Documents.** OAuth resolves pre-registered clients, then
  SSRF-safe HTTPS CIMD, then explicitly enabled DCR. Metadata fetching is
  DNS/IP-pinned, size/time/redirect bounded and backed by a bounded HTTP-aware
  cache.
- **Exact MCP JSON output schemas.** Object, array, string, number, boolean and
  nullable contract/runtime outputs are advertised and returned unchanged;
  tools without an output contract emit neither `outputSchema` nor
  `structuredContent`.
- **MCP OpenTelemetry propagation.** Framework-owned contract and runtime tools
  continue SDK v2 request `_meta.traceparent`, retain bounded `tracestate` and
  `baggage` in the isolated request context, and expose one consistent trace to
  handlers, hooks and audit on HTTP and stdio. MCP metadata wins over an
  ambient HTTP trace when present; malformed values start a fresh local trace
  without becoming authentication input.

## [0.43.1] — 2026-08-09

### Fixed

- **Browser `ApiError` preserves backend request correlation.** Both the bare
  contract client and the Ky-backed HTTP client now expose a response's
  `x-request-id` as readonly `error.traceId`, including their unstructured
  non-2xx fallbacks. Network and abort errors without an HTTP response leave
  the optional field undefined; the wire error envelope is unchanged.

## [0.43.0] — 2026-08-08

### ⚠️ Breaking changes

- **HTTP observability is framework-owned and wrapper-free.**
  `createObservability` replaces `createAuditHook`; request and tool sinks are
  configured independently. Pass the request projection directly to the server
  and the tool projection to mounts. HTTP payload capture is now off by default
  and explicit through `includePayload: true`.

  ```ts
  // before
  const audit = createAuditHook({ write })
  createServer({
    services,
    wrapFetch: (handler) => wrapInRequestContext(audit.http(handler)),
  })
  mountAgent(services, { hooks: audit.toolCall })

  // after
  const observability = createObservability({
    request: { write, includePayload: true },
    tools: { write },
  })
  createServer({ services, observability: observability.request })
  mountAgent(services, { hooks: observability.toolCall })
  ```

  There is no `createAuditHook` alias or HTTP audit wrapper. Keep
  `includePayload` false when the request row does not need a body.

### Fixed

- **Flattened divergent tool fields retain every known JSON kind.** When a
  discriminated union reuses a property as different visible kinds, the flat
  MCP/Agent presentation now emits a sound deterministic `type` array instead
  of `{}`. Nested union branches contribute their base kind, nullability is
  preserved, `integer | number` widens to `number`, and genuinely unknowable
  branches remain visible to `requireTypedProperties`. Runtime Zod validation
  and unflattened schemas are unchanged.

- **`createContractFactory` now exposes its guaranteed scope as required.** A
  factory-defined contract's `meta.scope` is the exact concrete literal rather
  than `TScope | undefined`; plain `defineContract` keeps its optional/default
  public model. The new `ScopedContractDef` type names the stronger shape.

### Added

- **Context-validated runtime-tool factories.**
  `createRuntimeToolFactory({ serviceName, scope, context })` binds stable
  identity once and parses the Zod context once per invocation, so each
  definition's handler receives typed context plus parsed input without local
  adapters. The result remains an ordinary `RuntimeToolDefinition` for every
  mount, manifest and invoker.

- **Opt-in explicit contract tool exposure.**
  `createContractFactory<Scope>({ toolExposure: 'explicit' })` materializes a
  missing endpoint `expose` as `['HTTP']`; MCP, Agent and CLI surfaces then
  require an explicit declaration. Plain factories retain the default-on tool
  policy.

## [0.42.0] — 2026-08-08

### ⚠️ Breaking changes

- **Tool introspection now takes one mixed surface object.**
  `buildToolManifest`, `listToolNames` and `summarizeTransports` resolve contract
  services plus pathless runtime definitions through the same canonical
  collector as the mounts. `ToolNameEntry` adds its origin; transport summaries
  expose explicit contract/runtime counts and a mixed `sources` breakdown.

  ```ts
  // before
  buildToolManifest(services.flatMap((service) => collectTools(service, 'AGENT')))
  listToolNames(services)
  summarizeTransports(services)

  // after
  const surface = { services, runtimeTools }
  buildToolManifest({ ...surface, transport: 'AGENT' })
  listToolNames(surface)
  summarizeTransports(surface)
  ```

- **Managed MCP runtime tools are declarative; `nativeTools` is removed.** A
  protected `defineRuntimeTool` now belongs in the surface's `runtimeTools`
  array, so its schemas and presentation metadata can be prepared once. The
  deliberately unprotected SDK escape hatch is now the explicit `rawTools`
  callback.

  ```ts
  // before — protected registrar
  nativeTools: ({ registerTool }) => registerTool(preview)
  // after — protected immutable definition
  runtimeTools: [preview]

  // before — raw SDK opt-out
  nativeTools: ({ rawServer }, auth) => mountRaw(rawServer, auth)
  // after — raw SDK opt-out
  rawTools: (server, auth) => mountRaw(server, auth)
  ```

- **`defineErrors` now takes object definitions and returns constructors.**
  Each code declares `{ status, details? }`; the optional details schema is the
  runtime and TypeScript source of truth. Generated functions accept one named
  options object and return a literal-code `AppError` for the caller to throw.
  Positional throwers and numeric definitions are removed without aliases.

  ```ts
  // before
  const { errors } = defineErrors({ QUOTA_EXCEEDED: 429 })
  errors.QUOTA_EXCEEDED('Try later', { retryAfterSeconds: 30 }, 'Wait')

  // after
  const { errors } = defineErrors({
    QUOTA_EXCEEDED: {
      status: 429,
      details: z.object({ retryAfterSeconds: z.number().positive() }),
    },
  })
  throw errors.QUOTA_EXCEEDED({
    message: 'Try later',
    details: { retryAfterSeconds: 30 },
    hint: 'Wait',
  })
  ```

### Added

- **Unified contract/runtime introspection.** Mixed manifests use the exact
  immutable presentation schema advertised by MCP/Agent, honour transport
  filters, preserve mount order and fail first on cross-origin name collisions;
  name snapshots and boot summaries now include runtime identities too.

- **Async, endpoint-aware `createErrorHook`.** Its observer and renderer may now
  await identity/audit enrichment and receive the matched operation; failures
  before route resolution receive `undefined`. The observer completes before
  rendering, so the response can use the enriched request context.
- **Finite prepared MCP surface registries.** Declare bounded
  `{ services, runtimeTools }` entries under `surfaces` and select one with a
  typed `selectSurface(auth)` key. Every entry is validated and compiled once;
  each request/session still receives a fresh server, auth context, lifecycle
  runner and isolated tool-call context. Direct identity factories remain
  uncached for genuinely arbitrary surfaces.
- **Typed domain error definitions.** `defineErrors` exposes its frozen
  `definitions` registry, preserves literal codes and schema-parsed details on
  constructed `AppError` instances, and derives `codes` / `isCode` from the
  same source.

## [0.41.0] — 2026-08-07

### ⚠️ Breaking changes

- **Contract output presence now comes only from `output`.** A nullable output
  returns JSON `null` with status `200`; `undefined` for a declared output and
  non-null data without an output schema are handler contract violations on
  HTTP and tool transports. Typed clients return `null` for nullable output and
  `undefined` only for endpoints without output.

  ```ts
  // before: null was converted to 204 and then failed against the output
  result: { output: ResultSchema.nullable(), handler: () => null }

  // after: 200 application/json with body `null`
  result: { output: ResultSchema.nullable(), handler: () => null }
  ```

  A handler that intentionally returns data must declare its schema; a handler
  with no result must omit `output` and return `undefined` or `null`. Runtime
  tools without `output` now type their handler as void; add an output schema
  before returning neutral data.

## [0.40.0] — 2026-08-07

### ⚠️ Breaking changes

- **`createToolInvoker` runtime state is now per invocation.** The factory only
  compiles exposure, extension and argument-presentation policy; move
  `source`, `context`, `lifecycle`, `hooks` and `onOutputStrip` to the third
  argument of `invoke`. This prevents a reusable registry from retaining one
  request identity.

  ```ts
  // before
  const invoker = createToolInvoker(services, {
    transport: 'AGENT', context: { identity }, lifecycle, hooks,
  })
  await invoker.invoke(name, args)

  // after
  const invoker = createToolInvoker(services, { transport: 'AGENT' })
  await invoker.invoke(name, args, { context: { identity }, lifecycle, hooks })
  ```

### Added

- **Throwing in-process tool composition.** `invokeOrThrow` returns validated
  data or throws the runner's exact normalized `AppError`, preserving custom
  code/status/message/details/hint while unexpected errors remain scrubbed.
- **Literal-preserving scoped contract factory.** `createContractFactory`
  retains each contract's concrete scope literal while still constraining it to
  the application's allowed scope union, so scope-aware registries infer the
  exact config without a consumer wrapper.
- **Scope-aware URL builder registry.** `createScopedUrlBuilders` selects
  dynamic prefix configuration from each contract's literal scope and composes
  multiple contracts into one typed URL namespace, mirroring
  `createScopedClients` without duplicating the request planner.

## [0.39.0] — 2026-08-07

### ⚠️ Breaking changes

- **Protected native MCP handlers now return neutral output.** The MCP-only
  `NativeMcpToolDefinition`, `NativeMcpOperationIdentity`,
  `NativeMcpHandlerContext` and `NativeMcpResult` types are removed. Define a
  shared runtime operation; move MCP content and metadata into `present.mcp`.
  Stitchkit owns validated `structuredContent` and `isError`.

  ```ts
  // before
  registerTool({ input, output, handler: async () => ({
    content: [{ type: 'image', data, mimeType: 'image/png' }],
    structuredContent: { assetId },
  }) })

  // after
  const preview = defineRuntimeTool({
    input, output,
    handler: async () => ({ assetId, data }),
    present: {
      mcp: (result) => ({
        content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
      }),
    },
  })
  nativeTools: ({ registerTool }) => registerTool(preview)
  mountAgent(services, { runtimeTools: [preview] })
  ```

- **`createEntityCacheHandlers` now declares the real list shape and item
  projection.** The `listKey` shortcut and id-only `detailKey` callback are
  removed. This prevents an untyped helper from guessing cache envelopes,
  missing-update behavior or full-entity → list-item conversion.

  ```ts
  // before
  createEntityCacheHandlers<Entity>({
    getId, listKey: ['entities'], detailKey: (id) => ['entities', id],
  })

  // after
  createEntityCacheHandlers<Entity, EntityListItem>({
    getId,
    getListItemId: (item) => item.id,
    toListItem: projectEntity,
    list: {
      key: ['entities'],
      shape: 'paginated',
      createAt: 'start',
      updateMissing: 'skip',
    },
    detailKey: (event) => ['entities', event.id],
  })
  ```

- **Custom `HttpClient` adapters must implement `head`.** Contract-owned HEAD
  operations need an explicit transport primitive; the built-in
  `createHttpClient` already provides it.

  ```ts
  // before
  const http: HttpClient = { get, post, put, patch, delete, /* lifecycle */ }

  // after
  const http: HttpClient = { get, head, post, put, patch, delete, /* lifecycle */ }
  ```

- **Trailing wildcards are now named.** Bare `/*` and the magic `params['*']`
  key are removed. The name is shared by contract validation, router params,
  typed clients, raw routes and the OpenAPI extension.

  ```ts
  // before
  path: '/app/:slug/*'
  params: z.object({ slug: z.string(), '*': z.string() })
  ctx.params['*']

  // after
  path: '/app/:slug/*filePath'
  params: z.object({ slug: z.string(), filePath: z.string() })
  ctx.params.filePath
  ```

- **`HttpClientConfig.authEndpoints` is replaced by contract-derived expected-401
  matchers.** Broad manual prefix suppression could hide a real session expiry
  from a neighbouring endpoint. There is no default auth-path exception.

  ```ts
  // before
  createHttpClient({ baseUrl, authEndpoints: ['/api/auth/'] })

  // after
  createHttpClient({
    baseUrl,
    suppressUnauthorizedFor: contractEndpointMatchers(authContract, ['login', 'verify']),
  })
  ```

### Added

- **Framework-owned runtime tools for MCP and AI agents.**
  `defineRuntimeTool` describes a pathless operation once; protected MCP
  registration and `mountAgent({ runtimeTools })` share its identity, neutral
  handler, validation, lifecycle, hooks, audit and per-call context. Typed
  `present.mcp` and AI SDK `toModelOutput` adapters preserve multimodal content
  without a second execution engine. → ADR 0055

- **Entity cache adapters for real list shapes.**
  `createEntityCacheHandlers` now covers plain arrays, paginated lists and both
  infinite page forms; event-aware scoped keys, full-entity projection,
  explicit insertion/missing-update policies and backend-owned comparators stay
  type-safe while preserving page/envelope metadata. → ADR 0056

- **In-process contract tool invoker.** `createToolInvoker` compiles one
  exposure-aware name lookup and dispatches nested/parallel calls through the
  canonical tool runner—input/output validation, `ToolExtend`, lifecycle,
  hooks, isolation and output-strip reporting included—without mounting an AI
  SDK or MCP adapter.

- **Explicit contract-owned HEAD endpoints.** `method: 'HEAD'` is an HTTP-only
  `rawResponse` operation with normal routing, params, lifecycle/RBAC, logging,
  typed-client and OpenAPI coverage. GET never gains an implicit HEAD alias,
  and Stitchkit strips any accidental response body while preserving status
  and headers.

- **Scope-aware composed clients.** `createScopedClients` routes each contract by
  its typed `meta.scope`; arrays merge contracts into one namespace with
  fail-first duplicate detection.
- **URLs for every HTTP operation.** `createUrlBuilder` and
  `createUrlBuilders` now include POST, PUT, PATCH, DELETE and multipart
  operations. Body methods accept only scoped-prefix and path params; body/file
  fields are neither required nor silently serialized.
- **Contract-derived expected-401 policy.** `contractEndpointMatchers` compiles
  exact operation paths, including params, dynamic scoped prefixes and trailing
  wildcards, for `HttpClientConfig.suppressUnauthorizedFor`.
- **Named trailing wildcard params.** `/*filePath` captures a decoded,
  slash-joined remainder as `params.filePath`; clients segment-encode the same
  field and OpenAPI publishes its real name.

## [0.38.0] — 2026-08-07

### Added

- **Scoped batch clients and typed prefix callbacks.** `createClients` now
  accepts the same scoped third argument and transport choices as
  `createClient`; every registry entry keeps exact endpoint, multipart,
  raw-response and HTTP-exposure types. Keys in `stripPrefixKeys` also type the
  `pathPrefix` callback, so `({ tenantId }) => ...` needs no cast or coercion.
- **Contract-driven URL builders.** `createUrlBuilder` and `createUrlBuilders`
  synchronously generate absolute or relative links for HTTP-exposed,
  non-multipart GET endpoints. They reuse the exact request planner used by both
  typed-client transports, including scoped prefixes, named/trailing-wildcard
  params and flat query serialization. `createHttpClient` now returns the
  additive `ConfiguredHttpClient` subtype carrying its readonly `baseUrl`.
- **Typed JSON response metadata.** An HTTP-only endpoint may declare
  `responseMeta: { status? }`; its handler receives a fresh
  `ctx.response.headers` collector while still returning schema-validated data.
  Repeated `Set-Cookie` values survive Bun and Node, success metadata is
  discarded on errors, OpenAPI uses the declared 2xx status, and framework-owned
  framing/CORS/request-id headers cannot be replaced.

### Fixed

- **Contract routes now support a trailing `/*` wildcard.**
  `GET /app/:slug/*` matches nested paths, validates
  `{ slug, '*': remainder }` through the endpoint's `params` schema, respects
  specific-route precedence and returns 405 (not 404) for a wrong method. Both
  typed-client transports expand the `'*'` argument segment-by-segment, and the
  shared router decodes each segment back to its semantic handler value. OpenAPI
  marks the non-standard catch-all with
  `x-stitchkit-trailing-wildcard` instead of emitting an invalid path parameter.

## [0.37.0] — 2026-08-07

### ⚠️ Breaking changes

- **Executable flatten helpers are replaced by a presentation-only compiler.**
  `flattenDiscriminatedUnion` and `flattenUnionsDeep` are removed because a
  derived executable Zod parser caused SDK + framework transforms to run twice.

  ```ts
  // before — returns a second executable Zod parser
  flattenUnionsDeep(zodSchema)

  // after — presentation only; the original Zod schema remains the parser
  flattenToolJsonSchema(
    z.toJSONSchema(zodSchema, { target: 'draft-07', io: 'input' }),
  )
  ```

  `MountableTool.schema` is split into `argumentSchema` (CLI adapter) and
  `presentationSchema` (MCP/agent/manifest). → ADR 0050

- **Every `ToolCallHooks` callback now takes one options object.** The three
  callbacks use the same field vocabulary and future observability fields can
  be added without extending positional arity. There are no positional
  overloads or compatibility adapters. → ADR 0046

  ```ts
  // before
  beforeToolCall: (toolName, args, context, endpoint) => {}
  afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => {}
  onToolError: (toolName, error, context, endpoint) => {}

  // after
  beforeToolCall: ({ toolName, args, context, endpoint }) => {}
  afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => {}
  onToolError: ({ toolName, error, context, endpoint }) => {}
  ```

- **MCP schema validation is one object-shaped profile.** The positional
  `validateMcpSchemas` signature is removed, and MCP configs replace
  `onIncompatibleSchema` with `schemaValidation.policy`.

  ```ts
  // before
  validateMcpSchemas(services, 'throw', logger, { requireTypedProperties: true })
  createMcpHandler({ services, onIncompatibleSchema: 'throw' })

  // after
  validateMcpSchemas({ services, policy: 'throw', logger, requireTypedProperties: true })
  createMcpHandler({ services, schemaValidation: { policy: 'throw' } })
  ```

- **`nativeTools` now receives a registrar, not a server.** Protected native
  tools register through `registerTool`; direct SDK registration is still
  available only through the visibly unprotected `rawServer` escape hatch.

  ```ts
  // before — raw; lifecycle and ToolCallHooks never ran
  nativeTools: (server, auth) => server.registerTool(name, config, handler)

  // after — framework-owned validation/lifecycle/hooks
  nativeTools: ({ registerTool }, auth) => registerTool({
    name, description, identity, input, output, handler,
  })

  // after — deliberate raw opt-out
  nativeTools: ({ rawServer }, auth) => rawServer.registerTool(name, config, handler)
  ```

  Tool hook and `ToolLifecycle` endpoints are now the path-free
  `OperationIdentity`; contract values remain full `MethodDef` objects, while a
  native operation does not invent an HTTP `path`. → ADR 0048

- **MCP HTTP now uses `sessionMode` and defaults to stateless.** The boolean
  `stateless` field is removed. Omission now creates a fresh server/transport per
  request with no session store; clients that need server push, cross-request
  progress or resumable SSE must opt into stateful mode.

  ```ts
  // before
  createMcpHandler({ stateless: true,  ...config })
  createMcpHandler({ stateless: false, ...config })
  createMcpHandler({ ...config }) // stateful by omission

  // after
  createMcpHandler({ sessionMode: 'stateless', ...config })
  createMcpHandler({ sessionMode: 'stateful',  ...config })
  createMcpHandler({ ...config }) // stateless by omission
  ```

  There is no boolean alias. → ADR 0049

- **Node raw-route and Socket.IO types are now runtime-neutral.** The Bun
  `stitchkit/server` entry keeps its concrete `BunServer` context. The Node
  entry no longer exposes Bun-only `websocket` / `route` fields on its
  `SocketIOServerHandle`, and an explicitly annotated Node `RawRoute` receives
  `server: unknown` unless the consumer supplies its own runtime generic.

  ```ts
  // before — importing from stitchkit/node still required Bun ambient types
  const route: RawRoute = { handler: (_req, ctx) => ctx.server?.upgrade(...) }
  const socket = await createSocketIOServer(config)
  socket.websocket

  // after — Node capabilities only; no @types/bun required
  const route: RawRoute<MyHostServer> = { handler: (_req, ctx) => use(ctx.server) }
  const socket = await createSocketIOServer(config)
  socket.io
  socket.attach(nodeHttpServer)
  ```

### Changed

- **The optional Node adapter peer now targets `srvx ^0.12.5`.** Projects using
  `serveNode` must install the current 0.12 line; the adapter and Node smoke lane
  are tested against that version.
- **Static MCP services are prepared once per handler.** Collection, schema
  conversion and validation now produce one immutable descriptor set reused by
  fresh servers. Auth-dependent service factories remain uncached, and every
  request/session still owns its server, context, runner and callbacks.
- **The Fetch-clean handler boundary is now structurally enforced.** Bun-owned
  listener types and `Bun.serve` live in a dedicated adapter, `RawRouteContext`
  / `HandlerConfig` / `FetchHandler` are runtime-parameterised, a packed Node
  consumer typechecks without `@types/bun`, and Biome rejects the `Bun` global
  anywhere outside the two explicitly Bun-owned source files.

### Fixed

- **Tool input transforms, defaults, coercions and refinements now execute only
  once.** MCP and AI SDK adapters advertise an immutable JSON Schema through an
  identity carrier and forward raw arguments into Stitchkit's shared runner.
  Protected native MCP inputs no longer parse a third time; `ToolExtend` parses
  its own fields once inside the same hooks/audit path. Strict MCP failures now
  produce Stitchkit's `VALIDATION_ERROR` envelope and remain observable.

- **`logging.enrich` can now supply `errorCode` for a raw error response.** A
  `4xx`/`5xx` returned as `Response` previously lost the only available code
  because the framework's empty field overwrote it. Success responses still
  reject enriched error codes, and a framework-derived code still wins. Any
  discarded framework-owned enrichment key now warns once per handler.

### Added

- **Signed JSON webhook bodies can be retained without dropping validation.**
  Declare `rawBody: true` on a body-bearing HTTP endpoint and its handler gets a
  guaranteed `ctx.rawBody` string alongside validated `ctx.input`. The text is
  retained before JSON/Zod parsing, reaches `onError` on parser failures and is
  never kept for endpoints without the flag. Optional route/server
  `maxJsonBodyBytes` caps the stream before full buffering. → ADR 0051

- **Portable MCP JSON Schema format validation.** Set
  `schemaValidation.requirePortableFormats` to catch client-specific formats
  such as `cuid2`, with the tool, input/output side and nested property path.
  `allowFormats` is explicit; stitchkit never strips or rewrites a schema
  keyword.
- **Framework-owned native MCP tools.** `NativeMcpRegistrar.registerTool`
  preserves multimodal MCP content while applying the canonical schema profile,
  isolated call context, lifecycle/RBAC, output validation and tool hooks. The
  configured service/action/scope/semantic method flows into `RequestEvent`.

### Documentation

- Refreshed VISION and ROADMAP to describe the current Bun/Node, OpenAPI, MCP,
  CLI, observability and packed-consumer surface; removed the volatile source
  line count and completed work that was still presented as future scope.

### Internal

- Updated the development and starter dependency set to current releases.
  TypeScript 7 remains the build/typecheck CLI, while the semantic public-type
  declaration guard uses the official side-by-side TypeScript 6 compiler API
  until that API returns in the TypeScript 7 package. MCP Apps bundle inlining
  is now tested both with the optional peer installed and from a packed consumer
  that deliberately omits it.

## [0.36.1] — 2026-08-06

### Fixed

- **`ToolExtend.resolve` was still outside the per-call context**, so the defect
  0.36.0 fixed survived at one remove: `resolve` runs *before* the executor, and
  it is the documented place a project resolves a tenant for the call. Two
  concurrent calls stamped each other's rows exactly as before. The fork now
  opens in the mount, around `resolve` as well. → ADR 0045

### Changed

- **0.36.0's note on injecting identity is qualified.** `createMcpHandler({
  context })` is resolved **once per server build** — in the default stateful mode
  that is once per *session*, not per request, so it carries the session's opening
  identity. For a per-request value use a stateless mount, or read identity from
  the tool row's own arguments.
- Spelled out, having been understated in 0.36.0: the enclosing `POST /mcp` audit
  row loses tool-written **`userId`** as well as `dimensions`, and the same four
  fields (`userId`, `serviceName`, `action`, `dimensions`) leave that request's
  **access-log line**, which reads the same context.

## [0.36.0] — 2026-08-06

### ⚠️ Breaking changes

- **A tool call runs in its own request context; its writes no longer reach the
  enclosing HTTP request.** `executeToolMethod` opened no scope, so every tool
  call in a request wrote into one `AsyncLocalStorage` store. The AI SDK runs a
  step's calls with `Promise.all`, so the last `setRequestDimensions` won for
  **every** row — call A's audit row could name call B's entity, silently. Found
  in production on rows that looked perfectly ordinary.

  ```ts
  // The documented recipe — a lifecycle that stamps the entity it acted on:
  lifecycle: { beforeHandle: (ctx) => setRequestDimensions({ entityId: ctx.input.id }) }

  // before: the value landed on that call's tool row AND on the enclosing
  //         POST /mcp audit row and its access-log line. Under two concurrent
  //         calls, both rows named one entity — whichever wrote last.
  // after:  it lands on that call's tool row only.
  ```

  Each call now runs in a copy of the ambient context — same `traceId`, same
  client info, inherited identity — with its own `dimensions` and `error`.

  **If you read `dimensions` off the `POST /mcp` row, read the tool row instead**
  (`event.toolName != null`). The value is not lost and the join is one field:
  both rows carry the same `traceId`, and the tool row's `parentSpanId` is the
  request's `spanId`.

  Concretely — "every row belonging to bot B7", where the id now lives on the
  tool rows and you still want the request row with them:

  ```bash
  # before: the id was on the request row, so one filter did it
  jq 'select(.dimensions.botId == "B7")' audit.jsonl

  # after: collect the traces the id appears in, then take every row in them
  jq -s '[.[] | select(.dimensions.botId == "B7") | .traceId] as $t
         | .[] | select(.traceId | IN($t[]))' audit.jsonl
  ```
  ```sql
  -- the same in SQL
  SELECT * FROM audit WHERE trace_id IN (
    SELECT trace_id FROM audit WHERE dimensions->>'botId' = $1
  );
  ```

  **Check your incident recipes, not only your code.** A consuming project
  upgraded with a clean typecheck and no code changes at all, and still had a
  documented `jq` filter over request rows return nothing — the schema compiles,
  a runbook does not. Identity for a tool row is better injected through the
  mount's `context` — `createMcpHandler({ context: (auth) => ({ userId: auth.id }) })`
  — which the row already reads.

  **Sequential calls change too.** Dimensions used to *accumulate* through the
  shared store, so a second call's row carried the first call's keys. Each row is
  now what that call would have produced alone.

  **Two more writes change destination, and both are recommended patterns.**
  `setRequestError` from `onToolError` no longer names the enclosing HTTP row —
  and, less obviously, it no longer *suppresses* the framework's own error
  recording on that row (which only fires when the context carries nothing yet,
  → ADR 0043). `setRequestUser` from a tool `lifecycle.beforeHandle` — the shape
  a `createAuthHook` result takes — now reaches no audit row at all: the tool row
  reads identity from the mount's `context`, never from the request context.
  Inject it there instead.

  The forked context also **describes the call**: `source`, `path`, `serviceName`
  and `action` name the tool rather than the enclosing route. It still carries the
  request's `trace` and `startedAt`, because the audit hook needs them as the
  parent — so a span id or a duration read out of `getRequestContext()` inside a
  tool handler is the *request's*, not the call's.

  Unchanged: a call with **no** ambient context — stdio MCP, `createCli`, an
  agent loop outside a request — is not forked and behaves exactly as before.
  There is no shared store there to corrupt, and inventing one would have stamped
  every such row with a `parentSpanId` pointing at a span no row carries.
  → ADR 0045

## [0.35.0] — 2026-08-06

### ⚠️ Breaking changes

- **A collided field in a flattened discriminated union now advertises its
  type.** Previously a key present in more than one variant whose kept schema
  carried *any* check was widened to `z.unknown()` — a bare `description` in the
  JSON Schema a model is handed. `.int().min(0)` triggered it, so the more
  precisely a field was described the less the model was told.

  ```ts
  // before: {"description": "Required if op = setText | setButton"}
  // after:  {"description": "…", "type": "integer", "minimum": 0}
  ```

  Listed as breaking because the **advertised** schema changes for existing
  contracts, and the MCP SDK parses arguments with it: a call that previously
  slipped through as `unknown` and failed inside stitchkit with a
  `VALIDATION_ERROR` is now rejected by the SDK as `MCP error -32602` — **before**
  the tool callback, so `afterToolCall` does not fire and no audit row is written
  for it. If you detect bad calls through those rows, expect this class to stop
  appearing there. Nothing about your contracts or handlers needs to change.
  → ADR 0044

### Added

- **`validateMcpSchemas(…, { requireTypedProperties, allowUntyped })`** — fail a
  build when an advertised property carries no `type` / `enum` / `anyOf` /
  `$ref`, i.e. nothing a model can obey. Off by default; `allowUntyped` takes
  dotted `tool.property` paths for fields that are deliberately free-form.
  `findUntypedProperties` is exported for asserting on a schema you built
  yourself. It lives in a consumer-facing function on purpose: the framework
  ships no contracts, so a build-time check here would have nothing to inspect.

### Internal

- **No test binds a fixed port any more**, and a guard keeps it that way. Every
  hardcoded port (27 of them, plus the Node smoke script) now binds `port: 0` and
  reads the assigned port back. They were a scheduled flake: the ephemeral range
  on the development machine starts at 1024, so an unrelated process's
  **outgoing** connection can hold any of those numbers, and the bind then fails
  reporting a server that does not exist. Worse, when the bind happened at module
  scope the file dropped out of the run and the suite reported green — a gate
  that could pass by not running its tests.

## [0.34.0] — 2026-08-06

### Added

- **Nine types that a public signature names are now exported.** A consumer who
  has to write a type down must be able to import it; these could not be, so the
  only way to name one was `Parameters<...>` gymnastics.

  `stitchkit/tools` — `ViewFileOptions`, `McpAnnotations`, `CollectToolsConfig`.
  `stitchkit/server` — `MultipartResult`, `VerifyJwtOptions`, `EventBusOptions`,
  `EventHandler`, `DefaultEventMap`. `stitchkit/observability` —
  `WrapRequestContextOptions`.

### Internal

- **A guard for the rule** (`check-public-types.mjs`, part of `build`): every
  type named in a public signature must be exported from some entrypoint, read
  off the emitted declarations with the TypeScript compiler API. It is what found
  four of the nine. Types this package keeps internal — inference helpers, union
  members, aliases over `@types/bun` — are listed with their reason, and an entry
  that stops being referenced is reported so the list cannot rot.

## [0.33.0] — 2026-08-06

### Added

- **An audited HTTP failure names its cause without being wired to.** Every error
  travels one path inside the framework, and that path now records
  `{ code, message, details }` onto the request context — so `createAuditHook`'s
  HTTP row says *why* a request failed whether or not you wrote an `onError`, and
  whether or not your `onError` returns its own `Response` (that branch recorded
  nothing at all before).

  Where the envelope was scrubbed to `INTERNAL_SERVER_ERROR` the row gets the
  real message instead of the placeholder — the same rule 0.32.0 gave the tool
  row, now shared in one place rather than written twice. The caller still
  receives the scrubbed envelope, byte-identical to before.

  `setRequestError` becomes an **override** rather than the wiring: the framework
  writes only when the context carries nothing yet, so a project that curates its
  own value keeps winning and needs no change. → ADR 0043

### Internal

- **A consumer lane in the gate** (`bun run consumer-lane`, part of `verify`).
  The suite imports from `src`, in one process, with everything in scope; a
  consumer gets a tarball, an `exports` map and the emitted declarations. Four
  defects in one day lived in that gap and were all reported from outside. The
  lane packs the built package, installs it into fixture apps and uses it through
  the published entrypoints only — annotating types on purpose, so a missing
  export is a compile error, and asserting behaviour only the built artifact can
  show. Each of the four defects was reintroduced and confirmed to fail it. No
  runtime change.

## [0.32.0] — 2026-08-06

### Added

- **`afterToolCall` receives the raw thrown value as a seventh parameter**, and
  **`createAuditHook` uses it** — a tool audit row can finally name why the call
  failed.

  0.30.0 made the cause observable; it was still not *recordable*, because the
  hook holding the raw value and the hook building the row were different hooks.
  The HTTP row has always taken its message from `ctx.error` (whatever the project
  curated); the tool row took it from the scrubbed envelope, so every unexpected
  throw was recorded as `Internal server error`.

  ```ts
  hooks: {
    afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => {
      void writeRow({ toolName, result, durationMs, cause: error, endpoint })
    },
  }
  ```

  `error` is present **only** when the call failed by throwing — a validation
  failure, an output-schema mismatch and a `beforeToolCall` rejection leave it
  `undefined`. Additive: a six-parameter hook stays assignable, keeps compiling
  and keeps firing, so no existing hook needs touching.

  In `createAuditHook` the raw message replaces the placeholder **only** where the
  envelope was scrubbed to `INTERNAL_SERVER_ERROR`; a truthful envelope keeps its
  own message, `errorCode` and `errorDetail` are untouched, and the stack is never
  written to a row. The caller still receives the scrubbed envelope in every case
  — the raw text reaches your server-side record, never the response. → ADR 0042

  If you were correlating `onToolError` with `afterToolCall` through a `WeakMap`
  to get this, you can drop it.

## [0.31.0] — 2026-08-06

### Added

- **`ToolCallContext` is exported from `stitchkit/tools`.** Every tool hook takes
  one — `onToolError` names it in its signature — but the type itself was not
  public, so a hook written as a standalone function had to recover it with
  `Parameters<NonNullable<ToolCallHooks['afterToolCall']>>[4]`.

### Fixed

- **`onToolError` guidance no longer points at `setRequestError`.** It writes to
  the *request* context, which `createAuditHook`'s **tool** row does not read —
  a tool event takes `errorCode` / `errorMessage` / `errorDetail` from the
  `ToolResult`, and only identity and `dimensions` from the context. The advice
  left the tool audit row as scrubbed as before and, for MCP over HTTP, wrote the
  cause into the enclosing `/mcp` request's log line as well — one incident, two
  records. The guide now routes the cause to the consumer's own sink and shows
  how to correlate `onToolError` with `afterToolCall` if a single row must carry
  both.

## [0.30.0] — 2026-08-06

### Added

- **`ToolCallHooks.onToolError`** — the raw value behind a failed tool call, as
  thrown, before it is normalised into a `ToolResult`.

  A thrown `AppError` already reaches `afterToolCall` intact. Anything else does
  not: `normalizeError` scrubs an unexpected throw down to a bare
  `INTERNAL_SERVER_ERROR` with the message `Internal server error` (a raw
  `Error.message` can carry a connection string), so the cause existed only for
  the framework's own `console.error` and no consumer hook could reach it — while
  the HTTP path has handed the value as thrown to `hooks.onError` all along.

  ```ts
  createMcpHandler({
    serverInfo, auth, services,
    hooks: {
      onToolError: (toolName, error, _context, endpoint) => {
        reportToolFailure({
          tool: toolName,
          action: endpoint.key,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      },
    },
  })
  ```

  Fires for a throw from `lifecycle.beforeHandle`, the handler or
  `lifecycle.afterHandle`, and runs **before** `afterToolCall` so what it records
  is in place when the audit hook reads it. It does not fire for an
  argument-validation failure, an output-schema mismatch or a `beforeToolCall`
  rejection — each is already described in full by the `ToolResult`. Observation
  only: the return value is ignored and a throw from the hook is reported and
  swallowed. Reaches every mount that takes `hooks` — `mountMcp`,
  `createMcpHandler`, `mountAgent`, `createCli`.

## [0.29.0] — 2026-08-06

### Added

- **`logging.format: 'pretty' | 'json'`** — the built-in formatter's output is
  now the consumer's choice, not a guess.

  ```ts
  createServer({ services, logging: { format: 'json' } })
  ```

  | `format` | Writes | Carries `enrich` / context identity |
  |---|---|---|
  | `'pretty'` | two coloured lines per request (`→`, `←`) | no |
  | `'json'` | one structured line per completed request | yes |

  Unset, it follows `NODE_ENV` — `json` under `production`, `pretty` otherwise —
  read **per request**, so it reflects the environment your app runs in. Set it
  and the environment is not consulted at all. It governs the **built-in**
  formatter only: a custom `logger` always receives the structured object.
  → ADR 0040

### Fixed

- **The structured log line was unreachable in every installed copy of this
  package.** The format was decided by a module-scope
  `process.env.NODE_ENV === 'production'`, which a bundler folds into a literal
  at build time — *this package's* build, not yours. The published bundle
  carried `var isProd = false`, so every consumer got the pretty format
  permanently, whatever they ran under, and no `NODE_ENV` on their own build
  could change it (that only freezes their code the same way). The environment
  is now read through an indirection, per request.

  This is why anything the structured line carries — the request-context
  identity and `enrich` fields added in 0.28.0 — appeared not to work outside a
  custom `logger`. It affected every version since 0.1.0.

  A build guard (`check-env-live`) now fails the build if the read is ever
  folded away again.

## [0.28.1] — 2026-08-06

### Fixed

- **A throwing `hooks.onRequest` no longer escapes the handler.** It ran before
  the dispatch `try`, so an exception from the gate skipped every layer — no
  `onError`, no error envelope, no CORS headers, no log line, no
  `x-request-id` — and the runtime answered with a bare 500. It now takes the
  same path as any other failure. An `AppError` thrown by the gate keeps its
  status.
- **A throwing `traceId` resolver no longer costs the response.** The id exists
  to label a log line; a resolver that throws now falls back to the framework
  resolver, and the failure is reported **once per handler** (not once per
  request) through the configured logger. Consumers who wrapped `getTraceId` in
  a throwing guard — the shape the pre-0.28.0 type error forced — were one
  forgotten `wrapInRequestContext` away from bare 500s on every request. With
  the signature fixed in 0.28.0, `traceId: getTraceId` needs no guard at all.

## [0.28.0] — 2026-08-06

### ⚠️ Breaking changes

- **`logging` no longer takes a `StitchLogger` directly** — it takes a config
  object, so the logger can finally be tuned instead of only replaced.
  `logging: true` is now shorthand for `logging: {}`: **any** object turns
  request logging on, `logger` decides which sink writes it, and `skip` /
  `enrich` apply to whichever is active.

  ```ts
  // before
  createServer({ logging: myLogger })
  // after
  createServer({ logging: { logger: myLogger } })
  ```

  The migration is mechanical and loud: `LoggingConfig` shares no property with
  `StitchLogger`, so TypeScript's weak-type detection rejects the old form.
  A logger typed `any` or carrying an index signature would slip past the
  compiler and silently mean "a config with no logger" — that case **throws at
  `createHandler`** with the line above rather than booting with logging off.
  → ADR 0039

- **`DEFAULT_CORS_EXPOSE_HEADERS` no longer advertises `X-Trace-Id`; it
  advertises `X-Request-Id`.** The old value named a header the server has never
  sent, while the one it does send on every response was unreadable
  cross-origin. This is the **one change here the compiler cannot catch**: if
  something else in your chain (a proxy, a middleware) sets an `X-Trace-Id`
  *response* header that browser code reads, that read starts returning `null`.

  ```ts
  // before: the default list ended in `X-Trace-Id`
  // after: keep reading a proxy-set X-Trace-Id by asking for it explicitly
  createServer({ cors: { origin, exposeHeaders: `${DEFAULT_CORS_EXPOSE_HEADERS}, X-Trace-Id` } })
  ```

  `DEFAULT_CORS_ALLOW_HEADERS` is unchanged — inbound `X-Trace-Id` is still
  accepted and read by `resolveTraceId`. (0.27.0 introduced this default and
  quoted the old list verbatim in its own breaking note; this corrects it.)

- **`logging: true` emits more in production.** With an observability context
  active, every completion line now also carries `userId`, `serviceName`,
  `action` and nested `dimensions` — see *Added* below. A log store with a fixed
  schema will see new keys. Development output is unchanged.

### Added

- **`logging.skip(req, url)`** — drop chosen requests from the log. Runs after
  the built-in filter (framework assets, favicon, preflights), so it can only
  quieten more: health probes, a monitoring path that 404s every cycle,
  Socket.IO's polling transport.
- **`logging.enrich(req, url, outcome)`** — extra fields on the completion
  line. Runs once at close and is merged *under* the framework's own fields,
  which always win. A throw in either callback is swallowed — neither can fail a
  request.
- **The completion line picks up the active request context** — `userId`,
  `serviceName`, `action` and nested `dimensions`, with no configuration, when
  something established a context. Unchanged when nothing did.

  ⚠️ Both of the above reach the **structured** output only: the production JSON
  line and a custom `logger`'s `data`. The development `←` line is a line to
  read, not a record to query, and never carries them — so with
  `logging: true` in development you will see no difference at all.
- **`wrapFetch` on `createServer` / `serveNode`** — the seam for
  `wrapInRequestContext` and `createAuditHook`, which must wrap the handler from
  outside. Both servers build their own `fetch`, so until now neither could
  reach the observability layer at all.
  ```ts
  createServer({ services, wrapFetch: (h) => wrapInRequestContext(audit.http(h)) })
  ```
- **`ToolCallRecord.traceId`** — joins a tool call to the HTTP request that
  triggered it.
- New exported types: `LoggingConfig`, `LogOutcome`, `FetchHandler`,
  `FetchComposition`.

### Fixed

- **`traceId: getTraceId` now compiles.** The option demanded `string` while
  `getTraceId` returns `string | undefined`, so the documented way to share one
  id between request and application logs was a type error. `traceId` may now
  return `undefined`, and the framework falls back to its own resolver instead
  of stamping `"undefined"`.
- **A throwing logger can no longer take the request with it.** On the error
  path the throw was swallowed by the `onError` catch and then re-thrown,
  uncaught, by the fallback call. The whole log step is now guarded.
- **One completion line per request.** A result `Response.json` cannot
  serialise (a `BigInt`, a cycle) logged a `200` and then a `500` for the same
  request; the line is now written only once the response exists.
- **A custom logger now receives `ip`** on the completion line, as the built-in
  formatter always has, and `errorCode` is always present (`undefined` on
  success) so an `enrich` value can never forge one.

## [0.27.0] — 2026-08-05

### ⚠️ Breaking changes

- **CORS now sends `Access-Control-Expose-Headers` by default.** Every response
  from a server with `cors` configured — JSON endpoints included — begins
  advertising `Content-Disposition, Content-Length, Content-Range,
  Accept-Ranges, ETag, Last-Modified, X-Trace-Id` as readable cross-origin.
  Without this a browser cannot recover a downloaded file's name, revalidate or
  resume, so file responses were unusable cross-origin; but it is a **changed
  default**, and widening what cross-origin JavaScript may read is a
  security-review surface. These are headers the server already sends — nothing
  new is disclosed to the network — but review it rather than assume.
  `// before: (no header)` → `// after: cors: { origin, exposeHeaders: [] }` to
  keep the old behaviour, or pass your own list.

### Added

- **Raw-response endpoints — `rawResponse: true`.** An endpoint that answers with bytes
  rather than data (a PDF, a file download, an SSE stream) declares `rawResponse: true`
  and returns the `Response` itself. Until now such endpoints had to leave the
  contract for `rawRoutes`, which costs three things unrelated to bytes: the
  typed client, a single route registry, and — the serious one — the **auth
  gate**, since raw routes never run `hooks.beforeHandle` and each handler had
  to call the guard on its own first line. A raw endpoint keeps all three: the
  request half (`params` / `input` / `multipart`, `beforeHandle`) is completely
  unchanged; only the response is handed over. It is never an MCP tool, an agent
  tool or a CLI command, and declaring `output`, `toolName`, `ui`, `annotations`
  or a non-HTTP `expose` beside it is a type error (and throws at definition
  time for a contract assembled at runtime). `afterHandle` is **skipped** for
  raw endpoints — it transforms data, and there is none. On the typed client the
  method resolves to the untouched `Response`, so `Content-Disposition` (the
  download filename) survives, which a `Blob` would lose. → ADR 0038.

  ```ts
  download: {
    method: 'GET', path: '/:id/pdf', desc: 'Download a document as a PDF',
    params: z.object({ id: z.uuid() }),
    rawResponse: true, contentType: 'application/pdf',
  }
  // handler — no guard on the first line; beforeHandle already ran
  download: (ctx) => serveFile(ctx.req, { path: pathFor(ctx.params.id) }),
  ```

- **`RequestOptions.responseType: 'response'`** — hand back the untouched
  `Response` instead of parsed JSON or a `Blob`. What `rawResponse` endpoints use; also
  available for a direct `HttpClient` call.

- **`cors.exposeHeaders`** — control `Access-Control-Expose-Headers`, which the
  framework emitted nowhere. Pass `[]` to emit none, or a list to replace the
  default (see the breaking note above).

- **`isWithinDir` is exported** from `stitchkit/server`. `serveFile` deliberately
  leaves path containment to its caller, and the guide and ADRs 0023 / 0038 tell
  you to call this before serving a URL-derived path — but it was internal, so
  the advice was unactionable. The guide now carries the full recipe.

- **A raw route that shadows a contract route is reported at startup.** Raw
  routes match first, so a leftover one keeps serving while the contract
  endpoint — and its auth gate — never runs. The warning names the raw route,
  the dead endpoint and the scope being bypassed. Silent, this is the exact
  failure raw-response endpoints exist to prevent.

### Fixed

- **A `Response` on the data path no longer vanishes.** Returned from a normal
  handler it was wrapped by `afterHandle`, serialized by `json()` into `{}` and
  answered with status 200 — headers, status and body gone, and nothing logged.
  The guide's own SSE example (`return streamSSE(tokens())`) sat in that hole.
  The handler's return type already rejected it (`void | Promise<void>` admits
  no `Response`); what is new is that it now **fails at runtime** with a 500
  naming the fix, instead of answering 200. Checked after the hooks, so an
  `afterHandle` returning a `Response` is caught too. Declare `rawResponse: true` (see above); the SSE guide section is updated.

- **CORS no longer corrupts a partial response.** `applyCors` rebuilt every
  response it decorated (`new Response(res.body, …)`), and on Bun reading `.body`
  off a response built from `Bun.file().slice()` re-reads the *whole* file. A
  `206` therefore kept its honest `Content-Range` while shipping the rest of the
  file — a client stitching ranges (a video player, a download manager,
  `curl -C -`) got garbage. Measured: `Range: bytes=10-14` on a 26-byte file
  returned 16 bytes. Headers are now mutated in place, with the rebuild kept only
  as the fallback for the immutable-header case it was written for
  (`Response.redirect()`, which has no body to corrupt). Affects any raw route,
  `onError` response or `serveFile` handler behind `cors`.
- **`Vary` is appended, not overwritten.** With a list `origin`, CORS set
  `Vary: Origin` over whatever the handler had put there — a file response
  carrying `Vary: Accept-Encoding` lost it, and a shared cache would then serve
  one encoding to every client.

### Docs

- **`meta` opt-out documented:** an endpoint declaring `key: undefined` shadows
  the contract-level value — "the contract turns this on for everyone, this
  endpoint turns it off". This was already how 0.26.0 behaves; the ADR and guide
  wrongly said "no unset sentinel". Driven by a real consumer case (a public
  form-submission endpoint inside an admin-gated contract). The key stays present
  with value `undefined`, so read `meta` by value (`meta?.key`), not membership.

## [0.26.0] — 2026-08-05

### ⚠️ Breaking changes

- **Tool names are normalised across the whole character class, and an
  undeliverable name now throws at mount.** `toToolName` normalised only the
  hyphen, so anything else rode into the advertised name (`prefix:
  'admin/analytics'` derived `overview_admin/analytic`). Nothing downstream checks
  this — the MCP SDK only *warns* (SEP-986) and registers anyway, the `ai` SDK has
  no rule — so the provider rejected the request and **every** tool of that mount
  went dark, at the first model call. The enforced rule is `[a-zA-Z0-9_-]`, ≤64
  characters: OpenAI's, the tightest of the surfaces, so a passing name is
  deliverable everywhere (MCP and Anthropic both allow 128 and a dot, so an
  MCP-only consumer may need a shorter explicit `toolName`). → ADR 0035.

  ```ts
  // before: prefix 'admin/analytics' + `overview` → "overview_admin/analytic" (illegal, ships)
  // after:                                       → "overview_admin_analytics"
  ```

  Two things can now fail or move:
  - **An illegal name throws at mount**, naming the endpoint — an explicit
    `toolName` outside `[a-zA-Z0-9_-]`, a name over 64 characters (the only remedy
    is a shorter explicit `toolName`), or a prefix with no usable character at
    all — `'///'`, `'_'`, `''`, a fully non-ASCII prefix. Those last ones derived
    a degenerate name (`get____`, `get__`, `get_`) that *passes* the charset check
    while being meaningless and identical for every such service, so they are
    rejected on their own terms; setting an explicit `toolName` rescues them,
    since the prefix then never enters the name. Note this is the one sub-case
    where a name that was **provider-legal** now throws — an underscore-only or
    empty prefix. Otherwise nothing that worked stops working: an illegal name was
    already rejected provider-side.
  - **Some legal names are renamed**, because `singularize` now applies to the
    last `_` segment instead of the whole name — the exception list previously
    only ever matched an unprefixed service. `get_bot_statu` → `get_bot_status`,
    `get_user_setting` → `get_user_settings`, `get_chat_analytic` →
    `get_chat_analytics`, `get_site_new` → `get_site_news`. A host config or agent
    prompt pinned to an old name breaks — diff with `listToolNames` before and
    after (see `docs/guide/upgrading.md`).

  Names that are legal today are otherwise **byte-identical**: no run-collapsing,
  no trimming, and a hyphen in a *method key* is kept (`get-user_note` still
  derives as before) — so `get__internal`, `list_a__b` and `get_foo_` are
  untouched. **The CLI is exempt** from the charset and length rules entirely: a
  command name goes to a shell, not to a provider. The built-in native tools
  (`mountWait` / `mountDownload` / `mountUpload`) now assert their names too, since
  they share the `tools/list` with contract tools.
  `implementRemote` inherits the check — it derives names over someone else's
  contract. `listToolNames` deliberately does **not** throw, so it can still show
  you the offending row.

### Added

- **`warnOnOutputStrip` — see what the `output` schema is removing.** A handler
  returning more than its contract declares has the extra fields deleted, which is
  correct but invisible: types cannot catch it and nothing logged it. Turn the flag
  on while migrating a live API and every removed key is reported as a dot-path
  with the endpoint identity (`notes.get: secret, nested.alsoSecret`); tool mounts
  take the same via `onOutputStrip: (toolName, paths) => …`. Off by default, and
  the key diff only runs when a reporter is attached, so nothing changes for anyone
  who does not opt in. → ADR 0037.
- **`createErrorHook`'s `render` and `onError` receive the `RuntimeContext`.** The
  helper dropped it, so putting a `traceId` in the error envelope — the ordinary
  reason to have one — meant abandoning the helper and hand-rolling `onError`,
  re-implementing the normalisation it already does. Additive: a one-argument
  `render` stays assignable.
  `// before: render: (info) => …` → `// after: render: (info, ctx) => ({ …, traceId: ctx.traceId })`
- **`nativeTools` receives the resolved identity**, like `services` and `context`
  already did — `nativeTools: (server, auth) => …`. A native tool can now be
  per-tenant. It is **not** a scope gate: native tools are not contract methods, so
  `lifecycle` still does not run for them.
- **A contract can declare a default `meta` that endpoints inherit** —
  `defineContract({ prefix, meta: { owner: 'auth' } }, …)`. An endpoint's own
  `meta` is **shallow-merged over** it (endpoint keys win, one level), so a
  contract-wide `{ public: true }` survives an endpoint that adds
  `{ rateTier: 2 }` — which matters because `meta: { public: true }` is the
  documented allowlist for the generated OpenAPI spec. Applies through
  `implement`, `implementRemote` and `createContractFactory` (which previously
  rebuilt the meta object and would have dropped the field). `expose`
  deliberately does **not** cascade — → ADR 0036 for the reasoning, and pin
  `listToolNames` in a snapshot to catch an endpoint that forgot it.

## [0.25.0] — 2026-08-03

### ⚠️ Breaking changes

- **The advertised tool schema no longer deletes unknown keys — a `.strict()`
  contract schema is now enforced on the wire.** The MCP and AI SDKs parse a
  tool call's arguments *with the advertised schema* and hand the handler the
  parsed result, so every object stitchkit rebuilt while deriving that schema
  (the union flatten walk, the `params` + `input` merge, the `ToolExtend` fold)
  silently **removed** keys before validation could see them: a call carrying a
  key a `.strict()` schema forbids **succeeded**, with the key gone. Objects now
  carry their own key policy through every rebuild. → ADR 0034.

  ```ts
  // contract, unchanged
  input: z.object({ node: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('send'), outputs: z.object({ ok: z.string() }).strict() }),
  ]) })

  // before: tools/call { node: { kind: 'send', outputs: { ok: 'x', typo: 1 } } }
  //         → 200, handler receives outputs: { ok: 'x' } — `typo` silently dropped
  // after:  → rejected, the caller is told `Unrecognized key: "typo"`
  ```

  What to check when upgrading:
  - **A previously-accepted call may now fail.** Anything that leaned on the
    sanitising behaviour (a client sending a stale or extra field to a strict
    tool) must stop sending it. `.loose()` / `.passthrough()` / `.catchall()`
    schemas keep receiving their extra keys, as they always did on HTTP.
  - **A strict violation arrives on a different channel.** The SDK rejects it
    *before* the tool callback runs. `callTool` still resolves (it does not
    throw), but with an `isError: true` result carrying the SDK's own
    `MCP error -32602: Input validation error: … Unrecognized key: "…"` instead of
    stitchkit's `{ error, details, _hint }` envelope (agent: an `invalid: true`
    tool call) — and **`beforeToolCall` / `afterToolCall` do not fire**. Such
    calls move from "logged as a success" to "not logged at all"; audit
    dashboards counting tool calls will shift.
  - **A filtered `ToolExtend` can now reject cross-tool.** Where `extend.filter`
    advertises `tenantId` on some tools only, a model that sends it to a strict
    *non*-extended tool was sanitised before and is rejected now.
  - **The advertised JSON Schema changed** for strict/loose objects
    (`additionalProperties: false` / `{}`) on the MCP surface and in
    `buildToolManifest` — a snapshot test of a generated manifest will diff.
    OpenAPI output is unchanged.
  - Not covered: `z.intersection` (a `params` + union-`input` tool on the agent
    surface) still strips — Zod drops both sides' key policy when intersecting.

### Fixed

- **`flattenUnionInput` no longer injects a non-matching variant's `.default()`
  into the payload.** Every field of the flattened object is advertised optional,
  so a variant's default materialised on *every* call: sending variant `a` came
  back carrying variant `b`'s defaulted field, which the real union then rejected
  as an unrecognized key — a legal call turned into a hard `VALIDATION_ERROR`.
  `.default()` is now unwrapped when variant fields are merged, exactly as
  `.optional()` already was. Pre-existing since 0.14.0; it bites hardest on the
  all-`.strict()` unions the change above makes the sound choice.

## [0.24.0] — 2026-07-28

### Added

- **OAuth provider — `iss` on every authorization response (RFC 9207,
  MCP 2026-07-28 / SEP-2468).** `mountOAuthProvider` now returns the `iss`
  parameter on both the success and the error redirect from `/authorize`, and
  the authorization-server metadata advertises
  `authorization_response_iss_parameter_supported: true`. A client that talks to
  several authorization servers validates `iss` before redeeming the code, which
  closes the **authorization-server mix-up** attack. Additive on the wire — a
  client that ignores the parameter is unaffected.
- **OAuth provider — `application_type` on Dynamic Client Registration
  (SEP-837).** `/register` accepts `application_type: "native" | "web"`, echoes
  it back, and carries it on `RegisteredClient`. A **native** client (desktop /
  CLI) may register an `http` loopback redirect (RFC 8252 §7.3); a **web** client
  is held to `https` only — the mismatch behind the `redirect_uri` errors CLI
  clients hit. Omitting the field keeps the previous permissive behaviour, so no
  existing client breaks; an unknown value is rejected with
  `invalid_client_metadata` rather than silently defaulted. New exported type
  `ApplicationType`.

## [0.23.0] — 2026-07-18

### Added

- **`generateOpenApiDocument` — `includeMethod` predicate for a curated public
  spec.** Emit only the methods a predicate keeps, instead of the whole HTTP
  surface — a public `/openapi.json` that advertises a subset without revealing
  the rest. The core stays generic (no `public` field): the policy is the app's,
  filtering on anything the method carries. The recommended declarative allowlist
  uses the existing `meta` passthrough —
  `includeMethod: (m) => m.meta?.public === true` over endpoints flagged
  `meta: { public: true }`. An excluded method's path and every inlined schema
  are never emitted, so nothing about a hidden endpoint leaks. Additive — omit
  it for the previous behaviour (every HTTP method). **The filter advertises, it
  does not authorize** — the `scope` gate is still the guard; serve a full
  internal spec and a filtered public spec on separate routes.

## [0.22.0] — 2026-07-18

### Added

- **`VALIDATION_ERROR` now carries the offending fields as structured
  `details.issues`** — `{ path, code, message }[]` — alongside the text
  `message`. A machine client (or an MCP tool caller) matches on fields instead
  of parsing the message. It flows through the default error envelope,
  `normalizeError`, and `createErrorHook`'s `render` (`info.details.issues`), so
  the batteries-included path now serves a machine client without a hand-rolled
  `ZodError` branch. Additive — `details` was absent before.
- **`zodIssues(error)` exported from `stitchkit/server`** (with `ZodIssueSummary`)
  — project a `ZodError` into that structured `{ path, code, message }[]`, the
  machine-readable sibling of `formatZodError`. Use it in a bespoke `onError`.

### Docs

- Documented the `onError` contract explicitly: a hook receives the **raw**
  thrown value (a `ZodError`, an `AppError`, anything) — the framework normalises
  only when no hook is set. Call `normalizeError` / `zodIssues` yourself for the
  canonical classification or structured fields.

## [0.21.0] — 2026-07-18

### Fixed

- **`createErrorHook` now returns an honest `400 VALIDATION_ERROR` for invalid
  input, not a `500`.** It classified any non-`AppError` as
  `INTERNAL_SERVER_ERROR`, so a `ZodError` from input validation — a client fault
  — was dressed as a server fault (every consumer had to add its own ZodError
  branch). It now runs the thrown value through the framework's `normalizeError`
  first, exactly as the framework default does: `ZodError` → `VALIDATION_ERROR`
  400 (remapped through `codeMap` like any stitch code), `AppError` keeps its
  code/status, anything else stays a generic 500 with no message leak.

### Added

- **`normalizeError`, `errorCode` and `formatZodError` are exported from
  `stitchkit/server`.** The framework's canonical error classification — reuse it
  in a bespoke `onError` (or for log attribution) instead of reinventing the
  `ZodError` → 400 mapping. `createErrorHook` and the framework default both run
  through `normalizeError`.

### Docs

- **Corrected the multipart / query boolean-coercion guidance to `z.stringbool()`
  (Zod v4).** The 0.20.0 migration note recommended `z.coerce.boolean()` for a
  boolean field, but that is `Boolean(str)` — every non-empty string, including
  `'false'`, is truthy, so a `'false'` field silently became `true`.
  `z.stringbool()` decodes `'true'` / `'false'` (and `'1'` / `'0'`, `'yes'` /
  `'no'`) correctly. Applies to both multipart and query-string boolean fields.

## [0.20.0] — 2026-07-17

### ⚠️ Breaking changes

- **Multipart text fields are no longer JSON-decoded — they arrive as raw
  strings, and the schema coerces.** `parseMultipart` used to run every text
  field through `JSON.parse`, so a field's type depended on its *content*: an id
  like `'33111715'` silently became a number and failed a `z.string()` schema by
  the luck of its digits (`'true'` → boolean, `'[1,2]'` → array, and so on). A
  multipart text field is always a string per the spec; the type belongs to the
  contract, not the value — the same rule as query params. Update a multipart
  `input` field to coerce, and opt a JSON field in explicitly:
  `// before: z.number()` → `// after: z.coerce.number()`;
  `// before: z.boolean()` → `// after: z.stringbool()` (Zod v4 — **not**
  `z.coerce.boolean()`, which is `Boolean(str)`, so `'false'` would become `true`);
  `// before: z.object({ … })` → `// after: z.preprocess((v) => JSON.parse(String(v)), z.object({ … }))`.
  A field already typed `z.string()` now works as written (it previously broke on
  numeric-looking values). Removing the value-level `JSON.parse` also drops a
  prototype-pollution vector; the `__proto__` key guard stays.

## [0.19.0] — 2026-07-10

### Fixed

- **Default CORS now allows the `traceparent` / `tracestate` request headers**,
  so `createHttpClient({ trace: true })` (added in 0.18.0) actually works
  cross-origin. The client sends `traceparent` on every request, but the default
  `Access-Control-Allow-Headers` omitted it — every browser preflight failed and
  the API was unreachable whenever `trace` was on. The three divergent CORS
  header defaults (HTTP server, OAuth provider, OAuth metadata) are unified into
  one exported constant, `DEFAULT_CORS_ALLOW_HEADERS`.

### ⚠️ Breaking changes

- **The `HttpClient` (ky) client path now validates responses against the
  endpoint's `output` schema.** It previously returned the body unvalidated,
  while the bare-fetch client path validated — so which guarantee you got
  depended on whether you passed a `createHttpClient(...)` or a plain
  `{ baseUrl }`. Both paths now honour the contract's documented promise ("when
  set, the client parses the response through it"). A response the server sends
  that does **not** match `output` now throws a `ZodError` on the ky path where
  it used to slip through. For a correctly-built app this never fires — the
  server handler's return is already type-checked against the same `output`; it
  only surfaces a genuine server/client schema-version skew.
  `// before: createClient(c, createHttpClient({...}))  // returned unvalidated`
  → `// after: … validates output, throwing on a mismatch`

### Added

- **`createContractFactory<Scope>()`** (`stitchkit/contract`) — a `defineContract`
  with a required, typed `scope`, so a missing scope is a compile error, not a
  silent `'public'` endpoint. The scope vocabulary is the app's.
- **`defineErrors({...})`** (`stitchkit/contract`) — declare domain error codes
  once → typed throwers (`errors.SESSION_NOT_FOUND(msg)`) for the server and a
  code table (`codes.SESSION_NOT_FOUND`) the client matches with autocomplete
  instead of a magic `message` string.
- **`createErrorHook({ codeMap, render })`** (`stitchkit/server`) — an `onError`
  hook from an exhaustive `Record<StitchErrorCode, …>` map + an envelope
  renderer; never leaks an internal message.
- **`createToolLogger()`** (`stitchkit/tools`) — a ready `afterToolCall` preset
  that logs every tool call (ok/failed, duration, endpoint identity), with an
  optional `onRecord` metrics sink. **`summarizeTransports(services)`** returns
  per-transport operation counts for a boot-time summary.
- **`createEntityCacheHandlers()`** (`stitchkit/react`) — declarative
  created/updated/deleted cache handlers for `createCacheBridge`, patching the
  `Paginated<T>` list + detail queries (does not flatten pages).
- The bare-fetch client path now applies an endpoint's declared `timeout` (via
  `AbortSignal.timeout`) — it previously ignored it, so a declared `timeout` did
  nothing on that path. The ky path already applied it.
- **`DEFAULT_CORS_ALLOW_HEADERS`** exported from `stitchkit/server` — the default
  allow-list, to extend (not replace) when setting a custom `cors.headers`.
- The API reference — and the generated `llms.txt` / `llms-full.txt` a consuming
  agent reads — now documents ~45 previously-missing public exports (the OAuth
  provider, MCP Apps, the native `mountDownload` / `mountUpload` / `mountWait`
  tools, `signJwt`, PKCE, the whole `stitchkit/node` entry). No code change; the
  surface was already there, just undocumented. A new test keeps every export
  documented from now on.

### Changed

- **`createSocketIOClient` loads `socket.io-client` lazily.** It is no longer a
  static import of the root `stitchkit` entry, so `import { defineContract }`
  (or any non-socket use) no longer drags the Socket.IO client into a bundle —
  a minimal `bun add stitchkit zod` quick start now runs without the peer
  installed. The peer loads on the first `connect()`; the connection opens
  asynchronously as it always did, and a missing peer throws a clear
  install-me error. No API change.
- **Multipart on the `HttpClient` path now uses the endpoint's declared method**
  (`POST` / `PUT` / `PATCH`) instead of always `POST` — a `PUT` upload no longer
  silently becomes a `POST`. A multipart endpoint declared `GET` / `DELETE` now
  throws (it never had a valid body verb).
- **An `onRequest` hook's early `Response` now carries CORS headers** like every
  other response exit — a short-circuit (auth wall, maintenance page) answered
  to a browser is now readable cross-origin.

## [0.18.0] — 2026-07-09

### ⚠️ Breaking changes

- **The typed client now throws on a non-flat `GET` / `DELETE` input field**
  (a nested object, an array with non-primitive items, a function). Previously
  such a field was **silently dropped** from the query string, sending a subtly
  incomplete request. A query string can only carry `string` / `number` /
  `boolean` and arrays of `string` / `number` — see
  [Contracts → query input](docs/guide/contracts.md#query-input-get--delete).
  `// before: api.search({ filter: { status: 'active' } })  → GET /search (filter silently dropped)`
  → `// after: throws "GET /: input field \"filter\" is a nested object …" — flatten the field or use POST`
  Flat fields and primitive arrays are unaffected. Both client paths
  (`createHttpClient` adapter and the bare-fetch `ClientConfig` mode) enforce
  the same rule.

### Added

- **`createHttpClient` — `trace` option (`boolean`, default `false`).** Emits a
  W3C `traceparent` header with a fresh root trace on every request. The server
  already continues an inbound `traceparent` (`resolveTraceContext`), so with
  this on, a browser call, its HTTP handler and every nested tool call share
  one trace id end-to-end. A `traceparent` set via `headers` wins — the client
  never overwrites it.
- **Trace helpers on the root `stitchkit` entry.** `createTraceContext`,
  `formatTraceparent`, `parseTraceparent`, `childSpan` and the `TraceContext`
  type are now also exported from the browser-safe root entrypoint (they are
  Web Crypto-only), so a custom client can format its own `traceparent` without
  importing the server-only `stitchkit/observability`.
- **`listToolNames(services)` in `stitchkit/tools`.** Resolves every tool name
  the services expose — the `toolName` override or the derived name, with its
  `(service, method)` identity and tool transports (`MCP` / `AGENT` / `CLI`),
  sorted. Built on the exact resolver the mounts use, so it can never drift
  from what actually mounts. Use it for a name-baseline snapshot test (a
  derived-name drift across upgrades fails CI instead of silently breaking MCP
  client configs) and for migration diffs. Returns `ToolNameEntry[]`.

## [0.17.0] — 2026-07-05

### Added

- **`createSocketIOClient` — `onConnectionChange` now passes the disconnect
  reason.** The listener gains an optional second argument:
  `(connected: boolean, reason?: string) => void`, where `reason` is the
  Socket.IO disconnect reason (`io server disconnect`, `transport close`,
  `ping timeout`, …) on a down event and `undefined` on connect. Purely additive
  — an existing `(connected) => void` listener keeps working unchanged.
- **`createSocketIOClient` — `reconnectOnServerDisconnect` config option
  (`number | false`, default `1000` ms).** When the **server** initiates the
  disconnect (reason `io server disconnect`, e.g. a backend restart or an
  auth-gate drop), Socket.IO by design does **not** auto-reconnect — a long-lived
  client would stay dead for good. The client now recycles itself after the given
  delay, reconnecting on the same socket (which re-reads the `auth` function, so a
  rotated token is picked up automatically). Set `false` to keep Socket.IO's
  stay-disconnected default. Other disconnect reasons are untouched — Socket.IO's
  own reconnection already handles them.

### Changed

- **`createSocketIOClient` now recovers from a server-initiated disconnect by
  default.** Previously such a disconnect left the client permanently down; it now
  recycles after 1000 ms (see `reconnectOnServerDisconnect` above). Not a breaking
  API change — no signature or export changed — but the runtime behavior differs;
  pass `reconnectOnServerDisconnect: false` to restore the old behavior.

## [0.16.0] — 2026-06-26

### ⚠️ Breaking changes

- **`ai` peer dependency now requires `^7.0.0` (dropped v6).** `mountAgent` /
  `createToolkit` build the Vercel AI SDK `ToolSet` from your contract, so the
  `ai` major stitchkit links against must match the one your app runs. AI SDK 7
  keeps the symbols stitchkit uses — `tool`, `zodSchema`, `ToolSet` — source
  compatible, so **no stitchkit code changed** and the agent-tool surface behaves
  identically. But a consumer still on `ai@6` will hit a peer-dependency conflict
  on upgrade. Move your app to `ai@7` in the same step.
  `// before: "ai": "^6"` → `// after: "ai": "^7"`
  (if your app uses more of the SDK than stitchkit's tool mount, run
  `npx @ai-sdk/codemod v7` to migrate the rest.)

## [0.15.2] — 2026-06-26

### Fixed

- **A `ToolExtend` no longer strips a non-extended tool's own colliding param.**
  (`stitchkit/tools`) `createToolRunner` resolved the extend context only for a
  tool the extend applied to (`shouldExtend`), but stripped the extend keys from
  **every** tool's arguments. So a tool the `extend.filter` excluded, whose own
  contract param is named like an extend key (e.g. a `botId` path param on a
  service the extend doesn't cover), had that argument silently removed → the
  handler received it as `undefined` and validation failed (`Invalid params:
  <key>`), even though the client sent it. The strip is now gated on
  `shouldExtend`, mirroring the resolve — and `applyExtend` already forbids an
  extend key clashing with an extended tool's own field, so a non-extended tool's
  matching param is always legitimately its own. Affects all tool transports
  (MCP / agent / CLI — shared `createToolRunner`).

## [0.15.1] — 2026-06-22

### Fixed

- **Flatten collision-soundness now covers JSON-invisible checks at any depth.**
  (`stitchkit/tools`) 0.15.0 widened a colliding field to `z.unknown()` when its
  kept schema carried a `.refine()`/custom check, but the check was **shallow** —
  it only inspected the top node. A constraint nested below the kept field — behind
  a `.pipe()` output, an object field, an array element, or a `.default()` wrapper —
  still leaked verbatim onto the sibling variant and rejected its valid value (the
  same advertise-stricter-than-union hole, relocated deeper). `hasChecks` is now
  **deep** (recurses through wrappers, object fields, array items and both sides of
  a pipe), so any hidden constraint on a collided key widens to `z.unknown()`.
  Found by a 3-agent final-validation pass. → ADR 0033.

## [0.15.0] — 2026-06-22

### Fixed

- **`flattenUnionInput` no longer produces an unsatisfiable schema when variants
  share a key with different shapes.** (`stitchkit/tools`) The variant-field merge
  was first-wins: two variants declaring the same key with a different type (e.g.
  `media: object` in one, `media: array` in another) silently dropped one → the
  advertised schema was *stricter* than the original union → for the losing
  variant **no valid input existed** (the advertised schema rejected one form, the
  union rejected the other). The merge now **widens** the advertised field to a
  superset — identical types kept, string literal/enum collisions merged into one
  widened `enum`, otherwise `z.unknown()` — so it accepts every variant's value
  while staying free of `oneOf`/`anyOf` (the original union still validates the
  real shape). Covers the same defect on differing enums, object shapes, defaults
  and nested unions. → ADR 0033.
- **Discriminator handling.** A multi-value `z.literal([...])` discriminator now
  keeps all its values, and a `z.enum` discriminator is accepted. A union that
  cannot be flattened (non-string discriminator, non-object variant) is left
  untouched instead of throwing — it no longer crashes the whole `mountMcp` build.
  → ADR 0033.
- **`validateMcpSchemas` now validates the schema that actually ships.** It
  ignored `flattenUnionInput`/`extend`, so the build-time deploy check vetted the
  *un-flattened* schema — falsely failing union inputs and hiding flatten
  incompatibilities. It now takes those options (forwarded by `createMcpHandler`).
  → ADR 0033.
- **`params` + discriminated-union input is now a mountable tool.** `params` and
  `input` are flattened separately then merged, so a union input becomes a
  `ZodObject` and merges with path params into one object — instead of an `allOf`
  intersection MCP rejected. → ADR 0033.
- **`coerceJsonArgs` repairs nested double-serialization.** It coerced only
  top-level args and skipped union inputs; it now recurses into object fields,
  array items and the matching variant of a discriminated union, so a model's
  stringified nested value is un-stringified at any depth. → ADR 0033.

### Added

- **`flattenUnionsDeep` recurses into plain `ZodUnion` members and `ZodRecord`
  values** — a discriminated union nested there now flattens too. → ADR 0033.

## [0.14.0] — 2026-06-22

### Fixed

- **Domain errors no longer collapse to `INTERNAL_SERVER_ERROR` on tool calls.**
  `AppError.is` used `instanceof`, but the package ships as two `bun build`s
  (browser + server) that each bundle their own copy of the `AppError` class. A
  consumer's domain error (`class DomainError extends AppError`, extending the copy
  from `stitchkit`) thrown inside an MCP / agent tool handler or `lifecycle.beforeHandle`
  was checked against the *server* build's copy → `instanceof` false → the real
  `code` / `details` / `hint` were dropped and the model received a generic
  `INTERNAL_SERVER_ERROR` (so weak models retried blindly, cascading 500s). HTTP via
  the framework was affected by the same fragility. `AppError.is` now identifies by a
  global `Symbol.for('stitchkit.AppError')` brand instead of `instanceof`, so every
  chunk's copy — and every consumer subclass — is recognised across the bundle and
  across realms. The brand is non-enumerable (invisible to JSON / spread / keys).
  Additive: it recognises everything `instanceof` did, plus the cross-boundary cases.
  → ADR 0032.

## [0.13.0] — 2026-06-22

### Fixed

- **`flattenUnionInput` now flattens nested discriminated unions, not just the
  top level.** (`stitchkit/tools`) The flag advertises a discriminated union as a
  flat object so a tool schema carries no `oneOf` / `anyOf` (which weaker models
  drop or mangle) — but it only ever flattened a union that was the *entire* input.
  A union nested inside an object field or an array item (e.g. a `content.parts[]`
  that is an array of a discriminated union) still reached the model as `oneOf`. It
  is now **deep**: every discriminated union is flattened at any depth — object
  fields, array items, and through `optional` / `nullable` / `default` /
  intersection wrappers — with `.describe()` hints preserved. Still advertised-only
  and lossy (the original schemas remain the validation schemas in
  `executeToolMethod`), still opt-in behind the same flag, and schemas a transform
  cannot safely rebuild (refined / piped / lazy / plain unions) are left as-is.
  → ADR 0031.

### Added

- **`flattenUnionsDeep`** (`stitchkit/tools`) — the recursive flatten exposed
  beside `flattenDiscriminatedUnion`, for building a `oneOf`-free advertised schema
  directly.

## [0.12.0] — 2026-06-18

### Added

- **`RequestEvent.httpMethod` — the contract verb on tool events.**
  (`stitchkit/observability`) A tool event carries `method: 'TOOL'`; `httpMethod`
  now carries the endpoint's declared verb (`POST` / `GET` / …), so one filter
  tells a read from a write across HTTP and tools —
  `(event.httpMethod ?? event.method) !== 'GET'`. The raw verb, not a derived
  `isMutation` flag (the app decides). A project can fold a hand-rolled tool audit
  into the single `createAuditHook`. → ADR 0030.
- **`errorDetail` on tool audit events** — a failed tool call now carries the
  structured `ToolResult.details` (sanitised) on `RequestEvent.errorDetail`,
  symmetric with the HTTP path. → ADR 0030.

### Changed

- **`setRequestError({ details })` now accepts `unknown` and sanitises it.**
  (`stitchkit/observability`) `details` was typed `JsonValue` (0.11.0), so passing
  a domain `AppError`'s `Record<string, unknown>` details needed a
  `JSON.parse(JSON.stringify(...))` round-trip to launder the type. It now accepts
  the detail raw and runs it through `sanitizePayload` (the same masking/capping as
  the payload) before it lands on `RequestEvent.errorDetail` — no pre-laundering,
  and `errorDetail` can no longer leak a secret. (Considered narrowing
  `AppError.details` to `JsonValue` instead — rejected, it breaks the boundaries
  that build an `AppError` from untyped network data. → ADR 0030.)

### Fixed

- **The access log renders the error code even when `onError` returns its own
  Response.** 0.10.0 rendered `errorCode` only on the framework-default error
  path, so a project with a custom error envelope saw `← 400` with no code. The
  code is now derived from the original error (side-effect-free, no double log) on
  the `onError`-Response path too. → ADR 0030.

## [0.11.0] — 2026-06-18

### Added

- **Audit events carry the endpoint's `(serviceName, action)` identity.**
  (`stitchkit/observability`) `RequestEvent` gains `serviceName` / `action` — the
  stable contract identity of the matched operation (→ ADR 0022), populated on the
  HTTP path and the tool path alike, from the contract rather than parsed from the
  URL. The HTTP pipeline writes it into the request context at route-match, *before*
  validation, so even a pre-handler (400) failure is attributed to its operation.
  A sink with `service` / `action` columns no longer parses them out of `path`.
  → ADR 0029.
- **`setRequestDimensions` — domain dimensions on the audit event.**
  (`stitchkit/observability`) `RequestEvent` gains an opaque
  `dimensions?: Record<string, string>` bag the core attaches no meaning to (the
  ADR 0021 passthrough pattern). Resolve a tenant / project / entity id cheaply
  from `ctx.params` / headers in `beforeHandle` (success) or `onError` (a
  pre-handler failure, which carries `ctx.params` / `ctx.req` since 0.10.0) and it
  lands on the event for the request, success or failure alike — instead of the
  sink re-deriving identity from the path. → ADR 0029.

  Together these let a project drop a hand-rolled `afterHandle` + `onError` audit
  and adopt `createAuditHook` (now identity- and dimension-complete), which also
  removes that split's success/error asymmetry.

## [0.10.0] — 2026-06-17

### ⚠️ Breaking changes

- **`createContractDispatcher` removed** (`stitchkit/tools`) — along with the
  `ContractDispatcher` and `ContractDispatcherConfig` types. It shipped in 0.9.0
  for one requesting consumer (a webview ↔ local-sidecar raw-WebSocket lane), who
  on integration did not adopt it: their boundary already had a ~40-line executor,
  the typed-envelope benefit was a ~10-line addition to their own wire, and
  migrating *to* the dispatcher was net +90–110 lines. No other consumer uses it,
  so the export is withdrawn rather than carried as speculative surface toward 1.0.
  The execution core (`executeToolMethod`) is unchanged and still internal — a BYO
  executor can be re-exposed on real evidence later. The rest of 0.9.0
  (`idempotent`, `createRetainedTopics`, `MultipartFile` / `FileDescriptor`, the
  open `TransportSource` union) is unchanged. → ADR 0028.

  ```ts
  // before: const d = createContractDispatcher(service, { source: 'local-ws' })
  //         const result = await d.dispatch(method, args)
  // after:  run the method on your own transport — validate the frame against the
  //         contract's Zod schemas and call the handler (the ~40-line executor a
  //         raw-WS/IPC lane already has). `ctx.source` stays an open tag.
  ```

### Fixed

- **`onError` now sees the path params and the request on a validation failure.**
  Body/param validation runs before `beforeHandle`, so a malformed request threw
  while the context was still being assembled — `onError` (and any audit built on
  it) received an empty context: no `params`, no request, so a pre-handler failure
  could not be attributed to the resource it targeted. The context is now bound
  from the URL (path params, request) *before* parsing, so a validation failure
  still hands `onError` the matched path params, the `Request`, and the endpoint
  identity. The schema-validated `params` / `input` still replace the raw values
  on success — no change to a successful request.

### Added

- **`req` / `url` / `headers` are first-class, typed fields on the handler
  context.** They were already present at runtime but only under the context's
  index signature (`unknown`), so reading them needed an `as` cast. They are now
  declared on `RuntimeContext` / `HandlerContext` as optional Web Fetch types
  (`Request` / `URL` / `Headers`) — set on the HTTP transport, absent on the tool
  transports (MCP / agent / CLI / a bring-your-own lane). The core stays
  Fetch-clean. Additive — existing code is unaffected.
- **The built-in access log renders the error code.** A failed request logged
  `← 400 3ms` with no code, though the framework already knew it. The completed
  line now carries it — `← 400 VALIDATION_ERROR 3ms` (dev) / an `errorCode` field
  (prod JSON and a custom `StitchLogger`).
- **`setRequestError` accepts structured `details`, surfaced as
  `RequestEvent.errorDetail`.** (`stitchkit/observability`) The error handler can
  record the structure the message string flattens (e.g. the failing Zod issues)
  alongside the code and message; `createAuditHook` carries it onto the audit
  event. Additive — `details` is optional.

## [0.9.0] — 2026-06-05

### Added

- **Run a contract over a bring-your-own transport — `createContractDispatcher`.**
  (`stitchkit/tools`) Drives a `defineContract` over a transport stitchkit does
  not own (a raw-WebSocket lane between a webview and a local sidecar, an IPC
  channel, a queue worker) without hand-rolling a method registry. `dispatch(method,
  args, context?)` runs a method by its contract key through the **same** execution
  core as the MCP / agent mounts — same Zod validation, the same `{ ok, data } |
  { ok: false, code, details, hint }` envelope, the same `beforeToolCall` /
  `afterToolCall` hooks and `beforeHandle` scope gate. The app keeps its own wire
  (framing, handshake, reconnect); stitchkit ships the executor, not a competing
  engine. → ADR 0027.
- **`idempotent?: boolean` on an endpoint** — a transport-neutral hint that the
  operation is safe to call twice with the same input (like HTTP `PUT`/`DELETE`).
  The core attaches no behaviour; it rides through to `MethodDef.idempotent`, where
  a retrying transport reads it to decide whether to replay a call after a
  reconnect. → ADR 0027.
- **`createRetainedTopics` — sticky events (retained last value).** (`stitchkit`,
  browser-safe) A transport-agnostic store that replays the last payload per topic
  to a late subscriber (MQTT retained / `BehaviorSubject`), so a subscriber that
  connects or re-renders after an event still sees current state.
  `createSocketIOClient` gains a **`retain`** option that uses it — list the
  server → client events to retain and a late `on()` handler is replayed the last
  value at once (and across a `disconnect()` / `connect()` cycle). → ADR 0027.
- **`TransportSource` is now an open union** (`… | (string & {})`) — the four
  built-in transports keep autocomplete, and a bring-your-own transport can tag
  its calls (`source: 'local-ws'`). Additive — no existing value breaks. → ADR 0027.

- **Typed client multipart accepts a platform file descriptor, not only `Blob`.**
  React Native / Expo represent a file as `{ uri, name, type }` (their `FormData`
  streams it from disk by `uri`); the client previously hard-required
  `file instanceof Blob`, forcing RN consumers to bypass the typed client and
  hand-roll `FormData` + `fetch` (losing baseUrl / auth / per-endpoint timeout /
  `ApiError` / output parsing). The multipart file field now accepts
  `Blob | FileDescriptor`, and the new public types `MultipartFile` and
  `FileDescriptor` let a consumer type its own upload helpers. The web / Bun path
  is unchanged (`Blob`); the descriptor is matched only when it carries string
  `uri` + `name` + `type` and is not a `Blob`.

## [0.8.1] — 2026-06-05

### Fixed

- **Browser bundlers no longer break on the root `stitchkit` entry.** A
  `createRequire` / `node:module` helper from the MCP-apps code was hoisted by the
  bundler (`--splitting`) into a shared chunk that the browser-safe root entry
  side-effect-imported, so a client build (Next.js / Turbopack) failed with
  *"the chunking context does not support external modules (request:
  node:module)"*. The browser-safe entrypoints (`stitchkit`, `/react`,
  `/contract`) are now built **separately** from the server / tools entrypoints,
  so no Node built-in can leak into their graph; a post-build
  `check-browser-clean` guard fails the build if one ever does, and the Node
  smoke test now also runs in the local `verify` gate (not just CI).

## [0.8.0] — 2026-06-05

### Server

- **Raw routes combine `:param` with a trailing `/*` wildcard** — `/app/:slug/*`
  now matches `/app/x/a/b` with `ctx.params.slug === 'x'` and the remainder in
  `ctx.params['*']` (an SPA deep-link fallback). Previously a trailing `/*` was a
  literal prefix and a `:param` before it was not interpolated, so such a route
  404'd. Pure literal wildcards (`/static/*`) are unchanged and now also expose
  the remainder as `params['*']`.

### Pagination

- **`encodeCursor` / `decodeCursor`** (`stitchkit`) — the opaque cursor codec that
  completes the pagination story (`Paginated` / `paginatedSchema` /
  `createCursorQuery` already shipped). Encode a keyset value (`{ v, id }`) into
  the `nextCursor` string and decode + Zod-validate it back (garbage / malformed →
  `null`, treated as "no cursor"). base64url over UTF-8 via `btoa`/`atob` — works
  on the server, the typed client and the browser, and a non-ASCII sort value
  round-trips (a naïve `btoa(JSON)` corrupts it; `Buffer` is not browser-safe).
  The keyset WHERE clause stays in the app (ORM-specific); this is only the
  string ⇄ value codec.

### Docs & packaging

- **The package now ships `llms.txt` + `llms-full.txt`** — a consumer-agent entry
  point. `llms.txt` is a curated index of the guide + reference; `llms-full.txt`
  inlines the whole guide for offline use. Generated from `docs/` by
  `bun run gen:llms` (runs in `build`). A coding agent in a consuming project
  reads them from `node_modules/stitchkit/`.
- **A Claude Code skill** (`skills/stitchkit/`) — the consumer build workflow for
  agents that support skills.
- **Breaking-change marking convention + an [upgrading guide](docs/guide/upgrading.md)** —
  a release that breaks a public API leads its changelog entry with a
  `### ⚠️ Breaking changes` section (with before → after); a version without one
  is purely additive. Docs reorganised into two roads — *build with* (README +
  guide + `llms.txt`) vs *develop* (AGENTS.md + CONTRIBUTING).

## [0.7.0] — 2026-06-05

### Errors

- **Published stitch error-code registry** — `STITCH_ERROR_STATUS` (the `code →
  HTTP status` map for the codes stitchkit itself emits), `StitchErrorCode` (its
  `keyof`, so type and map never drift) and `isStitchErrorCode()`, exported from
  `stitchkit` and `stitchkit/server`. A consumer maps stitch → app codes in an
  `onError` hook against `Record<StitchErrorCode, …>` instead of a hand-copied
  string list — a renamed/added code becomes a TS error, not a silent 500.
  `appError()` and the router resolve status through it (`METHOD_NOT_ALLOWED` →
  405). → ADR 0026.

### Tools

- **`afterToolCall` / `beforeToolCall` now receive the `MethodDef`** as a final
  argument — the tool-side twin of `afterHandle(ctx, result, endpoint)`. Read
  `endpoint.serviceName` / `.key` / `.meta` directly for audit / metrics; no
  toolName→identity map and no replicating the internal tool-naming (which lost
  audit rows for auto-named tools). → ADR 0022.

### Server

- **Configurable multipart upload limit** — `EndpointDef.maxUploadBytes`
  (per-route) and `createServer`/`createHandler` `maxUploadBytes` (global
  default) thread into `parseMultipart`, replacing the hard-coded 25 MB cap. A
  per-route value overrides the global; without either the 25 MB framework
  default applies (avatar 5 MB vs video 200 MB declared per endpoint).
- **Actionable missing-peer errors** — `createSocketIOServer` now turns a missing
  optional peer into `"needs the optional peer \"@socket.io/bun-engine\" — install
  it: bun add @socket.io/bun-engine"` instead of a bare `Cannot find module` at
  bootstrap.

### Docs

- New **peer-dependency matrix** (feature → packages) in getting-started, so the
  optional peers each feature needs are discoverable up front.
- Documented that span ids live in the observability request context
  (`getRequestContext()?.trace`), not on the handler `ctx` — the core carries a
  single `traceId`.

## [0.6.0] — 2026-06-05

### Range-capable file serving

- **`serveFile(req, opts)`** (`stitchkit/server`, Bun) — serve a file with full
  HTTP `Range` support (`206` / `416` / `Content-Range` / `Accept-Ranges`) plus
  the conditional-request handling Range correctness needs: weak `ETag`,
  `Last-Modified`, `If-Range`, and `If-None-Match` / `If-Modified-Since` → `304`.
  Handles `HEAD`, streams the byte range via `Bun.file().slice()` (no full read
  into memory), and auto-detects `Content-Type`. For media seeking / caching that
  `staticRoute` deliberately does not cover. → ADR 0023.
- **`parseByteRange(header, size)`** + **`weakETag(size, mtimeMs)`** — the pure,
  runtime-neutral core, exported for direct use and unit testing. Single-range
  only; multiple ranges return `null` (full `200`).
- **`staticRoute` now detects media MIME types** (mp4 / webm / mov / mp3 / m4a /
  wav / ogg / pdf / wasm / …) — the extension→MIME map is shared with
  `serveFile`. Behaviour is otherwise unchanged (still basic, in-memory).

### Resource-scoped mounting & client

- **`scopePrefixes`** on `createServer` / `createHandler` — a `scope → URL prefix`
  map (`{ tenant: 'tenants/:tenantId', … }`). Each `services` entry mounts under
  its `service.scope` prefix (`:param` segments reach the context); an unmapped
  scope mounts flat; explicit `groups` are unaffected. Declares the
  scope↔prefix mapping once instead of hand-partitioning into groups. Scope stays
  a free string. → ADR 0024.
- **Typed scoped client** — `stripPrefixKeys` (a `const` tuple) now adds the
  consumed keys as required, typed args on every method of the client
  `createClient` returns. `createClient(c, http, { stripPrefixKeys: ['tenantId'] })`
  → `api.list({ tenantId, … })` is typed; the per-tenant scoped-client type
  wrapper is no longer needed. The **bare-fetch client** (a plain `{ baseUrl }`
  config) now also honours `pathPrefix` / `stripPrefixKeys` — previously only the
  `HttpClient` path did, so the typed keys had no runtime effect there.
  `TypedHttpClient<C>` is now an alias of the new `ScopedHttpClient<C, unknown>`
  (structurally identical). → ADR 0025.

### Realtime

- **`SocketIOServerConfig.serverOptions`** — a typed passthrough for the rest of
  socket.io's `ServerOptions` (`maxHttpBufferSize`, `connectionStateRecovery`,
  `perMessageDeflate`, `connectTimeout`, …). On Bun the engine-level options
  (`maxHttpBufferSize`, ping heartbeat, `upgradeTimeout`) are now forwarded to the
  hand-built `@socket.io/bun-engine` too — previously only `path` reached it, so a
  configured `maxHttpBufferSize` was silently dropped and large emits truncated at
  the 1 MB default. → ADR 0008.

### Raw-route helpers

- **`respondJson` / `errorResponse` / `parseBody`** (`stitchkit/server`) — the
  three things every raw route re-implemented: a JSON response (`204` for
  null/undefined), the framework error envelope from any thrown value (via
  `normalizeError`, with `x-request-id` when in a request context), and a
  no-throw Zod body parse (`data | null`). Conveniences over the existing error
  normalization — raw routes and contract routes now return identical errors.

### Tools

- **`McpServerBuildConfig.extend`** — `ToolExtend` now reaches the batteries-path
  (`createMcpHandler` / `buildMcpServer`), not only the manual `mountMcp` /
  `mountAgent`. Add a tool argument (e.g. a `tenantId` resolved into handler
  context) without hand-wrapping every service. → ADR 0007.

### Endpoint identity for hooks & audit

- **`MethodDef.serviceName` + `MethodDef.key`** — stable `(service, action)`
  identity (contract prefix + endpoint key), populated by `implement` /
  `implementRemote`. Read it in `beforeHandle` / `afterHandle` / `onError` (or on
  a tool mount) to key audit / metrics — the action is not in the URL and
  `toolName` is absent on HTTP-only endpoints, so this is the only stable pair.
  → ADR 0022.
- **`implementRemote` now passes `EndpointDef.meta` through** — it was dropped for
  remote-proxied contracts (`implement` already carried it). → ADR 0021.

### Client

- **`ContractClientConfig` and `ClientConfig` are now exported from the root
  `stitchkit` entrypoint** — the per-tenant / resource-scoped client config and
  the bare-fetch client config (siblings of `HttpClientConfig` /
  `SocketIOClientConfig`, which were already exported).

### Fixed

- **`safePath` no longer ships raw control bytes in `server/logger.ts`** — the
  sanitiser was a regex literal containing literal `\x00`–`\x1f`/`\x7f` bytes,
  which older Bun regex parsers (≤ 1.3.5) reject at parse time, so `import
  'stitchkit'` threw on those versions (`engines.bun >= 1.2.0`). Rewritten as a
  char-code filter (no regex, no raw bytes); a regression test scans `src/**`
  for raw control bytes so it cannot recur.

### Docs

- Documented the `EndpointDef.meta` gotcha — declare a meta type as a `type` /
  inline literal / `satisfies`, not an `interface` (an interface is not
  assignable to `Record<string, unknown>`). Guide + ADR 0021 + field JSDoc.
- New **multi-tenant / resource-scoped** guide (`docs/guide/multi-tenant.md`) —
  contract → `scopePrefixes` server → auth → typed scoped client → `extend` for
  the AI surface, end to end.
- **Node deployment** documented — `serveNode` in getting-started and a "Deploy on
  Node" section (`@types/bun` peer, `transports: ['websocket']`, Bun-only helpers).

## [0.5.0] — 2026-06-05

### Endpoint metadata passthrough

- **`EndpointDef.meta`** + **`MethodDef.meta`** (`Record<string, unknown>`) — an
  opaque, app-defined per-endpoint metadata bag the core attaches no meaning to
  (the `scope`-style escape-hatch). It rides through `implement()` and is
  readable in lifecycle hooks (`beforeHandle`/`afterHandle`/`onError`) and on
  tool mounts — for app concerns the generic core does not model (feature gate,
  rate tier, cache hint, doc tag). Never serialized into OpenAPI. → ADR 0021.

## [0.4.0] — 2026-06-05

### Realtime — token handshake auth + a raw WebSocket lane

- **`SocketIOClientConfig.auth`** (`stitchkit`) — token-based handshake auth, the
  alternative to cookie auth (`withCredentials`). Reaches the server as
  `socket.handshake.auth`. A **function** form (sync or async) is re-read on
  every (re)connect, so a rotated token is picked up without recreating the
  client (and losing durable subscriptions). **`query`** and **`extraHeaders`**
  added alongside. No server change — the gate stays project `io.use(...)`.
- **`composeWebSocketHandlers`**, **`webSocketLane`**, **`socketIoLane`** +
  types **`ComposedLane` / `WebSocketLane` / `WebSocketComposeConfig`**
  (`stitchkit/server`, Bun-only) — compose Bun's single `websocket` handler from
  several lanes, so a truly-raw binary lane can run beside Socket.IO on one
  server. Routing is by a positive raw marker on `ws.data`; Socket.IO is the
  catch-all, so the engine's opaque data is never inspected — cast-free. → ADR 0020.

### MCP Apps — interactive UI widgets

A contract tool can now render an inline UI widget in the chat (MCP Apps /
SEP-1865). stitchkit owns the generic plumbing; the app owns the widget HTML/UI.

- **`EndpointDef.ui`** — a tool endpoint declares `ui: { resourceUri, visibility? }`;
  its MCP registration carries `_meta.ui` so a host renders the named `ui://`
  resource as a widget for that tool's results.
- **`McpServerBuildConfig.resources`** + **`mountMcpResource()`** (`stitchkit/tools`) —
  serve `ui://…` UI resources over `resources/list` / `resources/read`, default
  MIME `text/html;profile=mcp-app`, with per-resource `_meta.ui` (CSP, border, domain).
- **`inlineMcpAppBundle()`**, **`RESOURCE_MIME_TYPE`**, **`EXT_APPS_BUNDLE_PLACEHOLDER`**,
  **`McpResourceDef` / `McpAppCsp` / `McpAppResourceMeta`** (`stitchkit/tools`) —
  inline the `@modelcontextprotocol/ext-apps` runtime (new optional peer) into a
  widget HTML; the app keeps full ownership of the widget markup.

### CLI — the fourth transport

A `defineContract` now drives a command-line program too, peering with the HTTP,
MCP and agent surfaces — same validation, same auth gate, same error model
(HTTP ≡ MCP ≡ agent ≡ CLI). See [ADR 0016](./docs/decisions/0016-cli-transport.md)
and the [CLI guide](./docs/guide/cli.md).

- **`createCli()`** (`stitchkit/cli`, also `stitchkit/tools`) — build and run a
  CLI from contract services: `<app> <command> [positional] [--flags]`. Resolves
  identity once at startup, routes each command through the shared
  `executeToolMethod` pipeline. The `stitchkit/cli` entrypoint needs neither the
  MCP SDK nor `ai`.
- **`Transport` gains `'CLI'`, `TransportSource` gains `'cli'`.** CLI exposure is
  **opt-in** — a method is a command only when its `expose` lists `'CLI'`.
- **CLI-unique behaviour:** schema-aware argv coercion, positional args, piped
  stdin, `--json` / `--quiet` / `--dry-run`, per-`ToolResult.code` exit codes,
  `--output-dir` downloads, and a generic `--wait` poller (`pollUntilDone`).
- **`parseCliArgs`, `emitResult`, `DEFAULT_EXIT_CODES`, `CliConfig`,
  `CliWaitConfig`, `ExitCodeMap`** and friends are exported for advanced use.
- The core ships **no binary** — `createCli` is the building block; an app writes
  its own `#!/usr/bin/env node` executable and `bin` entry.
- **Output is JSON** — pretty-printed by default (like an MCP tool result),
  compact with `--json` for `| jq`. No hand-formatted tables; the audience is
  agents / scripts. Per-command `format` overrides are intentionally not shipped.
- **`passthrough`** — a command's unknown `--flags` fold into a freeform object
  field (`generate <model> --prompt … --aspect_ratio 16:9` → `parameters`), no
  `--parameters '{json}'` blob.

### Generic native MCP tools

The imperative tools the contract model can't express — shipped generic so an
app configures them instead of hand-rolling on the raw SDK. → [ADR 0019](./docs/decisions/0019-generic-native-tools.md).

- **`mountWait` / `mountDownload` / `mountUpload`** (`stitchkit/tools`) — native
  MCP tools (poll-until-done / save URL to disk / upload a local file); the app
  injects the domain (`poll` / `done`, `resolveUrl`, `upload`).
- **`pollUntil`** — one backoff/timeout poll loop behind both the CLI `--wait`
  (`pollUntilDone`) and `mountWait` — no duplicate loop.
- **`type McpServer` is re-exported** from `stitchkit/tools` so a native-tool
  registrar needs no direct `@modelcontextprotocol/sdk` import.

### Fixes

- **Remote errors keep their code.** `implementRemote` translates the typed
  client's `ApiError` to `AppError`, so a proxied remote `400` surfaces as a
  clean `VALIDATION_ERROR` (correct exit code, no stack) instead of being
  flattened to `INTERNAL_SERVER_ERROR`.
- **`z.record(...)` arguments are JSON-coerced** — a `--parameters '{…}'` string
  for a record-typed field now parses (was object/array only).

### Typed tool-path context

- **`createToolkit<AppContext>()`** (`stitchkit/tools`) — the tool-side mirror of
  `createImplement`. Returns context-pinned `mountMcp` / `mountAgent` /
  `buildMcpServer` / `createMcpHandler` / `createStdioMcpServer` / `createCli`,
  type-checking the injected `context` (and `ToolExtend.resolve`) against your
  app's context shape. Pure typing sugar; the loose form still compiles.
  See [ADR 0017](./docs/decisions/0017-typed-tool-context.md). `ToolExtend` is now
  generic (`ToolExtend<TContext>`).

### OpenAPI 3.1 from the contract

- **`generateOpenApiDocument()` / `openApiRoute()`** (`stitchkit/server`) —
  generate an OpenAPI 3.1 document straight from contract services (HTTP-exposed
  methods only), sharing the single `toJsonSchema` point and the `jsonSchemaFields`
  walker with the CLI `--help` table. No decorators, no parallel spec.
  See [ADR 0018](./docs/decisions/0018-openapi-generation.md).

### OAuth 2.1 for MCP

A remote MCP server can now be a native Claude (Desktop / web) custom connector —
the framework ships the OAuth 2.1 resource-server machinery, the app supplies
only identity and storage. See [ADR 0015](./docs/decisions/0015-oauth-resource-server.md).

- **`createMcpHandler({ protectedResource })`** — a `401` now carries
  `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1) so a client
  can discover the authorization server.
- **`oauthProtectedResourceRoute()`** (`stitchkit/tools`) — serves
  `/.well-known/oauth-protected-resource` (RFC 9728).
- **`mountOAuthProvider()`** (`stitchkit/tools`) — returns the authorization-
  server routes: AS metadata (RFC 8414), Dynamic Client Registration
  (RFC 7591), `/authorize` and `/token` with PKCE (RFC 7636) and resource
  indicators (RFC 8707). Pluggable `clients` / `codes` / `refreshTokens` stores
  and an `authorizeUser` login/consent callback.
- **`signJwt()`** (`stitchkit/server`) — HS256 signer, the issuing counterpart
  of `verifyJwt`; mints access tokens whose `aud` binds them to one resource.
- **`verifyPkce()` / `deriveCodeChallenge()`** (`stitchkit/server`) — S256 PKCE.

### Observability

- **`RequestEvent` gains `authMethod` and `clientId`** — the audit event now
  carries how a tool call authenticated (`'oauth'` / `'apikey'`) and the OAuth
  client id, threaded through `createAuditHook`.

### Security & correctness hardening (pre-release)

A per-file review of the unreleased surfaces above closed a set of holes before
the cut.

- **SSRF guard is now shared and applied to every fetched URL.** The
  `view_file` private-host / per-redirect-hop guard is extracted to one module
  and reused by **`mountDownload`** and the CLI **`--output-dir`** downloader —
  both fetch model/handler-derived URLs that were previously fetched raw. New
  `allowPrivateHosts` (download tool) / `allowPrivateDownloadHosts` (CLI) opt-ins.
- **A redirect to a non-`http(s)` scheme is refused.** A `302` to
  `file://` / `gopher://` no longer turns a fetch into a local-file read; the
  scheme is re-checked on every hop.
- **Download bodies are size-capped.** `mountDownload` / CLI downloads read with
  a byte cap (`maxBytes` / `maxDownloadBytes`, default 100 MB) so a hostile or
  unbounded URL cannot OOM the process.
- **CLI download filenames are contained.** A result `name` is reduced to its
  basename and re-checked, so `../../etc/x` cannot escape `--output-dir`.
- **`view_file` local reads are media-only + symlink-safe** — a non-media file
  (`config.json` / `.env`) inside the sandbox is refused, and a symlink that
  points out of the sandbox is rejected via a `realpath` re-check.
- **RFC 9728 metadata path fixed.** For a resource with a path
  (`https://h/mcp`), the protected-resource metadata is served at
  `/.well-known/oauth-protected-resource/mcp` (the path is no longer dropped).
- **PKCE is S256-only.** `plain` is removed (`verifyPkce(verifier, challenge)`,
  no method arg) — OAuth 2.1 forbids it for public clients.
- **DCR is stricter.** `refresh_token` is advertised in the registration
  response only when the grant is enabled; an `http` redirect URI is accepted
  only on a loopback host (RFC 8252).
- **OpenAPI accuracy.** Multipart endpoints are documented as
  `multipart/form-data`; DELETE input is documented as query params (matching the
  typed client, via the shared `inputIsQuery`); `requestBody.required` reflects
  whether the body schema has required fields; a single unrepresentable field
  (`z.date()`, …) degrades to `{}` instead of collapsing the whole endpoint.
- **CLI prototype-pollution & passthrough.** A `--__proto__…` flag (dotted or
  flat) is dropped at every argv write boundary; `--parameters '{json}'` merged
  with passthrough flags no longer loses the JSON payload.

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

[Unreleased]: https://github.com/max-listov/stitchkit/compare/v0.43.1...HEAD
[0.43.1]: https://github.com/max-listov/stitchkit/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/max-listov/stitchkit/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/max-listov/stitchkit/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/max-listov/stitchkit/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/max-listov/stitchkit/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/max-listov/stitchkit/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/max-listov/stitchkit/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/max-listov/stitchkit/compare/v0.36.1...v0.37.0
[0.36.1]: https://github.com/max-listov/stitchkit/compare/v0.36.0...v0.36.1
[0.36.0]: https://github.com/max-listov/stitchkit/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/max-listov/stitchkit/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/max-listov/stitchkit/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/max-listov/stitchkit/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/max-listov/stitchkit/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/max-listov/stitchkit/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/max-listov/stitchkit/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/max-listov/stitchkit/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/max-listov/stitchkit/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/max-listov/stitchkit/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/max-listov/stitchkit/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/max-listov/stitchkit/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/max-listov/stitchkit/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/max-listov/stitchkit/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/max-listov/stitchkit/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/max-listov/stitchkit/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/max-listov/stitchkit/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/max-listov/stitchkit/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/max-listov/stitchkit/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/max-listov/stitchkit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/max-listov/stitchkit/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/max-listov/stitchkit/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/max-listov/stitchkit/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/max-listov/stitchkit/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/max-listov/stitchkit/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/max-listov/stitchkit/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/max-listov/stitchkit/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/max-listov/stitchkit/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/max-listov/stitchkit/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/max-listov/stitchkit/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/max-listov/stitchkit/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/max-listov/stitchkit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/max-listov/stitchkit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/max-listov/stitchkit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/max-listov/stitchkit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/max-listov/stitchkit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/max-listov/stitchkit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/max-listov/stitchkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/max-listov/stitchkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/max-listov/stitchkit/releases/tag/v0.1.0
