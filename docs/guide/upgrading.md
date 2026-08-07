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
console.log(JSON.stringify(listToolNames(services), null, 2))
```

`listToolNames` never throws on an illegal name — that is deliberate, so it can
show you the offending row when a mount would refuse it. Pin it in a snapshot
test and a shift fails your build instead of your clients.

## When you author a breaking change in stitchkit

You are on the other side of this flow — see
[`AGENTS.md` → Breaking changes & migration](../../AGENTS.md). In short: it is
allowed; write the `### ⚠️ Breaking changes` block with a before → after snippet,
bump the minor (pre-1.0), and migrate the controlled consumers in the same pass.
