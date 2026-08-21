# Upgrading stitchkit

How to move a consuming project from one stitchkit version to another — including
across many versions at once (a project frozen on an old version, then jumped
forward). The process is mechanical: stitchkit marks every breaking change in one
place and one format, so you can recover the full migration from the version diff.

## The one rule that makes this work

A release that breaks a public API leads its `CHANGELOG.md` entry with a
**`### ⚠️ Breaking changes`** section (exact heading), each item carrying a
**before → after** snippet. A version with **no** such section is **purely
additive** — adopting it changes nothing in your code. (See
[`AGENTS.md` → Breaking changes](../../AGENTS.md).)

So upgrading is: read the `### ⚠️ Breaking changes` of every version *above* your
current one *up to* your target, and apply each snippet.

## Flow (agent or human)

1. **Find the current version.** In the consumer: the resolved `stitchkit` in
   `bun.lock` (authoritative), or `node_modules/stitchkit/package.json`. The range
   in `package.json` (`^0.6.0`) is intent, not the installed truth.
   > A `file:` link (`"stitchkit": "file:…"`) means the consumer tracks a **local
   > checkout**, not a published version — its effective version is whatever that
   > checkout's `package.json` says, and a plain `install` will not relink it after
   > the local version moves (`bun install --force` does). Prefer a real
   > `^x.y.z` range for reproducibility.

2. **Pick the target.** Latest published (`bun pm view stitchkit version`) or a
   specific `x.y.z`.

3. **Read the breaking sections in range.** In stitchkit's
   [`CHANGELOG.md`](../../CHANGELOG.md), for every version `> current` and
   `<= target`, read its `### ⚠️ Breaking changes`. Versions without that section
   are additive — skip them. (Fast scan: `grep -n "Breaking changes" CHANGELOG.md`.)

4. **Apply each migration** — the before → after snippet tells you exactly what to
   change at each call site. There are no deprecation shims to lean on; the old
   shape is gone, so every site must move.

5. **Bump and install.** `bun add stitchkit@<target>` (or update the range), then
   `bun install`. Note the caret: `^0.7.0` is `< 0.8.0`, so crossing a breaking
   minor is always an explicit version bump, never automatic.

6. **Verify.** `bun run check` (or per-package typecheck) — TypeScript catches the
   removed/renamed/retyped surfaces. Then a **runtime smoke** (typecheck ≠
   runtime): bootstrap the server, one HTTP request, and any feature you rely on
   (Socket.IO connect, an MCP tool call, a multipart upload, …).

## Released migration: 0.56.0

### Surface manifests are version 2

`operation.tools` could not describe a role-selected MCP surface, a different
Agent or CLI selection, or an advertised `extend` schema, so projections moved
out of the canonical operation:

```ts
// before
manifest.operations[0].tools.MCP
// after
manifest.toolSurfaces.find((s) => s.transport === 'MCP' && s.surface === null)?.tools

// before
buildSurfaceManifest({ mcpSurfaces: { admin: { services, extend } } })
// after
buildSurfaceManifest({ mcpSurfaces: { admin: { services } }, mcpPreparation: { extend } })
```

A committed snapshot is regenerated once, deliberately: `manifestVersion` is
`2`, and `ConformanceTransport` gained `REALTIME`, so any exhaustive
`Record<ConformanceTransport, …>` must handle it.

### `FILE_*` codes joined the error registry

`StitchErrorCode` gained `FILE_INVALID_PATH`, `FILE_OUTSIDE_ROOT`,
`FILE_NOT_FOUND`, `FILE_NOT_REGULAR`, `FILE_INSPECTION_REJECTED`,
`FILE_TOO_LARGE` and `FILE_EXISTS`. Only exhaustive maps break:

```ts
// before — compiled while the registry had no file codes
const copy: Record<StitchErrorCode, string> = { …, RATE_LIMITED: '…' }
// after — add the seven managed-file codes (or use Partial<Record<…>>)
```

Unexpected IO stays scrubbed as `INTERNAL_SERVER_ERROR`: the new codes are the
caller-safe ones only.

### `ScopedAuthHook` is nominal

A hand-written function shaped like an auth hook is no longer assignable —
identity now comes from the factory, so scope ownership and the inferred
context cannot drift apart:

```ts
// before — a structural stand-in
const auth: ScopedAuthHook<Scopes> = async (ctx, endpoint) => { … }
// after — create it, then compose domains
const auth = createAuthHook({ resolve, rules })
const composed = composeAuthHooks({ hooks: [auth, billingAuth], defaultScope: 'public' })
```

### Managed-file inspectors also run on reads

An inspector is no longer write-only, and it has a finite default deadline
(15 s). Make it read-aware and idempotent — a read carries no
`declaredMediaType`:

```ts
// before
inspect: ({ declaredMediaType }) => inspectDeclaredType(declaredMediaType!)
// after
inspect: ({ prefix, declaredMediaType, signal }) =>
  inspectBytes(prefix, { declaredMediaType, signal })
```

Set `inspectionTimeoutMs` explicitly when 15 seconds is the wrong budget.

### Direct async-operation binding needs a wire-stable ID

A direct binding reuses the start output as the follow-up wire input, so the ID
schema must parse to itself (`z.input` equals `z.output`, no transform,
coercion, default or overwrite). Anything else is parsed twice:

```ts
// before — a transform silently ran on start and again on every follow-up
defineAsyncOperationContract({ binding: 'direct', id: z.string().transform(Number) })
// after — keep the wire shape, adapt explicitly
defineAsyncOperationContract({
  binding: 'adapted',
  id,
  adapters: { idFromStart, inputFor },
})
```

## Released migration: 0.55.0

### Peer-free `implementRemote`

`implementRemote` now has one canonical, optional-peer-free owner. This keeps
MCP SDK and AI SDK modules out of CLI bundles that only proxy HTTP calls:

```ts
// before
import { implementRemote } from 'stitchkit/tools'
// after
import { implementRemote } from 'stitchkit/remote'
```

### Managed file boundary and strict auth returns

Create one boundary during application bootstrap and pass the capability, never
a per-call directory or host path:

```ts
import { createManagedFileBoundary } from 'stitchkit/files'

const files = await createManagedFileBoundary({ root: '/srv/app-files' })

// before
defineDownloadTool({ defaultDir: '/srv/app-files', resolveUrl, ...common })
defineUploadTool({ upload: (path) => provider.uploadFile(path), ...common })
defineViewFileTool({ baseDir: '/srv/app-files', ...common })

// after
defineDownloadTool({ files, resolveUrl, ...common })
defineUploadTool({ files, upload: ({ bytes }) => provider.upload(bytes), ...common })
defineViewFileTool({ files, ...common })
```

Downloaded `path` is now relative to the boundary and MIME metadata is named
`mediaType`. Update raw `mountDownload`/`mountUpload`/`mountViewFile` configs the
same way. Auth predicates must explicitly return `true`, `false`, or a plain
object of context fields; replace accidental `undefined` fallthroughs with the
intended boolean.

## Released migration: 0.53.0

### Realtime `emit` returns `boolean` instead of `void`

Every **call site** compiles and behaves exactly as before — the return value
is new information (`true` = accepted by the transport, `false` = dropped
while the browser client was disconnected), not a behavior change. What breaks
is **implementing** the interfaces: a test mock or app-side adapter of
`SocketIOClient` / `RealtimeClient` / `ValidatedRealtimeSocket` /
`RealtimeServer` whose `emit` returns `void` no longer typechecks.

```ts
// before — a void mock satisfied the interface
const mock: Pick<RealtimeClient<S, C>, 'emit'> = { emit: () => {} }
// after — report acceptance (true is what a live server-side emit reports)
const mock: Pick<RealtimeClient<S, C>, 'emit'> = { emit: () => true }
```

While migrating, consider replacing hand-rolled `if (client.connected)` guards
with the new honest surface: check `client.emit(...) === false`, or observe
drops centrally with `onDroppedEmit`.

## Released migration: 0.50.0

### The factory's scope union now covers per-endpoint overrides

`createContractFactory<Scope>()` already required a typed `scope` on the
contract. It now holds a per-endpoint `scope` override to the same union. Nothing
to migrate unless an override is outside the union — which was always a bug: the
scope reached no auth rule, and `createAuthHook` threw
`[stitchkit] auth: no rule for scope "…"` on the first request to it.

```ts
const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>()

defineContract({ prefix: 'posts', scope: 'user' }, {
  // before: compiled; failed at request time
  // after:  compile error naming the scope (TypeScript even suggests 'admin')
  purge: { method: 'DELETE', path: '/all', desc: 'Purge', scope: 'admn', output },
})
```

Fix the typo, or widen the factory union if the scope is real. Contracts built
with plain `defineContract` are unaffected.

### A declared `defineErrors` message is now used

`ErrorDefinition` accepts `message`. Nothing to migrate unless a registry already
wrote that key: it type-checked before (excess-property checking does not fire
through a `const` generic) and was ignored, so the code itself went on the wire.

```ts
const { errors } = defineErrors({ GONE: { status: 410, message: 'Long gone' } })
// before: errors.GONE().message === 'GONE'
// after:  errors.GONE().message === 'Long gone'
```

If a registry carried `message` as a note to the reader rather than as
user-facing text, either fix the text or drop the key. A code with no `details`
schema also shows that text to a model (its tool `details` is `{ message }`).

### Optional: adopt `createScopedImplement`

If the app declares one superset handler context because different scopes inject
different fields, replace it with a scope map. This is additive — `createImplement`
still works.

```ts
// before — one context for every scope; `ctx.userId` is typed even in a
// `public` handler, where the runtime never injects it
interface AppContext extends RuntimeContext { userId: string; isAdmin: boolean }
export const implement = createImplement<AppContext>()

// after — each handler typed by its endpoint's effective scope
export const implementFor = createScopedImplement<{
  public: object
  user: { userId: string }
  admin: { userId: string; isAdmin: boolean }
}>()
```

`'public'` must be a key (a contract with no `scope` is `'public'`). Write
endpoints inline in the contract literal: an endpoint hoisted into a variable
widens its `scope` to `string` and is reported as undeclared.

## Released migration: 0.48.0

### Typed-client request options move to `.withOptions`

Generated endpoint methods reserve their ordinary call signature for contract
variables. This keeps them directly assignable to callback APIs whose runtime
supplies its own second context argument, including `react-query-kit` and
TanStack Query. Move imperative cancellation to the callable's explicit method:

```ts
// before — endpoint with arguments
await api.create({ name: 'Max' }, { signal })

// after
await api.create.withOptions({ name: 'Max' }, { signal })

// before — endpoint without arguments
await api.health({ signal })

// after
await api.health.withOptions({ signal })
```

Direct query and mutation composition remains unchanged:

```ts
createMutation({ mutationFn: api.create })
createQuery({ queryKey: ['search'], fetcher: api.search })
```

There is no positional-options alias. Ordinary generated methods ignore extra
runtime callback arguments; only `.withOptions` reads `ClientRequestOptions`.

## Released migration: 0.47.0

### HTTP auth moves to the pre-body `authorize` phase

Move the HTTP wiring of `createAuthHook` from `beforeHandle` to `authorize`.
This lets Stitchkit reject an unauthorized JSON or multipart request after path
parameter validation but before reading a body chunk. Keep application
preconditions that depend on validated input in `beforeHandle`.

```ts
const auth = createAuthHook({ authenticate, authorize })

// before
createServer({ services, hooks: { beforeHandle: auth } })

// after
createServer({ services, hooks: { authorize: auth } })
```

Tool transports already receive parsed input, so their wiring does not move:

```ts
createMcpHandler({ services, lifecycle: { beforeHandle: auth } })
```

If a custom HTTP authorization hook read `ctx.input`, `ctx.files` or raw body
state, split it: identity/scope checks belong in `authorize`; validated payload
preconditions belong in `beforeHandle` or the domain service.

### Multipart uses a typed descriptor and `ctx.files`

Replace every string multipart declaration, top-level `maxUploadBytes` and
`ctx.file`. The descriptor is now the only source of request, per-file,
cardinality and declared media-type policy.

```ts
// before
upload: {
  method: 'POST',
  path: '/',
  multipart: 'file',
  maxUploadBytes: 25 * 1024 * 1024,
}
upload: ({ file, input }) => store(file, input)

// after
upload: {
  method: 'POST',
  path: '/',
  multipart: {
    maxRequestBytes: 25 * 1024 * 1024,
    files: {
      file: {
        maxBytes: 20 * 1024 * 1024,
        contentTypes: ['image/*', 'application/pdf'],
      },
    },
  },
}
upload: ({ files, input }) => store(files.file, input)
```

Multiple files are repeated under one multipart field name and arrive in the
same order:

```ts
files: {
  attachments: { multiple: true, maxFiles: 8 },
}

await api.upload({ attachments: [firstFile, secondFile] })
// handler: files.attachments is File[]
```

For direct-to-storage delivery, set `delivery: 'stream'` and implement the
endpoint with `defineMultipartStream`. A receiver must consume its Web Stream
and return `{ value, cleanup }`; the final handler sees only receiver values.
There is no deprecated overload or buffered compatibility path under the old
contract shape.

## Worked example — frozen on 0.3, jumping to 0.7

1. `bun.lock` → consumer resolves `stitchkit@0.3.x`.
2. Target: `0.7.0`.
3. Scan CHANGELOG `### ⚠️ Breaking changes` for 0.4.0 … 0.7.0 → **none** (every
   release was additive — new exports, an extra hook argument, opt-in fields).
4. Nothing to migrate.
5. `bun add stitchkit@^0.7.0`, `bun install`.
6. `bun run check` green → runtime smoke → done. New surfaces
   (`STITCH_ERROR_STATUS`, `serveFile`, `scopePrefixes`, `afterToolCall`'s
   `MethodDef`, `maxUploadBytes`) are available to adopt, not required.

## Released migration: 0.44.0

### MCP TypeScript SDK v2 and protocol `2026-07-28`

This is a hard cut: there is one Stitchkit API and no v1 aliases. Applications
that expose MCP install the split server package; applications that implement an
MCP host or run client E2E install the split client package.

```bash
bun remove @modelcontextprotocol/sdk
bun add @modelcontextprotocol/server@^2 ai@^7
# MCP hosts and client-side E2E only:
bun add -d @modelcontextprotocol/client@^2
```

Direct SDK imports move to the split packages too:

```ts
// before
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// after
import { McpServer } from '@modelcontextprotocol/server'
```

MCP Apps additionally install `@modelcontextprotocol/ext-apps`. That adapter may
carry its own isolated v1-era transitive/peer relationship while the ecosystem
finishes its cutover; it does not permit application code to import the removed
monolithic SDK. Application-owned MCP server and client code uses the v2 split
packages exclusively.

```ts
// before
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpHandler } from 'stitchkit/tools'

const handleMcp = createMcpHandler({
  serverInfo,
  auth,
  services,
  sessionMode: 'stateless',
})
rawRoutes: [{ method: 'ALL', path: '/mcp', handler: handleMcp }]

// after
import { Client } from '@modelcontextprotocol/client'
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools'

const mcp = createMcpHandler({
  serverInfo,
  auth,
  services,
  legacy: 'serve',
})
rawRoutes: [createMcpHttpRoute({ path: '/mcp', handler: mcp })]
// graceful shutdown: await mcp.close()
```

Keep the owned handle and close it from the same shutdown path as the HTTP
server. A minimal runtime smoke should list tools before shutdown and prove the
closed handler no longer serves requests:

```ts
const mcp = createMcpHandler(config)
const route = createMcpHttpRoute({ path: '/mcp', handler: mcp })

const beforeClose = await route.handler(listToolsRequest)
if (!beforeClose.ok) throw new Error('MCP list-tools smoke failed')

await mcp.close()
```

Remove `@modelcontextprotocol/sdk`, `sessionMode`, `McpSessionMode`, session
stores and all `Mcp-Session-Id` handling. HTTP is always request-isolated and
stateless. `legacy: 'serve'` (default) lets the official SDK negotiate supported
pre-2026 stateless clients on the same endpoint; `legacy: 'reject'` makes it
modern-only. This is not a stateful compatibility transport.

#### Output shape depends on the negotiated protocol era

Stitchkit always validates the handler result against the declared output
schema. The negotiated MCP era determines only its wire representation:

| Negotiated era | Non-object `structuredContent` |
|---|---|
| MCP `2026-07-28` | the exact schema-valid JSON root: array, scalar or `null` |
| supported legacy era | the official SDK codec adapts it to `{ result: value }` |

Object roots keep their object shape in both eras. Do not change every consumer
expectation to the modern shape while `legacy: 'serve'` remains enabled. Pin
both protocol versions in the consumer's transport E2E and assert the boundary
explicitly:

```ts
await expectToolOutputForProtocol('2026-07-28', ['a', 'b'])
await expectToolOutputForProtocol('2025-11-25', { result: ['a', 'b'] })

async function expectToolOutputForProtocol(
  protocolVersion: '2026-07-28' | '2025-11-25',
  expected: unknown,
) {
  const client = await connectConsumerMcpClient({ protocolVersion })
  const result = await client.callTool({ name: 'list_notes', arguments: {} })
  expect(result.structuredContent).toEqual(expected)
  await client.close()
}
```

`connectConsumerMcpClient` represents the consumer's real HTTP or stdio setup;
configure its official client with `versionNegotiation.mode.pin` so the test
cannot silently negotiate a different era.

The stdio helper now returns an owned lifecycle handle:

```ts
// before
await createStdioMcpServer(config)

// after
const stdio = await createStdioMcpServer({ ...config, legacy: 'serve' })
await stdio.close()
```

OAuth client registration is now one explicit policy object. CIMD is secure and
enabled by default; DCR is disabled unless supplied:

```ts
// before
mountOAuthProvider({ ...oauth, clients, codes, refreshTokens })

// after
mountOAuthProvider({
  ...oauth,
  clientRegistration: {
    preRegistered: { get: clients.get },
    // optional: dcr: { register: clients.register, get: clients.get }
  },
  codes,
  refreshTokens,
})
```

A URL client id must be HTTPS and serve a document whose `client_id` exactly
matches that URL, with explicit `redirect_uris` and
`token_endpoint_auth_method: 'none'`. Do not keep a consumer-side metadata
fetcher or DCR fallback; Stitchkit owns SSRF-safe resolution and caching.

Multi-round input is opt-in on the operation and does not change Agent, CLI or
ordinary HTTP handlers:

```ts
const ConfirmationSchema = z.object({ confirmed: z.boolean() })

mcp: {
  inputRequired: [{
    key: 'confirmation',
    message: 'Confirm this action',
    schema: ConfirmationSchema,
  }],
}
```

Configure `multiRound.state` on the MCP server with a key of at least 32 bytes
and a stable authenticated `principal`. Read accepted typed content from
`ctx.mcpInput.confirmation`. Multiple declarations run in array order, the
aggregate remains exactly typed by key, keys must be unique, and declarations
must fit `multiRound.serving.maxRounds` (default `10`). Do not execute a
destructive side effect before the complete aggregate is accepted. A modern
request missing the declared elicitation capability receives JSON-RPC error
code `-32021`. The official per-request legacy HTTP bridge cannot issue
server-to-client elicitation, so it returns a deterministic failed tool result;
multi-round input is never silently treated as complete.

#### Compatibility matrix

| Host / transport | Tools and Apps | Multi-round input | Continuity |
|---|---|---|---|
| `2026-07-28` HTTP | yes | yes | request-isolated |
| supported legacy stateless HTTP | yes | unsupported result | request-isolated |
| `2026-07-28` stdio | yes | yes | one process connection |
| supported legacy stdio | yes | official SDK bridge | one process connection |
| Agent / CLI / ordinary HTTP | unchanged | not exposed | unchanged |

Subscriptions, cross-request progress and resumable stateful SSE are not
implemented or advertised.

#### Consumer checklist

1. Replace the monolithic SDK with `@modelcontextprotocol/server@^2` and, only
   for hosts/tests, `@modelcontextprotocol/client@^2`.
2. Replace raw MCP route wiring with `createMcpHttpRoute`; retain and close the
   returned handler/stdio handle during shutdown.
3. Delete all session mode, event-store and session-id code.
4. Move OAuth client policy under `clientRegistration`; publish CIMD or enable
   DCR explicitly.
5. Make `authorizeUser` return the exact consented scope subset. The framework
   validates that it is a subset of the request before saving the authorization
   code:

   ```ts
   // before
   authorizeUser: async () => ({ userId })

   // after
   authorizeUser: async (_req, request) => ({
     userId,
     approvedScopes: request.scope?.split(' ') ?? [],
   })
   ```

6. Snapshot `listToolNames`, run one contract tool, one runtime tool, any raw
   multimodal tool and every MCP App resource you use.
7. Exercise modern HTTP and stdio with protocol `2026-07-28`; exercise legacy
   only if `legacy: 'serve'` is part of your support policy.
8. Run the consumer's typecheck and runtime gates. A browser/HTTP-only consumer
   must continue to work without either MCP package.

## Historical breaking migrations through 0.44.0

HTTP observability now completes inside the framework handler instead of a
nested fetch wrapper. Configure request and tool sinks explicitly:

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

Body capture changed from always-on for body methods to opt-in. Set
`includePayload: true` only when the request sink needs the sanitized JSON body.
There is no `createAuditHook` or `audit.http` compatibility path;
`wrapInRequestContext` remains only for custom fetch pipelines.

Tool introspection now accepts one object-shaped contract/runtime surface. Stop
calling the internal contract collector or merging a locally converted runtime
manifest:

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

`ToolNameEntry` adds `kind: 'contract' | 'runtime'`. `TransportSummary` is now
`{ contractServices, runtimeTools, totals, sources }`; replace `services` and
`perService` reads with the explicit counts and mixed-source breakdown. There
is no positional overload and no `buildRuntimeToolManifest`: Stitchkit owns the
combined order, transport filtering, canonical presentation schema and
cross-origin collision checks.

`defineErrors` now uses one Zod-first definition object and returns constructors
instead of positional throwers. Add explicit `throw`, move message/details/hint
into one options object, and declare a details schema when that code carries
structured context:

```ts
// before
const { errors } = defineErrors({ QUOTA_EXCEEDED: 429 })
errors.QUOTA_EXCEEDED('Try later', { retryAfterSeconds: 30 }, 'Wait')

// after
const { errors, definitions } = defineErrors({
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

There is no positional overload. A code without `details` forbids them; use an
optional object schema when the details object itself is optional. Read status
and schemas from the frozen `definitions` registry instead of maintaining a
parallel map.

Managed MCP runtime tools are now declared as immutable data. Move protected
registrar calls to `runtimeTools`; rename deliberate raw SDK registration to
`rawTools`. There is no registrar alias:

```ts
// before — protected
createMcpHandler({
  services,
  nativeTools: ({ registerTool }) => registerTool(preview),
})

// after — protected and prepared with the rest of the surface
createMcpHandler({ services, runtimeTools: [preview] })

// before — deliberate raw SDK opt-out
nativeTools: ({ rawServer }, auth) => mountRaw(rawServer, auth)

// after — still a deliberate raw SDK opt-out
rawTools: (server, auth) => mountRaw(server, auth)
```

When identity selects from a bounded set, replace a repeatedly prepared
`services(auth)` factory with a finite registry:

```ts
createMcpHandler({
  surfaces: {
    admin: { services: allServices, runtimeTools: [preview] },
    member: { services: memberServices, runtimeTools: [preview] },
  },
  selectSurface: (auth) => auth.isAdmin ? 'admin' : 'member',
})
```

Keep direct `services(auth)` / `runtimeTools(auth)` only for genuinely
unbounded definitions; Stitchkit intentionally does not cache arbitrary auth
values.

Contract success bodies are now determined by the presence of `output`, not by
the handler's runtime value. A nullable output returns JSON `null` with status
`200`; `undefined` with a declared output and non-null data without an output
schema are contract violations:

```ts
// nullable JSON data: 200 with body `null`
session: {
  method: 'GET', path: '/session', desc: 'Current session',
  output: SessionSchema.nullable(),
}

// bodyless operation: 204 with no body
logout: {
  method: 'POST', path: '/logout', desc: 'End the session',
}
```

Add an output schema to every handler that returns data. Omit `output` and
return nothing for bodyless operations; runtime tools follow the same rule and
type no-output handlers as `void`.

`createToolInvoker` now separates immutable registry preparation from per-call
runtime state. Move source/context/lifecycle/hooks/output-strip reporting from
the factory config to the third invocation argument. Use `invokeOrThrow` when a
nested operation should preserve the normalized `AppError` instead of returning
a model-facing failure envelope:

```ts
// before
const invoker = createToolInvoker(services, {
  transport: 'AGENT', context: { identity }, lifecycle, hooks,
})
const result = await invoker.invoke(name, args)

// after
const invoker = createToolInvoker(services, { transport: 'AGENT' })
const result = await invoker.invoke(name, args, {
  context: { identity }, lifecycle, hooks,
})
const data = await invoker.invokeOrThrow(name, args, {
  context: { identity }, lifecycle, hooks,
})
```

There is no static runtime-config overload: request identity must not be retained
by a reusable compiled registry.

Entity cache handlers now require the cached list shape and CRUD policies. Move
`listKey` under `list`, make detail keys event-aware, and state the list-item
identity/projection explicitly:

```ts
// before
createEntityCacheHandlers<Entity>({
  getId,
  listKey: ['entities'],
  detailKey: (id) => ['entities', id],
})

// after
createEntityCacheHandlers<Entity, EntityListItem>({
  getId,
  getListItemId: (item) => item.id,
  toListItem: (entity) => ({ id: entity.id, name: entity.name }),
  list: {
    key: ['entities'],
    shape: 'paginated',
    createAt: 'start',
    updateMissing: 'skip',
  },
  detailKey: (event) => ['entities', event.id],
})
```

Choose `array`, `paginated`, `infinite-array` or `infinite-paginated` to match
the actual cached data. A dynamic `list.key` / `detailKey` receives a
discriminated event and can derive scoped keys from the created/updated entity
or deleted payload. Add `compare` only when the backend has a canonical order;
the framework does not guess it or mutate pagination metadata.

Protected native MCP operations now use the transport-neutral runtime tool
definition. Return the schema-owned value from the handler and move MCP content
or metadata into `present.mcp`; `structuredContent` and `isError` are
framework-owned:

```ts
// before
registerTool({ input, output, handler: async () => ({
  content: [{ type: 'image', data, mimeType: 'image/png' }],
  structuredContent: { assetId },
}) })

// after
const preview = defineRuntimeTool({
  name: 'render_preview', description, identity, input, output,
  handler: async () => ({ assetId, data }),
  present: {
    mcp: (result) => ({
      content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
    }),
  },
})
runtimeTools: [preview]
```

The removed `NativeMcp*` types have no aliases. Use `RuntimeToolDefinition`,
`RuntimeToolIdentity`, `RuntimeToolHandlerContext` and
`RuntimeMcpPresentation`. The same definition can now be passed to
`mountAgent(services, { runtimeTools: [preview] })`; add `present.agent` only
when the model needs rich text/file content instead of the neutral JSON result.

Trailing wildcards must be named consistently across the path and params schema:

```ts
// before
path: '/app/:slug/*'
params: z.object({ slug: z.string(), '*': z.string() })
ctx.params['*']
api.app({ slug: 'foo', '*': 'a/b' })

// after
path: '/app/:slug/*filePath'
params: z.object({ slug: z.string(), filePath: z.string() })
ctx.params.filePath
api.app({ slug: 'foo', filePath: 'a/b' })
```

Bare wildcards have no compatibility alias; raw routes use the same named form.

### Expected-401 matchers

`HttpClientConfig.authEndpoints` is removed. Replace manual path prefixes with
the operations whose 401 response is expected:

```ts
// before
createHttpClient({ baseUrl, authEndpoints: ['/api/auth/'] })

// after
createHttpClient({
  baseUrl,
  suppressUnauthorizedFor: contractEndpointMatchers(authContract, ['login', 'verify']),
})
```

There is no implicit `/auth/` suppression. Omit `suppressUnauthorizedFor` when
every 401 should emit the global `unauthorized` event.

## The 0.37 migration

Tool presentation is no longer an executable Zod parser. Replace the removed
flatten helpers with the JSON Schema compiler, and choose the explicit
`MountableTool` surface when using the advanced collection API:

```ts
// before
const flat = flattenUnionsDeep(zodSchema)
mountable.schema

// after
const flat = flattenToolJsonSchema(
  z.toJSONSchema(zodSchema, { target: 'draft-07', io: 'input' }),
)
mountable.presentationSchema // model/MCP/manifest JSON Schema
mountable.argumentSchema     // executable CLI argument adapter only
```

Contract and native handlers keep their original Zod schemas; MCP and agent SDK
adapters now forward raw arguments so defaults, coercions, refinements and
transforms execute exactly once inside Stitchkit. There are no compatibility
exports for `flattenDiscriminatedUnion`, `flattenUnionsDeep` or
`MountableTool.schema`. → ADR 0050

Tool-call hooks now take one options object. Migrate all three callbacks; there
are no positional overloads:

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

### MCP schema validation

The standalone validator now takes one object and live MCP configs carry the
same rules under `schemaValidation`. Migrate every positional call and every
`onIncompatibleSchema` field; there is no old-shape overload:

```ts
// before
validateMcpSchemas(services, 'throw', logger, { requireTypedProperties: true })
createMcpHandler({ services, onIncompatibleSchema: 'throw' })

// after
validateMcpSchemas({ services, policy: 'throw', logger, requireTypedProperties: true })
createMcpHandler({ services, schemaValidation: { policy: 'throw' } })
```

Put `extend` and `flattenUnionInput` beside `services`, not inside
`schemaValidation`. The handler applies the profile to the exact prepared schema
it advertises. Add `requirePortableFormats: true` when every custom JSON Schema
format must be rejected before a client sees it.

Native MCP registration also changed shape in 0.37. Move protected tools to the
framework registrar; keep an SDK-raw tool only by naming the opt-out:

```ts
// before
nativeTools: (server, auth) => server.registerTool(name, config, handler)

// after — lifecycle, hooks and schema policy apply
nativeTools: ({ registerTool }, auth) => registerTool({
  name, description, identity, input, output, handler,
})

// after — intentionally raw
nativeTools: ({ rawServer }, auth) => rawServer.registerTool(name, config, handler)
```

If a tool hook annotated `endpoint` as `MethodDef`, remove that annotation or
use `OperationIdentity`: native operations have service/action/scope/method but
no HTTP path.

### Node-facing server types

`stitchkit/server` remains Bun-concrete: an explicitly annotated `RawRoute`
still receives `BunServer`. `stitchkit/node` no longer drags Bun declarations
into a Node project. Its raw routes default the host server to `unknown`, and
its Socket.IO handle exposes only Node capabilities:

```ts
// before — Node entry still leaked Bun-only fields and ambient types
const route: RawRoute = { handler: (_req, ctx) => ctx.server?.upgrade(...) }
const socket = await createSocketIOServer(config)
socket.websocket

// after — name a custom embedding host only when one exists
const route: RawRoute<MyHostServer> = {
  handler: (_req, ctx) => useHost(ctx.server),
}
const socket = await createSocketIOServer(config)
socket.io
socket.attach(nodeHttpServer)
```

Node consumers can remove `@types/bun` unless another dependency independently
requires it.

### Managed server shutdown

`createServer()` and `serveNode()` now return the same structural managed
lifecycle. Replace every direct runtime stop and parallel Socket.IO close:

```ts
// before — split ownership
const socket = await createSocketIOServer(config)
const server = createServer({
  services,
  websocket: socket.websocket,
  rawRoutes: [socket.route],
})
server.stop()
await socket.io.close()

// after — one owner and one total deadline
const socket = await createSocketIOServer(config)
const server = createServer({ services, socket })
const result = await server.shutdown({ gracePeriodMs: 30_000 })
```

On Node, keep the same `socket` field and replace `handle.close()` with
`handle.shutdown()`. Runtime-specific diagnostics move under `handle.runtime`;
do not use it as a second shutdown path. Standalone CLI/tools that create a
Socket.IO handle without an HTTP server call `await socket.close()`.

If Bun Socket.IO shares the port with a raw lane, keep the explicit composition
but let the server mount the Socket.IO route:

```ts
createServer({
  services,
  socket,
  websocket: composeWebSocketHandlers([
    webSocketLane({ match: isRaw, handlers: rawHandlers }),
    socketIoLane(socket.websocket),
  ]),
  rawRoutes: [rawUpgradeRoute],
})
```

Move native Bun `routes` entries to `rawRoutes`. Native routes run before the
Fetch handler and therefore cannot participate in admission or drain. Wire
`SIGTERM`/`SIGINT` in the application; the first signal starts `shutdown()`, and
a later signal may abort the same controller. Close MCP, databases and queues
after the server result—those resources remain application-owned.

Move a handshake policy from the Node-only callback shape inside
`serverOptions` to the runtime-neutral top-level policy. It receives a Web
`Request`, may be async, and returns whether to admit the handshake:

```ts
// before
serverOptions: { allowRequest: (request, done) => done(null, allowed(request)) }

// after
allowRequest: (request) => allowed(request)
```

## Your handlers may be returning more than the contract declares

stitchkit validates every handler's return value against the endpoint's `output`
schema and **passes on the parsed result** — so any field the schema does not
declare is silently removed. That is deliberate (the contract is the published
shape of the response), but when you are moving a *live* API onto stitchkit it is
invisible: TypeScript does not reject excess properties, nothing logs it, and the
client just receives fewer fields.

While migrating, turn the diagnostic on:

```ts
createServer({ services, warnOnOutputStrip: true })   // off by default
```

Every removed key is logged as a dot-path with the endpoint that produced it
(`notes.get: secret, nested.alsoSecret`). Tool transports strip identically —
`mountMcp` / `mountAgent` take `onOutputStrip: (toolName, paths) => …`. Read the
list, then either widen the contract or stop returning the field, and turn the
flag back off: it is for the migration window, not for production.

## Tool names may shift between versions

Derived tool names are part of your public surface — an MCP client config or an
agent prompt refers to them by string. Before and after any upgrade that touches
name derivation, diff them mechanically:

```ts
import { listToolNames } from 'stitchkit/tools'
console.log(JSON.stringify(listToolNames({ services, runtimeTools }), null, 2))
```

`listToolNames` never throws on an illegal name — that is deliberate, so it can
show you the offending row when a mount would refuse it. Pin it in a snapshot
test and a shift fails your build instead of your clients.

## When you author a breaking change in stitchkit

You are on the other side of this flow — see
[`AGENTS.md` → Breaking changes & migration](../../AGENTS.md). In short: it is
allowed; write the `### ⚠️ Breaking changes` block with a before → after snippet,
bump the minor (pre-1.0), and migrate the controlled consumers in the same pass.
