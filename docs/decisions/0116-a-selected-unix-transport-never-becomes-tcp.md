---
title: "ADR 0116: A selected Unix transport never becomes TCP"
description: "Unix client routing is an explicit owned Fetch transport on Bun and Node; redirects, failures and unsupported legacy configuration cannot fall back to TCP."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0116 — A selected Unix transport never becomes TCP

## Context

`createHttpClient({ unix })` passed a Bun-specific option into `fetch`. On Bun
that selected a socket file; elsewhere the option was not a portable Fetch
contract and the same call could reach `baseUrl` over TCP. A deployment boundary
must not depend on a runtime silently understanding an extension.

The transport also owns work after response headers arrive. Bounding only the
JSON parser leaves unread response bytes, open sockets and ambiguous delivery
outside the abstraction.

## Decision

`createUnixClientTransport({ socketPath })` is the explicit Fetch-compatible
adapter exported by `stitchkit/server` and `stitchkit/node`. The typed client uses
it through the existing `HttpClientConfig.fetch` seam:

```ts
const transport = createUnixClientTransport({ socketPath: '/run/worker.sock' })
const http = createHttpClient({ baseUrl: 'http://worker', fetch: transport.fetch })
```

The path is absolute, every redirect remains on that path, requests and
responses have byte ceilings, response headers have time and byte ceilings,
connections are finite, and `close()` owns active work. Failures report whether
dispatch did not begin, may have begun, or a response was received; the adapter
never guesses that an ambiguous operation is replay-safe.

The legacy `unix` option remains Bun-only for source compatibility. Selecting it
on another runtime now refuses before dispatch instead of using TCP, and it is
mutually exclusive with an injected `fetch`.

## Consequences

- One typed-client path works on Bun and Node without importing runtime code into
  the browser entrypoint.
- A missing socket, redirect, timeout or close cannot cross the declared
  transport boundary.
- Applications own retry policy. Delivery uncertainty is data, not an implicit
  retry or fallback.
- The adapter is process-local plumbing; it does not discover sockets, start a
  daemon or authenticate callers.
