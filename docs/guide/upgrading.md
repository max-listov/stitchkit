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

## Unreleased breaking migrations

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

### MCP HTTP sessions

Finally, replace the MCP HTTP session boolean. Omission changed meaning:

```ts
// before → after
stateless: true  // → sessionMode: 'stateless'
stateless: false // → sessionMode: 'stateful'

// before: omission was stateful
// after:  omission is stateless
```

If the client relies on `Mcp-Session-Id`, server push, progress across requests
or resumable SSE, set `sessionMode: 'stateful'` explicitly. Synchronous tool
servers should omit it and use the new restart-safe default.

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

Inline Bun routes passed to `createServer` continue to infer `BunServer`; no
annotation is needed. Node consumers can remove `@types/bun` unless another
dependency independently requires it.

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
