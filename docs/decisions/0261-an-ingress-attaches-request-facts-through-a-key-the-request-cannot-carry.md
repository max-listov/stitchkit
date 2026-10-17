---
title: "ADR 0261: An ingress attaches request facts through a key the request cannot carry"
description: "A typed key attaches a value to the Request an ingress builds; the endpoint reads it from its context, and the context's request is the very one the handler received."
type: decision
status: accepted
created: 2026-10-17 12:07 +07:00
updated: 2026-10-17 12:07 +07:00
---

# ADR 0261 — An ingress attaches request facts through a key the request cannot carry

**Invariants:** I3, I6, I8, I12, I13.

## Context

Code that builds a `Request` and calls the fetch handler of the core — a local socket
ingress, a relay, a test harness — often knows something about the caller that must
reach an endpoint: who the authenticated peer is, which node sent it. Putting it in a
header lets any other client forge it. Keeping it in a side table keyed by the
`Request` works only while the core hands the endpoint that same object, and nothing
promised that. A later change that wraps or copies the request would make the value
vanish for every application at once, silently.

## Decision

`defineRequestIngress<T>(name)` returns a key with `attach(request, value)` and
`from(source)`. The values live in a `WeakMap<Request, T>` owned by the key, so the
key is the only way in and the only way out: a header, a body, `clone()` and
`new Request(request)` are other channels or other objects and carry nothing, and two
keys never meet even under one name. A second `attach` to the same request is refused.
`from` takes anything with a `req`, so a handler, `authorize`, `beforeHandle` and
`onError` all read it from their `ctx`.

The guarantee that makes the lookup sound is written down and tested: on every HTTP
context, `ctx.req` is the `Request` the handler of the core received. It holds for an
endpoint, for the hooks, and for the error contexts of an unknown path, a refused
method, a validation failure and a refusing `onRequest`. A change that breaks it
fails the ingress tests.

No field is added to `RuntimeContext` or `HandlerContext`, so there is no new reserved
key and no cast between the two. The key is owned by `stitchkit/server`, mirrored by
`stitchkit/node`.

## Consequences

An ingress owner attaches before handing the request over and an endpoint reads with
the same key; two installed copies of the framework do not matter, because the key
object is shared and the table is per request. A raw route, `streamingRoute` and
`onRequest` receive `(req, …)` without a context and read with `from({ req })`; the
MCP, agent and CLI lanes carry no `Request`. `proxyOrigin` normalizes before
`wrapFetch`, so a value attached in `wrapFetch` belongs to the final request.
