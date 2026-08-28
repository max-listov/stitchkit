---
title: Fail-closed Unix client transport on Bun and Node
description: Fail-closed Unix client transport on Bun and Node with explicit ownership, bounds and published conformance evidence.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
pipeline: transport-primitives
order: 1
depends-on: —
---

## Зачем

The 0.67.0 guide documents createHttpClient({ unix }) as Bun-only: another runtime can ignore the socket option and dial baseUrl over TCP. browser/http.ts forwards the runtime-specific option to fetch. A caller selecting a local socket needs that selection to be an enforced transport boundary, not a hint. ClientConfig.fetch already supplies an extension seam.

Evidence is source/document inspection, not a newly executed reproduction. Reproduce against the released package before choosing the implementation.

## Результат

The existing typed-client pipeline can use a supported Bun/Node Unix adapter with bounded requests/responses and explicit ownership of connections. A selected Unix path never silently becomes TCP. No daemon startup, token discovery or caller-controlled remote path selection.

## План

- [x] Reproduce using a Unix responder and a TCP sentinel at baseUrl; select Unix and prove which listener receives requests.
- [x] Choose an explicit runtime adapter through the existing ClientFetch/HTTP-client seam; keep browser exports free of Node/Bun imports.
- [x] Specify absolute socket-path validation, connection pooling/disposal, redirects, body limits and cancellation through response consumption.
- [x] Preserve the distinction between not dispatched, possibly dispatched and received remote failure; do not infer successful non-execution from a timeout.
- [x] Keep replay policy explicit: the no-retry mode sends once, and a received response never triggers cross-transport fallback.
- [x] Document compatibility with the existing Bun Unix option; changed unsafe behavior requires the normal breaking-change/migration process.

## Acceptance

- [x] Packed Bun and Node clients reach a real Unix server while the TCP sentinel receives zero requests, including missing socket and redirect cases.
- [x] Missing/refused/permission failures are explicit; Unix delivery cannot be silently ignored on an unsupported runtime.
- [x] Pre-abort, pending headers, trickling body, oversize request/response and close-with-active-work are bounded and settle once.
- [x] Disposal leaves no owned sockets/timers that keep the standalone consumer alive.
- [x] Ordinary HTTP, auth, raw responses, multipart and typed output validation retain their established contract.
- [ ] Published import paths, package integrity and standalone local-daemon examples are recorded; no consumer source changes required to publish.

Related completed baseline: docs/backlog/done/2026-08-18-unix-socket-transport.md. Do not reopen or replace its server-side behavior by assumption.

## Runtime backpressure evidence — 2026-08-28

A concrete consuming SDK uses node:http.request({ socketPath }) on both runtimes.
With its installed package, a real Unix HTTP producer writes 512 NDJSON frames,
32768 decoded bytes each, obeying response.write(false)/drain. The consumer takes
one frame and then performs no next() for200ms.

Bun1.3.14/macOS arm64:512/512 frames written by200ms; process RSS75,743,232 ->
784,793,600 bytes in one observed run. Node26.7.0 with the same fixture/package:
6/512 frames by100ms and still6 by200ms; RSS78,020,608 ->81,543,168.
RSS includes producer and consumer and is sampled, not an attributed heap bound.
A50ms-only assertion can pass on Bun while the whole burst is being buffered.

Bun source at tag bun-v1.3.14:
src/js/node/_http_incoming.ts consumeStream() repeatedly calls reader.readMany()
and self.push(v) without respecting push(false); _read() starts that loop.
Therefore a Node HTTP response wrapper is not by itself a bounded Bun reader.
This does not establish a defect in a not-yet-published new adapter.

- [x] Test fast producer/stalled reader on both runtime paths through installed adapters.
      Check a bounded plateau and cancellation after a yielded frame, not just a short
      elapsed-time sample. Use a real Unix socket and keep the producer bounded too.
- [x] Do not implement Bun streaming by wrapping this eager node:http response without
      proving that buffering is bounded below the consumer parser. A parser byte limit
      alone does not bound the unread response queue.

## Выполнено до публикации

- `createUnixClientTransport()` is exported from `stitchkit/server` and
  `stitchkit/node`; `createHttpClient({ fetch })` composes it with the existing
  typed client. Legacy `unix` configuration now refuses non-Bun runtimes instead
  of falling through to TCP.
- Defaults are 16 MiB request and response limits, 64 KiB response headers,
  30 s to headers, eight connections and five redirects. Redirects remain on
  the selected Unix socket. `close()` owns and settles active requests/bodies.
- Bun uses a raw Unix socket adapter whose `ReadableStream` pull/cancel controls
  `pause()`/`resume()`/`terminate()`; Node uses `node:http` with a bounded body
  bridge and a finite agent. Both expose stable delivery states through
  `UnixClientTransportError`.

## Регрессия

`packages/core/tests/unix-client-transport.test.ts`:

- `the selected socket is the only transport, including an absolute redirect`
- `composes with createHttpClient and preserves received HTTP failures`
- `bounds request and response bytes before retained memory can grow`
- `Bun pauses a fast producer when the response reader stalls`
- `close interrupts an active body once and the finite connection cap refuses without queueing`
- `missing sockets, pre-abort, header timeout and close settle explicitly`
- `rejects ambiguous configuration and unsafe legacy Unix selection`

Installed-artifact lanes additionally report `portable bounded Unix client on
Node: OK` and `packed Bun Unix client conformance: ok`.
