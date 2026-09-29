---
title: "ADR 0215: Upload progress is counted where the bytes leave"
description: "A client call takes onUploadProgress; Bun, Node and any injected transport count pieces of a streamed body as the transport pulls them, a browser on its own fetch counts XMLHttpRequest upload events; the Ky client's error envelope is raised after its retries."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0215 — Upload progress is counted where the bytes leave

## Context

The client guide said it plainly: stitchkit does not expose upload progress,
because Fetch has no portable upload event. A consuming project that shows a
recording's upload live (on a 200 ms link, most of a three-second wait is bytes
in flight) had to get it anyway, and the only seam was `ClientFetch`. It built a
registry keyed by fields of its own multipart body, re-parsed each request the
client handed its transport to find the key, re-read the body to send it as a
counted stream in Bun and through its own `XMLHttpRequest` in the browser. That
leaned on the form in which the client calls its transport — nothing promised
it, and the first live uploads went without progress because the tests called
the transport with `FormData` while the client calls it with a `Request`.

Every product that uploads a file writes the same thing, so it belongs in the
client, keyed by the call rather than by the body.

## Decision

1. **`onUploadProgress` is a per-call option**, beside `signal`, on
   `withOptions` for every call with a body. It hears
   `{ sentBytes, totalBytes, attempt }`: the first report is `0`, values only
   grow, the last of an attempt equals `totalBytes`. `sentBytes` counts bytes
   handed to the network, not bytes the server accepted. A `GET`, `HEAD`,
   `DELETE` or streaming endpoint refuses the option with a `TypeError` at the
   call.
2. **One wrapper, two routes, chosen per call.** The option wraps the fetch the
   call would have used; each wrapper call is one attempt, so a transport retry
   counts again under the next number. The body is encoded once — which is also
   where Bun's multipart boundary header is copied before it is forgotten.
   - **Stream** — Bun, Node, SSR, an injected `fetch`, a unix socket: the body
     leaves as a `ReadableStream` of 64 KiB pieces with an exact
     `content-length` and `duplex: 'half'`, and a piece counts when the
     transport pulls it (`highWaterMark: 0`, nothing read ahead). Measured on
     Node 24: the server sees the declared length, no chunked encoding.
   - **XHR** — a browser on its own fetch: `XMLHttpRequest` with the request's
     headers, credentials, cancellation and timeout, its response rebuilt as a
     `Response` so error parsing is the fetch path's. A streaming request body
     is not portable (Chromium only over HTTP/2, Safari never), and upload
     events are. Measured in Chromium on a 2 MB/s link: 23 reports over an
     8 MB body.
3. **Without the option the request takes the path it always did** — the
   wrapper is not installed; a test holds that the transport still receives the
   untouched `FormData` / `Request`.
4. **The Ky client raises a server's error envelope after its retries**
   (`beforeError`), not from `afterResponse`. Raised there, it ended the request
   before Ky saw the status, so `retry.statusCodes` never fired against a
   stitchkit server — every failure of which is an envelope. Found by the
   retried-503 test this option needed.

## Consequences

- A consumer's transport wrapper, its registry and its request re-parsing go;
  progress is one line in the call.
- The body of a counted call is held in memory once (it is, in practice,
  already: a `FormData` of a picked file is encoded before it is sent). A file
  larger than one request goes through ADR 0216 in parts, which is where large
  bodies belong anyway.
- An injected transport always takes the stream route. One that buffers a
  stream before sending reports the whole body at once — honest about what it
  pulled, useless as a progress bar; the unix transport is one, over a local
  socket where the whole body leaves in milliseconds.
- `credentials: 'omit'` is refused on the XHR route: XHR cannot drop
  same-origin cookies, and sending them silently would be the wrong request.
- The XHR route reads the response whole before the call resolves; that is why
  a streaming endpoint refuses the option.

## Not done

- Download progress. A response is already a stream the caller can count; no
  consumer has asked.
- A choice of route by the caller. The route follows from where the client
  runs and who owns the transport; a knob would let a browser pick the route
  that does not work there.
