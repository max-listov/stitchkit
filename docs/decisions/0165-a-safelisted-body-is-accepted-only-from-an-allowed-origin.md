---
title: A safelisted body is accepted only from an allowed origin
description: A JSON body under text/plain is the one thing a dying document can still send to another origin, and the one thing any site can send with the user's cookies. An endpoint may opt into the first only under a server-side Origin check that refuses the second.
type: decision
status: active
created: 2026-09-06
updated: 2026-09-06
---

# 0165 — A safelisted body is accepted only from an allowed origin

## Decision

An endpoint may declare `safelistedBody: true`. It then accepts its JSON body
under `text/plain` as well as `application/json` — same parser, same `input`
schema, same `maxJsonBodyBytes`. The server honours that declaration **only**
for a request whose `Origin` header names a site on its explicit `cors.origin`
allow-list. A wildcard is not an allow-list, `null` is not a site, and a
missing header is not an answer: each is refused with `403` before the text is
parsed. `application/json` is untouched by the check. The flag is `POST`-only
and transport-neutral.

## Why the default refuses `text/plain`

`parseJsonBody` has always required `application/json`, and the comment beside
it says why: a `text/plain` body is a *simple* request. The browser sends a
simple request immediately — with cookies — and consults CORS only about
whether the page may *read* the response. A form on any site can therefore
post a `text/plain` body to a cookie-authenticated endpoint, and the server has
already acted by the time the browser says no. Requiring `application/json`
forces a preflight, and the preflight is where a foreign site is stopped.

## Why an endpoint needs the exception

A preflight is a round trip, and a document that is being unloaded does not get
one. `navigator.sendBeacon(url, blob)` with `type: 'application/json'` and
`fetch(url, { keepalive: true })` with a JSON `Content-Type` both *report*
success and both die on the preflight when `url` is another origin — measured
by a consumer on a page-leave event: the calls were made, the server received
nothing. The same beacon with a string body (`text/plain;charset=UTF-8`) is a
simple request and arrives every time.

Three consuming projects had this shape on 2026-09-06: all three serve the
frontend and the API from different origins, and all three send their
page-leave event with a JSON body. One worked around the contract with a raw route; the other two send a
body that, by this mechanism, does not arrive on unload. The framework's own
guide already shows a `beaconUrl` built from a contract — the URL was
supported, the body was not.

## Why the exception is gated on `Origin`, and on nothing weaker

Once an endpoint accepts `text/plain`, the CSRF wall above has a door in it,
and two of the three consumers keep their session cookie at `SameSite=None`,
so the browser would send it through that door from any site. Something on the
server has to close it, and `Origin` is the right thing:

- a browser sets `Origin` on every cross-origin `POST` and on `sendBeacon`,
  and a page cannot choose or suppress it — it is the one header a foreign site
  cannot forge;
- the server already has the list of sites it trusts: `cors.origin`.

Three answers that look like an allow-list are not one, and each is refused:

- **`'*'`.** `assertCorsConfig` forbids `'*'` with `credentials: true`, but
  cookie authentication does not depend on `credentials` — a server with
  `origin: '*'`, no `credentials`, and a session cookie is legal and common.
  A wildcard admits every site, which is exactly the thing the check exists to
  prevent.
- **`null`.** A sandboxed iframe, a cross-origin redirect and a `file://` page
  all send the literal `Origin: null`. It names no site; listing it would let
  any of those three in.
- **absent.** A simple request from a browser always carries the header; a
  request without it did not come from the code path this flag serves.

`resolveOrigin`, which builds the CORS *response* headers, is not reused: for a
single-string `origin` it returns the configured value without comparing it to
the request, which is correct for a header and wrong for a gate. The gate is
its own function, `isOriginAllowed`, and compares in both shapes.

## What the check is, and is not

The `Origin` check is a **browser invariant**, not authentication. A `curl` with
a stolen cookie and a forged `Origin` header passes it — and that is an
authenticated call by whoever holds the cookie, not a cross-site forgery. The
check removes the one attack a browser makes possible on the user's behalf; it
adds nothing to what a cookie already means.

Two further consequences an application has to know:

- **Identity carried in the body is not available to `authorize`.** The auth
  hook runs before the body is read (`create.ts`: `hooks.authorize`, then
  `parseRequestPayloadInto`). A client that cannot send headers on unload —
  `sendBeacon` sends none, so a bearer-authenticated app must put its token in
  the body — reads that token in `beforeHandle` or in the handler, not in an
  auth hook. Cookie-authenticated apps are unaffected: the cookie is a header.
- **`POST` only.** `GET` and `HEAD` carry no JSON body, multipart is its own
  parser, and `PUT`, `PATCH` and `DELETE` are never simple requests — they
  always preflight — so the flag would buy nothing there and only widen the
  surface the check guards. `defineContract` refuses the other seven shapes.

## Why the flag does not force `expose: ['HTTP']`

`rawBody` and `rawResponse` coerce an endpoint to HTTP-only because what they
change (retained text, an owned `Response`) has no meaning on a tool transport.
`safelistedBody` changes how an HTTP body is *parsed*; the operation's input,
output and meaning are unchanged, and a beacon-receiving endpoint is no less a
tool than its neighbour. The flag rides through to `MethodDef` for hooks, into
the OpenAPI document as a second `requestBody` media type with the same schema,
and into the surface manifest's operation fingerprint beside `rawBody` — the
fingerprint's only job is to refuse two definitions of one operation that
disagree, and this is a way to disagree.

## Consequence

- `EndpointDef.safelistedBody?: true`; `MethodDef.safelistedBody`;
  `assertSafelistedBodyEndpoint` at contract time.
- `isOriginAllowed(cors, origin)` in the CORS middleware; `parseJsonBody`
  consults it for a `text/plain` body on a flagged endpoint and refuses with
  `403 FORBIDDEN` naming the reason.
- A consumer with a raw route for its beacon can delete it; a consumer sending
  a JSON blob on unload can switch to a string body and receive it.

## Related

- ADR 0051 — the JSON body limit this path shares.
- ADR 0038 — why `rawResponse` is HTTP-only, and why this flag is not.
