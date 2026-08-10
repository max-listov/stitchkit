# Observability

A request reaches your app through one of two surfaces — an HTTP route or a
tool call (MCP / agent). Observability is the same question on both: *what
happened, how long did it take, who made it, did it fail.*

stitchkit answers this at two levels.

- **The raw hooks** — `LifecycleHooks` and `ToolCallHooks`. Every request and
  every tool call passes through a point you can observe. The lowest level;
  always available. [Jump ↓](#the-raw-hooks)
- **`stitchkit/observability`** — framework-owned HTTP completion plus canonical
  tool hooks: W3C trace context, an `AsyncLocalStorage` request context, payload
  sanitisation and `createObservability` with independent request/tool sinks.
  [Start here ↓](#the-observability-module)

stitchkit still ships no logger and no audit store — those are the app's choice.
What it ships is the machinery that turns a completed call into a clean,
normalised record.

## The observability module

`stitchkit/observability` is server-only. It has three parts — a trace context,
a request context, and event projections — and you usually touch only the last.

### createObservability

`createObservability` configures request and tool projections independently.
Every completed call is normalised into one `RequestEvent`; HTTP completion is
owned directly by `createHandler`, while MCP/Agent completion uses the canonical
`ToolCallHooks` runner. There is no nested HTTP audit wrapper.

```ts
import { createObservability } from 'stitchkit/observability'

const write = (event) => db.auditLog.create({ data: {
  traceId: event.traceId,
  source: event.source,
  method: event.method,
  path: event.path,
  ok: event.ok,
  statusCode: event.statusCode,
  durationMs: event.durationMs,
  userId: event.userId,
  payload: event.payload,
}})

export const observability = createObservability({
  request: {
    write,
    includePayload: false, // default: no Request.clone(), payload is null
    filter: (event) => event.method !== 'GET',
  },
  tools: {
    write,
    filter: (event) => event.source === 'mcp' || event.source === 'agent',
  },
})
```

Wire each projection where its completion is owned:

```ts
createServer({ services, observability: observability.request })

createMcpHandler({ /* … */ hooks: observability.toolCall })
mountAgent(service, { hooks: observability.toolCall })
```

Each sink runs fire-and-forget and fails independently: a slow or broken request
sink cannot block the response, suppress operational logging or break the tool
sink.

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
| `payload` | sanitised tool arguments; HTTP is `null` unless request `includePayload` is enabled |
| `resultSize` / `responseBytes` | result item count + serialised size |
| `userId` / `ipAddress` / `userAgent` | identity |

### Request context

When request observability is configured, `createHandler` establishes the
`AsyncLocalStorage` request context itself and uses the same completion snapshot
for operational logging and `RequestEvent`. No `wrapFetch` composition is
needed:

```ts
createServer({ services, logging, observability: observability.request })
```

`wrapInRequestContext` remains available for a custom fetch pipeline that does
not use `createHandler`; it is no longer part of built-in HTTP audit wiring:

```ts
Bun.serve({ fetch: wrapInRequestContext(customFetch) })
```

Some fields are filled in late. Set them from the hooks that know:

```ts
import {
  setRequestDimensions,
  setRequestError,
  setRequestUser,
} from 'stitchkit/observability'

createAuthHook({ /* … */ inject: (ctx, user) => user && setRequestUser(user.id) })
// ↑ on the HTTP path. Inside a tool call this writes to that call's own context
//   (→ ADR 0045); a tool row takes its identity from the mount's `context`.
// only to override what the framework already recorded — see below:
setRequestError({ code: err.code, message: err.message, details: err.issues })
```

**The failure is recorded for you.** Every error travels one path inside the
framework, and that path writes `{ code, message, details }` onto the context —
so an audited failure names its cause whether or not you wrote an `onError`, and
whether or not your `onError` returns its own `Response`. Where the envelope was
scrubbed to `INTERNAL_SERVER_ERROR`, the row gets the **real** message rather than
the placeholder; the caller still receives the scrubbed one. → ADR 0043

`setRequestError` is therefore an **override**, not the wiring: call it when you
want the row to say something other than what the framework derived (a domain
code, a curated message, structured issues). The framework writes only when the
context carries nothing yet, so your value always wins.

**Endpoint identity is automatic.** The framework writes the matched operation's
`(serviceName, action)` into the context at route-match, *before* validation — so
`event.serviceName` / `event.action` are present on every event, including a
pre-handler 400. Nothing to wire.

When failure attribution itself is asynchronous, use `createErrorHook`'s
`onError(error, info, ctx, endpoint)` observer. The framework awaits it before
calling `render`, so identity or audit enrichment is visible to both the final
error envelope and the request event. `endpoint` is the matched `MethodDef`, or
`undefined` when routing failed before a method was selected.

**Domain dimensions** — attach your own tenant / project / entity id with
`setRequestDimensions`. It is an opaque `Record<string, string>` the core gives no
meaning to (→ ADR 0021). Resolve it cheaply from `ctx.params` / headers in
`beforeHandle` (success) or `onError` (a pre-handler failure — `ctx.params` /
`ctx.req` are available there) and it lands on `event.dimensions` for the request
either way, so your sink reads it as a column instead of re-parsing the path:

> **On the tool path it lands on that call's own event, not the request's.** The
> same hooks object is assignable to `ToolLifecycle`, so this recipe is the one
> people apply to tools — and since ADR 0045 each tool call runs in its own
> context. Read the value off the tool row (`event.toolName != null`); both rows
> carry the same `traceId`, so recovering the enclosing request is one filter:
>
> ```bash
> jq -s '[.[] | select(.dimensions.botId == "B7") | .traceId] as $t
>        | .[] | select(.traceId | IN($t[]))' audit.jsonl
> ```
>
> Worth checking your **runbooks** as well as your code when this lands: a
> dimension filter written against request rows keeps parsing and starts
> returning nothing.

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

Inside a **tool call** the context is that call's own (→ ADR 0045), so the
enrichment a request log picks up describes the request, not the call.

`getRequestContext()` / `getTraceId()` then return the active values from
anywhere in the call — stamp `getTraceId()` onto every line your logger writes.
The **request log picks the context up on its own**: with a context active, each
completion line carries `userId`, `serviceName`, `action` and `dimensions`
without any configuration.

⚠️ In the **structured** output only — the `json` line and a custom `logger`'s
`data`. The `pretty` `←` line is a line to read, not a record to query, and
never carries them (nor `enrich`'s fields). Set
[`logging.format: 'json'`](./server.md#two-formats-and-who-chooses) to see them
locally; you do not need to change `NODE_ENV` or deploy.

### Correlating with a reverse proxy

Every response the stitchkit handler produces carries the resolved id as
**`x-request-id`**. With `cors` configured it is in the default
`Access-Control-Expose-Headers`, so a browser client can read it and quote it in
a bug report. Stitchkit browser clients retain it as `ApiError.traceId` on
response-backed failures. Note the deliberate asymmetry: inbound the id may arrive as
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

You rarely call the trace functions directly — `createHandler` request
observability and `wrapInRequestContext` use them for you. They are exported (`resolveTraceContext`,
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

MCP tools use the same context. On a modern HTTP or stdio `tools/call`, the
official SDK exposes W3C propagation values from request `_meta`; Stitchkit
continues a valid `_meta.traceparent` before validation, lifecycle and hooks.
If MCP metadata omits `traceparent`, an HTTP call keeps its ambient HTTP trace
and a stdio call starts a new root. If the key is present but malformed or
all-zero, the call still runs under a fresh local trace instead of trusting the
ambient one. This makes explicit MCP propagation authoritative without allowing
invalid input to break the tool.

Bounded `tracestate` and `baggage` are available through
`getRequestContext()?.trace` for outbound propagation. Their contents are not
copied into the standard `RequestEvent`; never use them for auth, RBAC, tenant
selection or rate-limit identity. Every MRTR attempt reads its current request
metadata, so callers that want one trace across rounds must propagate it on
each request.

> **Span ids live in the request context, not on `ctx`.** The handler `ctx`
> carries a single `traceId`; the full
> `{ traceId, spanId, parentSpanId, tracestate?, baggage? }` is on
> the observability request context. To stamp `spanId` / `parentSpanId` into an
> audit row read `getRequestContext()?.trace`, not `ctx.spanId`:
>
> ```ts
> const trace = getRequestContext()?.trace
> audit({ traceId: trace?.traceId, spanId: trace?.spanId, parentSpanId: trace?.parentSpanId })
> ```

### Sanitisation

A payload goes into an audit row only after `sanitizePayload`:

- **secret-named keys are masked** — a key whose words include a secret term is
  redacted (`password`, `sessionToken`, `X-Api-Key`, `authorization`, `cookie`,
  …), while identifiers that merely contain one (`authorId`, `sessionCount`,
  `tokenizer`) survive;
- **binary blobs** (`Uint8Array`, `Blob`, `FormData`) collapse to metadata —
  never the bytes;
- the result is **capped** — anything over the byte limit becomes a preview.

`createObservability` runs it on every emitted event; tune each sink separately:

```ts
createObservability({
  request: {
    write,
    includePayload: true,
    sanitize: { maxBytes: 8_000, sensitiveKeys: /password|token|pin/i },
  },
  tools: {
    write,
    sanitize: { maxBytes: 8_000, sensitiveKeys: /password|token|pin/i },
  },
})
```

`redact`, `truncatePreview` and `measureSize` are exported on their own if you
need to sanitise something outside the audit path.

## The raw hooks

Tool observability is built on hooks you can also use directly — for a one-off
metric, a custom log line, anything that is not a full audit row.

| Surface | Hook | Fires |
|---------|------|-------|
| HTTP | `LifecycleHooks.afterHandle` / `onError` | after each HTTP request |
| MCP & agent tools | `ToolCallHooks.afterToolCall` | after each tool call |
| MCP & agent tools | `ToolCallHooks.onToolError` | when executable parsing, extension resolution, lifecycle or the handler throws |

`afterHandle(ctx, result, endpoint)` runs after a handler returns;
`onError(ctx, error, endpoint)` when one throws. `afterToolCall(options)` runs
after every tool call —
success and error alike — carrying the tool name, the arguments, the result, the
duration, the call context, the endpoint identity, and (only when the call failed
by throwing) the raw thrown value.

```ts
createMcpHandler({
  serverInfo, auth, services,
  hooks: {
    afterToolCall: ({ toolName, result, durationMs }) => {
      metrics.timing(`tool.${toolName}`, durationMs, { ok: String(result.ok) })
    },
  },
})
```

Log **after** completion — a record is of a *finished* call; you need the
outcome and the duration, neither of which exists before the handler runs.

### The cause behind a failed tool call

`afterToolCall` gives you the `ToolResult`, and for a thrown `AppError` that is
the whole story — `code` and `details` are yours to route. For anything else it
is not: an unexpected throw (a dropped connection, a `TypeError`) is scrubbed to
a bare `INTERNAL_SERVER_ERROR` with the message `Internal server error`, because
a raw `Error.message` can carry a connection string or a file path. The result
your sink receives says nothing about why.

`onToolError` is where that value still exists — **as thrown**, before
normalisation, stack and `cause` intact:

```ts
createMcpHandler({
  serverInfo, auth, services,
  hooks: {
    onToolError: ({ toolName, error, endpoint }) => {
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

It fires for a throw from executable params/input/`ToolExtend` parsing,
extension resolution, `beforeHandle`, the handler or `afterHandle` — every span
where information is destroyed — and runs **before** `afterToolCall`. It does
not fire for an ordinary validation result, an output-schema mismatch or a
`beforeToolCall` rejection: each is already described in full by its
`ToolResult`.

It observes, it does not handle: the tool envelope is always the framework's, a
returned value is ignored, and a throw from the hook itself is reported to
`console.error` and swallowed rather than replacing the failure it was called to
observe. (This is also why it lives on `ToolCallHooks` rather than being an
`onError` twin on `ToolLifecycle` — `LifecycleHooks.onError` returns a
`Response`, which a tool call has no use for, and a whole `createServer` hooks
object must stay assignable to `ToolLifecycle`.)

**Do not reach for `setRequestError` here.** It writes to the *request* context,
which the built-in **tool** row does not read: a tool event takes
`errorCode` / `errorMessage` / `errorDetail` from the `ToolResult`, and only
identity and `dimensions` from the context. Calling it in `onToolError` would
leave the tool row exactly as scrubbed as before. It is right for the **HTTP**
path, where the request *is* the record. (Since ADR 0045 a tool call runs in its
own context, so it can no longer write into the enclosing `/mcp` request's row
either — the call is simply not where that helper belongs.)

### One row that names the cause

You do not need to correlate the two hooks yourself. `afterToolCall` receives the
same raw value as the named `error` field, so one hook can build one record:

```ts
hooks: {
  afterToolCall: ({ toolName, result, durationMs, endpoint, error }) => {
    void writeRow({ toolName, result, durationMs, cause: error, endpoint })
  },
}
```

`error` is present only when the call failed by **throwing** — a
validation failure or a `beforeToolCall` rejection leaves it `undefined`, because
neither ever had a raw value to lose. Consumers destructure only the fields they
use; future optional fields do not change callback arity.

`createObservability({ tools })` uses it already. Where the envelope was scrubbed to
`INTERNAL_SERVER_ERROR`, the row's `errorMessage` becomes the real message
instead of the placeholder; a truthful envelope (a thrown `AppError`, a
`ZodError`) is left alone, `errorCode` and `errorDetail` are untouched, and the
stack is not written — that is `onToolError`'s job, for a tracker that wants it.
The caller still receives the scrubbed envelope in every case: the raw text
reaches your server-side record, never the response. → ADR 0042

So the two hooks divide by **purpose**, not by capability — `onToolError` for a
sink of your own (a tracker, a stack, an alert), `afterToolCall` for the record.

### Keying a row on (service, action)

Built-in observability keys every event by **service** and **action**
(`event.serviceName` / `event.action`, → ADR 0029) — reach for the raw hook only
when you also need the handler **output**, which the audit wrapper never sees. For
that, read the endpoint identity off the `OperationIdentity` the tool hook
receives — `endpoint.serviceName` and `endpoint.key` (the endpoint key or native
action,
e.g. `updatePartial`). They are stable and always present (→ ADR 0022); the action
is not in the URL and `toolName` is absent on HTTP-only endpoints, so this is the
only reliable pair. Contract operations are full `MethodDef` values; native MCP
operations intentionally have no HTTP `path`. `afterHandle` also gives you the handler `result` — so it is
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

> **Why HTTP observability is framework-owned, not a lifecycle hook.**
> `LifecycleHooks` has a single `onError`; an audit built on it would compete
> with the app's error renderer and miss raw/unmatched exits. `createHandler`
> sees the final response on every path and emits one completion without
> consuming an application hook.

Keep any sink **asynchronous and self-contained**: a slow or failing write must
never block or break the request. Swallow the sink's own errors.
