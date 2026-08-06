# Observability

A request reaches your app through one of two surfaces — an HTTP route or a
tool call (MCP / agent). Observability is the same question on both: *what
happened, how long did it take, who made it, did it fail.*

stitchkit answers this at two levels.

- **The raw hooks** — `LifecycleHooks` and `ToolCallHooks`. Every request and
  every tool call passes through a point you can observe. The lowest level;
  always available. [Jump ↓](#the-raw-hooks)
- **`stitchkit/observability`** — the audit layer built on those hooks: W3C
  trace context, an `AsyncLocalStorage` request context, payload sanitisation,
  and `createAuditHook` to wire it all into one sink. Your logging becomes a
  table plus a `write` function. [Start here ↓](#the-observability-module)

stitchkit still ships no logger and no audit store — those are the app's choice.
What it ships is the machinery that turns a completed call into a clean,
normalised record.

## The observability module

`stitchkit/observability` is server-only. It has three parts — a trace context,
a request context, and the audit hook — and you usually touch only the last.

### createAuditHook

`createAuditHook` is the whole module in one call. You give it a `write` sink;
it gives you back a wrapper for each surface. Every completed call — HTTP
request, MCP tool call, agent tool call — is normalised into one `RequestEvent`
and handed to `write`.

```ts
import { createAuditHook } from 'stitchkit/observability'

export const audit = createAuditHook({
  // The only thing the app supplies — persist one row.
  write: (event) => {
    db.auditLog.create({ data: {
      traceId:    event.traceId,
      source:     event.source,      // 'http' | 'mcp' | 'agent'
      method:     event.method,      // verb, or 'TOOL'
      path:       event.path,
      ok:         event.ok,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      userId:     event.userId,
      payload:    event.payload,     // already sanitised
    }})
  },
  // Optional — keep only the events you care about.
  filter: (event) => event.source !== 'http' || event.method !== 'GET',
})
```

It returns an [`AuditHook`](#audithook) — `{ http, toolCall }`:

```ts
// HTTP — wrap the fetch handler, inside wrapInRequestContext.
Bun.serve({ fetch: wrapInRequestContext(audit.http(handler)) })

// MCP & agents — pass as the tool-call hooks.
createMcpHandler({ /* … */ hooks: audit.toolCall })
mountAgent(service, { hooks: audit.toolCall })
```

One `createAuditHook`, one sink, every surface. The sink runs
fire-and-forget and its errors are swallowed — a slow or failing audit write
can never block or break the request it observes.

### RequestEvent

Every surface produces the same shape — so a single audit table stays
queryable across all three:

| Field | Notes |
|-------|-------|
| `source` | `http` \| `mcp` \| `agent` |
| `method` / `path` | the verb + path, or `TOOL` + `/{source}/{tool}` |
| `serviceName` / `action` | stable contract identity of the operation (→ ADR 0022) — from the contract, not parsed from `path`; set on every surface, present even on a pre-handler 400 |
| `toolName` | tool calls only |
| `httpMethod` | the contract verb on **tool** events (their `method` is `TOOL`) — filter reads vs writes across both surfaces with `(event.httpMethod ?? event.method) !== 'GET'` |
| `dimensions` | app-defined domain dimensions (tenant / project / entity id) — see [request context](#request-context) |
| `traceId` / `spanId` / `parentSpanId` | [W3C trace context](#trace-context) |
| `ok` / `statusCode` | outcome — real HTTP status, or `200`/`400` for a tool |
| `durationMs` / `startedAt` | timing |
| `errorCode` / `errorMessage` / `errorDetail` | failures only — `errorDetail` carries the structure the message flattens (e.g. Zod issues) |
| `payload` | the request body / tool arguments — sanitised |
| `resultSize` / `responseBytes` | result item count + serialised size |
| `userId` / `ipAddress` / `userAgent` | identity |

### Request context

`createAuditHook`'s `http` wrapper reads a request context — trace ids, timing,
identity — from `AsyncLocalStorage`. `wrapInRequestContext` establishes it, and
must be the **outermost** wrapper of your fetch handler:

```ts
import { getTraceId, wrapInRequestContext } from 'stitchkit/observability'

Bun.serve({
  fetch: wrapInRequestContext(audit.http(handler)),
})
```

`createServer` and `serveNode` build their own `fetch`, so compose through
**`wrapFetch`** instead — same order, the context outermost:

```ts
createServer({
  services,
  wrapFetch: (fetch) => wrapInRequestContext(audit.http(fetch)),
})
```

Some fields are filled in late. Set them from the hooks that know:

```ts
import {
  setRequestDimensions,
  setRequestError,
  setRequestUser,
} from 'stitchkit/observability'

createAuthHook({ /* … */ inject: (ctx, user) => user && setRequestUser(user.id) })
// in your onError hook:
setRequestError({ code: err.code, message: err.message, details: err.issues })
```

**Endpoint identity is automatic.** The framework writes the matched operation's
`(serviceName, action)` into the context at route-match, *before* validation — so
`event.serviceName` / `event.action` are present on every event, including a
pre-handler 400. Nothing to wire.

**Domain dimensions** — attach your own tenant / project / entity id with
`setRequestDimensions`. It is an opaque `Record<string, string>` the core gives no
meaning to (→ ADR 0021). Resolve it cheaply from `ctx.params` / headers in
`beforeHandle` (success) or `onError` (a pre-handler failure — `ctx.params` /
`ctx.req` are available there) and it lands on `event.dimensions` for the request
either way, so your sink reads it as a column instead of re-parsing the path:

```ts
// beforeHandle (success) and onError (failure) alike:
const projectId = ctx.req?.headers.get('x-project') ?? String(ctx.params?.projectId ?? '')
if (projectId) setRequestDimensions({ projectId })
```

Make the framework router share this trace id — so request logs and your
application logs carry one id — by passing `getTraceId` as the resolver:

```ts
createHandler({ /* … */ traceId: getTraceId })
```

`getTraceId` returns `undefined` outside an active context, and the framework
falls back to its own resolver — a trusted inbound `x-request-id` / `x-trace-id`,
else a fresh id — so the line never carries the string `"undefined"`.

`getRequestContext()` / `getTraceId()` then return the active values from
anywhere in the call — stamp `getTraceId()` onto every line your logger writes.
The **request log picks the context up on its own**: with a context active, each
completion line carries `userId`, `serviceName`, `action` and `dimensions`
without any configuration.

⚠️ In the **structured** output only — the production JSON line and a custom
`logger`'s `data`. The development `←` line is a line to read, not a record to
query, and never carries them (nor `enrich`'s fields). On `logging: true` in
development you will see no difference; check with `NODE_ENV=production` or a
custom `logger`.

### Correlating with a reverse proxy

Every response the stitchkit handler produces carries the resolved id as
**`x-request-id`**. With `cors` configured it is in the default
`Access-Control-Expose-Headers`, so a browser client can read it and quote it in
a bug report. Note the deliberate asymmetry: inbound the id may arrive as
`X-Trace-Id` *or* `X-Request-Id`; outbound there is one name and no alias.

Log the same id from nginx and the two logs join on one key. `log_format` and
`map` are `http {}`-context directives — put the block there, not inside
`server {}`:

```nginx
log_format  stitch  '$remote_addr $status $request_time rid=$rid "$request"';

# Fall back to nginx's own id for responses stitchkit never produced — Bun's
# native `routes`, a throwing `onRequest` (which escapes before any response
# exists), a redirect whose headers are immutable.
map $upstream_http_x_request_id $rid {
    ""      $request_id;
    default $upstream_http_x_request_id;
}

access_log /var/log/nginx/access.log stitch;
```

`grep rid=<id>` across both logs then reconstructs the whole request. Tool calls
join too: `createToolLogger`'s record carries `traceId`, so an MCP or agent call
made inside a request lines up with it.

### Trace context

stitchkit speaks [W3C Trace Context](https://www.w3.org/TR/trace-context/). An
inbound `traceparent` header is continued — its trace id is kept, its span
becomes the parent — so a trace spans the front-end call, your HTTP handler and
every tool call underneath it. With no inbound header a fresh root trace is
minted. Each tool call opens a [`childSpan`](#trace-context) of the request it
runs in.

You rarely call the trace functions directly — `wrapInRequestContext` and
`createAuditHook` use them for you. They are exported (`resolveTraceContext`,
`parseTraceparent`, `formatTraceparent`, `childSpan`) for when you need to
propagate a `traceparent` onward to another service.

The browser side starts the trace:
[`createHttpClient({ trace: true })`](./client.md#httpclientconfig) emits a
fresh root `traceparent` on every request, which the server then continues. The
trace helpers themselves are browser-safe and also exported from the root
`stitchkit` entry — a custom client can format its own header.

The default CORS allow-list already permits `traceparent` / `tracestate`, so a
cross-origin `trace: true` client works out of the box. If you set a custom
`cors.headers`, extend `DEFAULT_CORS_ALLOW_HEADERS` rather than replacing it, or
the preflight will reject the trace header.

> **Span ids live in the request context, not on `ctx`.** The handler `ctx`
> carries a single `traceId`; the full `{ traceId, spanId, parentSpanId }` is on
> the observability request context. To stamp `spanId` / `parentSpanId` into an
> audit row read `getRequestContext()?.trace`, not `ctx.spanId`:
>
> ```ts
> const trace = getRequestContext()?.trace
> audit({ traceId: trace?.traceId, spanId: trace?.spanId, parentSpanId: trace?.parentSpanId })
> ```

### Sanitisation

A payload goes into an audit row only after `sanitizePayload`:

- **secret-named keys are masked** — `password`, `token`, `apiKey`, `secret`,
  `authorization`, `cookie`, … (value → `[redacted]`);
- **binary blobs** (`Uint8Array`, `Blob`, `FormData`) collapse to metadata —
  never the bytes;
- the result is **capped** — anything over the byte limit becomes a preview.

`createAuditHook` runs it on every event; tune it through `sanitize`:

```ts
createAuditHook({
  write,
  sanitize: { maxBytes: 8_000, sensitiveKeys: /password|token|pin/i },
})
```

`redact`, `truncatePreview` and `measureSize` are exported on their own if you
need to sanitise something outside the audit path.

## The raw hooks

`createAuditHook` is built on hooks you can also use directly — for a one-off
metric, a custom log line, anything that is not a full audit row.

| Surface | Hook | Fires |
|---------|------|-------|
| HTTP | `LifecycleHooks.afterHandle` / `onError` | after each HTTP request |
| MCP & agent tools | `ToolCallHooks.afterToolCall` | after each tool call |

`afterHandle(ctx, result, endpoint)` runs after a handler returns;
`onError(ctx, error, endpoint)` when one throws. `afterToolCall(toolName, args,
result, durationMs, context)` runs after every tool call — success and error
alike — carrying the tool name, the arguments, the result, the duration and the
call context.

```ts
createMcpHandler({
  serverInfo, auth, services,
  hooks: {
    afterToolCall: (toolName, _args, result, durationMs, context) => {
      metrics.timing(`tool.${toolName}`, durationMs, { ok: String(result.ok) })
    },
  },
})
```

Log **after** completion — a record is of a *finished* call; you need the
outcome and the duration, neither of which exists before the handler runs.

### Keying a row on (service, action)

`createAuditHook` already keys every event by **service** and **action**
(`event.serviceName` / `event.action`, → ADR 0029) — reach for the raw hook only
when you also need the handler **output**, which the audit wrapper never sees. For
that, read the endpoint identity off the `MethodDef` the hook receives —
`endpoint.serviceName` (the contract prefix) and `endpoint.key` (the endpoint key,
e.g. `updatePartial`). They are stable and always present (→ ADR 0022); the action
is not in the URL and `toolName` is absent on HTTP-only endpoints, so this is the
only reliable pair. `afterHandle` also gives you the handler `result` — so it is
the home for a rich mutation audit that records output:

```ts
hooks: {
  afterHandle: (ctx, result, endpoint) => {
    void logMutation({
      service: endpoint.serviceName,
      action: endpoint.key,
      input: ctx.input,
      output: result,
      userId: ctx.userId,
      traceId: ctx.traceId,
    })
    return result   // don't transform
  },
}
```

> **Why the HTTP audit is a wrapper, not a lifecycle hook.** `LifecycleHooks`
> has a single `onError` — an audit built on it would compete with the app's own
> error handler. `createAuditHook`'s `http` wrapper sees the final `Response`
> instead, success and error alike, and never contends for a hook. The raw
> lifecycle hooks remain yours for everything else.

Keep any sink **asynchronous and self-contained**: a slow or failing write must
never block or break the request. Swallow the sink's own errors.
