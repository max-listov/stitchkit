---
title: "ADR 0038 — Raw-response endpoints (the handler owns the Response)"
type: decision
status: accepted
created: 2026-08-05
updated: 2026-08-05
---

# ADR 0038 — Raw-response endpoints (the handler owns the `Response`)

- **Status:** Accepted — carves a documented, HTTP-only exception out of
  [ADR 0027](0027-transport-neutral-contract-execution.md); upholds
  [ADR 0002](0002-generic-core.md)
- **Date:** 2026-08-05

## Context

An endpoint that answers with **bytes rather than data** — a PDF, a file
download, an SSE stream — cannot satisfy a contract handler's obligation to
return a value matching an `output` schema. Consumers therefore moved such
endpoints out of their contracts and into `rawRoutes`. Two projects did this
with five and four endpoints respectively.

That move is honest about the tool surface (their previous hand-rolled transport
registered `pdf_project` and `download_document` as *tools*, so a model could
call them and receive a serialized `{}`), but it costs three things that have
nothing to do with bytes:

1. **The typed client disappears.** The frontend calls the path as a string
   (`window.open('/api/projects/' + id + '/pdf')`); a typo is not a compile
   error and the query is validated only server-side.
2. **The route registry splits.** "Every route is a contract" stops being true,
   so audits, OpenAPI and route diffs all need a second place to look.
3. **Auth becomes manual.** `rawRoutes` match before contracts and never run
   `hooks.beforeHandle`, so each handler must call the guard on its first line.
   This is the only place in a stitchkit app where authorization rests on
   discipline rather than on the framework.

Point 3 is the serious one: it converts a framework guarantee into a review
item, on exactly the endpoints that serve private documents.

Separately, a `Response` returned from a *normal* contract handler was
**silently destroyed**: `afterHandle` wrapped it, output validation had nothing
to check, and `json()` serialized it to `{}` with status 200 — headers, status
and body gone, no error anywhere. The guide's SSE snippet
(`return streamSSE(tokens())`) showed a bare `return` with no surrounding
handler, so it read as endorsing exactly that.

## Decision

An endpoint may declare **`rawResponse: true`**. Its handler returns the `Response`; the
router applies CORS and nothing else.

```ts
download: {
  method: 'GET', path: '/:id/pdf', desc: 'Download a document as a PDF',
  params: z.object({ id: z.uuid() }),
  rawResponse: true, contentType: 'application/pdf',
}
```

- **The request half is unchanged.** `params` / `input` / `multipart` parse and
  validate as on any endpoint, and `beforeHandle` runs — so the auth gate
  applies with no guard in the handler. That is the point of the feature.
- **The response half is handed over.** No `output` schema, no serialization,
  and `afterHandle` is **skipped** — that hook transforms *data*, and there is
  none. (A silent asymmetry, so it is stated here, in the guide and in the
  changelog rather than left to be discovered.)
- **Never a tool.** `collectTools` skips raw methods. The skip is load-bearing,
  not tidiness: with no `expose`, MCP and AGENT are on by default, so without it
  a raw endpoint would mount as a tool and hand a model `{}`.
- **`contentType`** is documentation only — the handler still sets the real
  header. It drives the OpenAPI media type, which would otherwise have to
  document a raw endpoint as `204 No content`, a plain lie.
- **The mirror case now fails loudly.** A non-raw handler returning a `Response`
  is a type error, and a 500 naming the fix at runtime, instead of `{}`.

### Enforcing it in the type

A naive optional flag enforces nothing. This repo already had the proof:
`HttpOnlyEndpointDef.toolName?: never` is unreachable, so
`expose: ['HTTP'] + toolName` compiles cleanly today. A new member with an
optional `rawResponse` would have repeated it — measured on a probe of that
naive shape: all four forbidden combinations compiled, `tsc` exit 0.

What works is a **required literal discriminant plus `raw?: never` on both
existing members**. Then `rawResponse` + `output` / `toolName` / `ui` / `annotations` /
a non-HTTP `expose` are each a `TS2322`, and the three legal shapes still
compile. The handler's return type follows from the same discriminant
(`HandlerReturn<E>`), which is what makes both directions errors.

The **pre-existing `toolName` hole stays open at the type level** and is not
fixed here: `expose: ['HTTP']` also satisfies `ToolEndpointDef`, whose members
are all optional, so the union admits the pair and no discriminant can be added
without breaking every plain endpoint. The runtime guard in `defineContract`
already throws on it at definition time; the code comment claiming the type
forbids it was wrong and has been corrected. Raw endpoints get the same
belt-and-braces treatment (`assertRawEndpoint`), because a contract assembled at
runtime bypasses types either way.

## What this does to ADR 0027 and to the cookie task

**It carves an exception, and says so.** The earlier framing — "a raw endpoint is
HTTP-only *by construction*, so transport neutrality is untouched" — was a
rationalisation. ADR 0027 remains Accepted, and its bring-your-own-transport
clause means exposure over such a lane is the *transport's* choice, not the
contract's `expose`. The BYO dispatcher does not exist today only because
[ADR 0028](0028-revert-contract-dispatcher.md) reverted it for want of a consumer; if it
returns, a raw handler would hand it a `Response`. Safety here rests on the
current transport inventory, not on type construction.

The honest statement is therefore: **Range, conditional requests and streaming
need the transport object itself. A descriptor cannot express them Fetch-cleanly,
so we accept a documented HTTP-only class of endpoint and the dent it puts in
neutrality.** A BYO dispatcher must skip raw-response methods exactly as the
tool mounts do — `MethodDef.rawResponse` is carried for that purpose, and
`implement` additionally forces `expose: ['HTTP']` so a reader that predates the
flag reaches the same conclusion without knowing about it.

**The cookie task's rejected option is explicitly not revived.**
`icebox/2026-08-05-response-meta-cookies.md` rejects "Option B — the handler
returns `Response`" for a *normal* JSON endpoint that additionally wants a
header. That rejection stands: there the endpoint keeps a JSON response and
every transport, and handing it a `Response` would drag HTTP into a
transport-neutral path for a header's sake. Here the endpoint has no JSON
response at all — the byte stream *is* the operation. The exception is granted
to the second shape and withheld from the first, which is why `rawResponse: true`
forbids `output` rather than being a modifier on an ordinary endpoint.

## Alternatives considered

- **A response descriptor** (`{ body, contentType, filename, disposition }`) —
  `ServeFileOptions` is already one, and it would keep `afterHandle` a pure data
  transform and need no exception at all. Rejected because `Range` / `If-Range` /
  `304` / `HEAD` need the *request*, and answering them needs `Bun.file`, which
  would drag Bun into the Fetch-clean `createHandler` (ADR 0013). A descriptor
  would cover four static cases and leave media streaming in `rawRoutes` — the
  split this ADR exists to close.
- **`output: 'stream'`** — a string literal in a field typed `ZodType` is two
  meanings in one field, the exact pattern rejected elsewhere.
- **Naming it `binary`** — wrong for SSE (text) and redirects.
- **Naming it `raw`** — shorter, but it sits beside `rawRoutes` in the same
  config surface while meaning something importantly different (a raw *route* is
  outside the contract; here only the *response* is raw — params, input and the
  auth gate all still run). `rawResponse` costs one word and says which half is
  raw; the guide still draws the line between the two explicitly.

## Consequences

- Downloads and streams live in the contract again: routed, gated, typed,
  documented, and visible to `listToolNames` as *absent*.
- The typed client resolves a raw endpoint to the untouched `Response`. That is
  deliberately more than the `Blob` the client already supports: the download
  filename lives in `Content-Disposition`, and a `Blob` loses the headers.
- `implementRemote` proxies one like any other endpoint: the same
  `responseType: 'response'` that serves the typed client also carries the remote
  `Response` — bytes, status and headers — through the proxy. (An earlier draft
  of this ADR forbade it "because the client parses JSON"; that reason was made
  false by this very change, and the ban is gone. Request headers are still not
  relayed, so a `Range` sent to the proxy does not reach the origin.)
- **Exposure is forced, not inherited.** `implement` / `implementRemote` set
  `MethodDef.expose = ['HTTP']` for a raw-response endpoint. Left undefined, the
  framework's own default convention reads "MCP + AGENT on", so every exposure
  reader that predates this flag — an audit script, a BYO transport — would
  conclude a download is a tool. Forcing it keeps them all correct without
  teaching them about `rawResponse`.
- **`multipart` + `rawResponse` is legal**, not an oversight: `multipart`
  describes the request, `rawResponse` the response, and "upload a file, get the
  converted one back" is a real operation. Both client paths return the
  `Response` for it.
- **A raw route shadowing a contract route is warned about at startup.** Raw
  routes match first, so the migration this ADR enables — move the download into
  the contract for the gate — silently keeps serving ungated bytes if the old
  route is left behind. The check runs the real `matchRawRoute` against a probe
  path per contract route, so it cannot disagree with the dispatcher. It warns
  rather than throws: an overlapping wildcard (a SPA fallback) can be deliberate,
  and refusing to boot a working app is the worse failure.
- **No typed URL builder.** The plan wanted `client.$url.pdf({ id })` for
  `window.open`. Cut: with Bearer auth `window.open` sends no headers, so the
  builder cannot serve the authenticated case at all, and a `${key}Url` naming
  scheme collides silently with a real `pdfUrl` key. Returning the `Response`
  covers the fetch-and-save path; a builder can be added later if a
  cookie-authenticated consumer asks.
- **`HEAD` is still not reachable** on a contract route: `HttpMethod` has no
  `HEAD`, so a HEAD probe gets 405 even though `serveFile` implements it. A raw
  route with `method: 'ALL'` remains the way to serve HEAD. Recorded as a known
  gap rather than papered over.
- **Path containment is the handler's job.** `staticRoute` enforces it;
  `serveFile` deliberately does not. Moving a file endpoint from `staticRoute`
  into a contract trades a built-in traversal guard for a hand-written one — use
  `isWithinDir`.
