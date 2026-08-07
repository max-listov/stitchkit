---
title: "ADR 0052 — Typed JSON response metadata"
description: Allow an HTTP-only typed-data endpoint to declare a success status and append safe response headers without owning the Response.
type: decision
status: accepted
created: 2026-08-07
updated: 2026-08-07
---

# ADR 0052 — Typed JSON response metadata

- **Status:** Accepted — a controlled HTTP-only extension of
  [ADR 0027](0027-transport-neutral-contract-execution.md), distinct from the
  raw-response exception in [ADR 0038](0038-raw-response-endpoints.md)
- **Date:** 2026-08-07

## Context

A typed JSON endpoint sometimes needs dynamic HTTP metadata alongside its data.
The concrete case is an authentication completion operation that returns a
schema-validated user while appending one or more `Set-Cookie` headers. The
framework owns JSON serialization, so the handler cannot attach those headers.

Using `rawResponse: true` is not equivalent. It changes the client result to
`Response`, skips `afterHandle` and output validation, and makes the handler
parse and serialize JSON manually. ADR 0038 reserves that ownership transfer for
operations whose response object is the operation: streams, files, ranges and
redirects.

## Decision

Add a required `responseMeta` discriminant for an HTTP-only typed-data endpoint:

```ts
complete: {
  method: 'POST',
  path: '/complete',
  desc: 'Complete authentication',
  input: CompleteAuthSchema,
  output: AuthUserSchema,
  responseMeta: { status: 200 },
}
```

Its handler still returns ordinary data. Only this endpoint class receives a
required outbound collector:

```ts
complete: async ({ input, response }) => {
  const result = await authenticate(input.token)
  response.headers.append('Set-Cookie', sessionCookie.set(result.sessionId))
  return result.user
}
```

The framework creates a fresh collector per request. It runs the ordinary
handler, group/global `afterHandle` hooks and final output validation first, then
serializes the validated data and merges the collected headers. A failure at any
earlier point discards the collector, so an error cannot inherit a success
cookie.

`responseMeta.status` is a static declared successful HTTP status. Known 2xx
codes are supported. Data endpoints cannot declare bodyless `204` or `205`;
empty endpoints may. Without an explicit status, existing behavior remains:
`200` whenever the endpoint declares `output`, and `204` when it does not.
OpenAPI publishes the same code. A nullable output serializes `null` as a JSON
body; runtime values never change the response kind declared by the contract.

`undefined` is not a JSON value and therefore violates a declared output even
when a broad schema would accept it. Conversely, a handler with no output may
return only `undefined`/`null`; returning data that the contract does not publish
is a server fault. This invariant is shared with tool execution, independently
of HTTP status framing.

The collector is a Web Fetch `Headers` bag. Repeated `Set-Cookie` values are
copied individually. Framework-owned headers are protected:
`Content-Type`, `Content-Length`, every `Access-Control-*` header and
`x-request-id`. Supplying one fails with the endpoint identity; the framework
never silently picks a winner.

The endpoint is forced to `expose: ['HTTP']`. `rawResponse`, tool names, MCP UI
or annotations, and non-HTTP exposure are invalid. The typed client still
resolves to parsed output data. `rawResponse: true` remains the sole surface for
streams, bytes, redirects and handler-owned responses.

## Alternatives rejected

- **Return `Response`.** This discards typed-data semantics and duplicates JSON
  parsing/validation; ADR 0038 intentionally gives it different lifecycle and
  client behavior.
- **Return `{ data, headers, status }`.** The envelope would either leak into
  MCP/agent/CLI output or require every transport to understand HTTP metadata.
- **Expose an optional no-op collector on every context.** A tool call has no
  response headers. Pretending otherwise weakens `HandlerContext` and hides a
  transport mistake.
- **Allow a dynamic per-call status.** OpenAPI and clients could not know the
  response contract. Multiple success shapes need an explicit future
  multi-response model, not an untyped integer setter.
- **Add a cookie-specific API.** Cookies are one legal header use case; session,
  parsing and policy remain application concerns. The generic Fetch `Headers`
  primitive is sufficient.

## Consequences

- Typed authentication and similar HTTP endpoints can emit dynamic headers
  without becoming raw endpoints or double-parsing output.
- This is an explicit second HTTP-only endpoint class, so ADR 0027's normal
  transport neutrality remains the default rather than being silently diluted.
- Lifecycle hooks continue to transform data only. They do not receive or return
  an HTTP envelope.
- A remote implementation can preserve the endpoint's HTTP-only exposure and
  declared status, but dynamic origin response headers are not relayed by its
  typed-data client call. Consumers that need transparent header proxying require
  a raw response operation instead.
