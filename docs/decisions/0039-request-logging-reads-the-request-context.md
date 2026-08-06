---
title: "ADR 0039 — Request logging reads the request context"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0039 — Request logging reads the request context

- **Status:** Accepted — connects the logger of
  [ADR 0012](0012-observability-module.md) to the context that ADR introduced;
  upholds [ADR 0013](0013-runtime-agnostic-core.md) and
  [ADR 0029](0029-audit-endpoint-identity-and-dimensions.md)
- **Date:** 2026-08-06

## Context

A consuming project asked why its request log carried no user-agent, and
concluded that the framework's logger and its observability module were "two
disconnected worlds": `logging: true` prints a fixed field set, a custom
`StitchLogger` receives that same fixed set and never the `Request`, and
`createAuditHook` — which normalises everything into a rich `RequestEvent` —
writes to its own sink. Their proposal was to rebuild the logger on top of
`RequestEvent`.

Reading the code, the premise is wrong in a way that matters. The two worlds are
already joined: `createHandler` imports `setRequestEndpoint` and writes the
matched operation into the `AsyncLocalStorage` context on every request, before
validation. That context already carries `userAgent`, `ipAddress`, `userId`,
`dimensions`, `error`, trace ids and timing. The logger stands over it, inside
the same dispatch, and simply never reads it.

Validating the plan turned up four defects that shaped the outcome more than the
original request did:

1. `DEFAULT_CORS_EXPOSE_HEADERS` advertised `X-Trace-Id`, which nothing ever
   sets. The header responses actually carry, `x-request-id`, was not exposed —
   so a browser client could not read the trace id at all.
2. `traceId: getTraceId`, documented in three places as the way to make router
   and application logs share an id, does not typecheck: the option demanded
   `string`, `getTraceId` returns `string | undefined`.
3. A throwing sink escaped the request. In the error path `logDone` ran inside a
   `try` whose `catch` exists for a broken `onError`, so the throw was swallowed
   and then re-thrown, uncaught, by the fallback call. Separately, a result
   `Response.json` cannot serialise produced both a `200` line and a `500` line
   for one request.
4. `createServer` and `serveNode` construct their own `fetch` and expose no
   seam, so neither `wrapInRequestContext` nor `createAuditHook` could be
   composed by anyone using them — the README path could not reach the
   observability layer at all.

## Decision

**Two consumers over one `RequestContext`, not a logger over `RequestEvent`.**
When a context is active the completion line merges `userId`, `serviceName`,
`action` and `dimensions` from it; when none is, the lookup returns `undefined`
and nothing changes. `dimensions` is nested rather than spread — it is an
app-defined bag (ADR 0029) and a tenant key named `path` must not collide with a
framework field.

These fields reach the **structured** output only — the production JSON line and
a custom `logger`'s `data`. The development pretty line is a line to read, not a
record to query, and carries neither them nor `enrich`'s.

**`logging` becomes a configuration object.** `logging?: boolean | LoggingConfig`
with `logger`, `skip` and `enrich`. `true` is shorthand for `{}`: any object
turns logging on, `logger` decides which sink writes, and `skip` / `enrich`
apply to whichever is active. `skip` is consulted after the built-in filter, so
it can only quieten more. `enrich` runs once, at close, receives the outcome,
and is merged *under* the framework's fields.

**A mis-migrated logger is refused, not accepted.** Every `LoggingConfig` field
is optional, so a `StitchLogger` is structurally a valid config. TypeScript's
weak-type detection rejects the common case, but a logger typed `any` or
carrying an index signature slips through and would mean "a config with no
logger" — the app boots having silently stopped logging. `createHandler` throws
with the migration line instead. This is not a compatibility shim: it accepts
nothing, it only fails loudly.

**`wrapFetch` on the server configs** is the composition seam, shared by
`createServer` and `serveNode` through a `FetchComposition` interface. It is
deliberately not a `requestContext: boolean` flag: the context must be
*outermost*, and a flag that made `createHandler` establish it internally would
put an externally composed audit wrapper outside the context, breaking the
documented order. It sits on the server configs rather than `HandlerConfig`
because only those two own a `fetch` the consumer cannot otherwise reach — a
bare `createHandler` consumer already wraps the handler it is handed, and giving
it a second way to do the same thing would be two paths for one job.

**One canonical response header.** `X-Request-Id` is exposed; `X-Trace-Id` is
removed from the expose list and stays inbound-only, where `resolveTraceId`
reads it. No alias: two headers carrying one value is two things for every proxy
config and every reader to know about.

## Consequences

- A consumer gets identity on the request line for free once a context is
  wired, and everything else through one `enrich` — including the user-agent
  that prompted the report.
- `logging: myLogger` breaks. The migration is mechanical
  (`logging: { logger: myLogger }`), loud at compile time in the common case,
  and loud at boot in the uncommon one.
- The `x-request-id` / nginx recipe in the guide is honest about its gaps: Bun's
  native `routes`, a throwing `onRequest` and immutable response headers bypass
  the stamp, so the documented `map` falls back to `$request_id`.
- `ToolCallRecord` gains `traceId`, so a tool call logged inside an HTTP request
  can be joined to it. The rest of the tool surface — `skip`, `enrich`, a shared
  field builder — is **out of scope**: `createToolLogger` is a preset over a
  hook, not a second request pipeline, and giving it the HTTP logger's
  configuration would be inventing a surface nobody asked for.

## Alternatives considered

- **Build the logger on `RequestEvent`** (the original proposal). The audit
  `http` wrapper is composed outside `createHandler` and builds its event after
  the handler returns; the logger runs inside dispatch. Unifying them forces
  event construction into the always-on hot path — sanitising the payload,
  measuring `resultSize` and `responseBytes` on every request — for data the
  logger never prints. ADR 0022 deferred the same idea for the same reason.
- **Shape-sniffing the `logging` object** (`typeof x.info === 'function'`) to
  avoid the break. Rejected precisely because it avoids it: it keeps two
  accepted shapes alive indefinitely.
- **Dropping the `boolean` form.** `logging: {}` reads as "configured with
  nothing", not "on", and re-adding `enabled?: boolean` puts the boolean back
  inside the object.
- **Reshaping `StitchLogger` to take one structured event** instead of
  `(msg, data?)`. The interface serves three roles and two are not events — the
  startup shadowed-route warning and the output-strip diagnostic pass a bare
  string. A single-event interface would force a second interface for those.
- **Moving `warnOnOutputStrip` into `LoggingConfig`** while breaking anyway. It
  collides with `true ≡ {}`: today it works with `logging: false`, falling back
  to `console.warn`; inside the object, `logging: { warnOnOutputStrip: true }`
  would also switch request logging on, and "silence request logs, keep the
  diagnostic" would become unexpressible.
- **A `fields: ['userAgent']` option, and printing the user-agent by default.**
  Both rejected: once `enrich` exists the user-agent is one line of it, and a
  changed default output is a breaking change for the fattest field on a request
  line — one nobody has to have.
- **Letting `skip` un-skip a built-in prefix**, or sample one request in N.
  `/_bun/` assets are served by the runtime before `fetch` sees them, so
  un-skipping would be a promise the router cannot keep; sampling has no
  reported case.
- **A built-in `/health` route** (also requested). A route in no contract is
  invisible to the typed client and to the MCP and agent surfaces, and the
  framework would have to pick a path that can collide with a consumer's own.
  The symptom behind the request — monitoring hitting `/` and logging a 404
  every cycle — is what `skip` is for.
