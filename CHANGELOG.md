# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

A release that breaks a public API leads its entry with a **`### ⚠️ Breaking
changes`** section (with before → after migration snippets); a version without
that section is purely additive. To move a project across versions, see
[`docs/guide/upgrading.md`](docs/guide/upgrading.md). **No breaking changes
through 0.7.0** — every release so far has been additive.

## [Unreleased]

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

[Unreleased]: https://github.com/max-listov/stitchkit/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/max-listov/stitchkit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/max-listov/stitchkit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/max-listov/stitchkit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/max-listov/stitchkit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/max-listov/stitchkit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/max-listov/stitchkit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/max-listov/stitchkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/max-listov/stitchkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/max-listov/stitchkit/releases/tag/v0.1.0
