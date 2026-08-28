---
title: Contract-first bounded typed streaming responses
description: Contract-first bounded typed streaming responses with explicit ownership, bounds and published conformance evidence.
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
pipeline: transport-primitives
order: 2
depends-on: —
---

## Зачем

In 0.67.0 rawResponse deliberately has no output schema, streamingRoute takes AsyncIterable<unknown>, and parseNDJSON has no line-byte ceiling. Its parse errors are optional callbacks and generic T is not runtime validation. Applications must join the request contract, frame schema, terminal semantics, decoder and cancellation themselves.

The existing route already supplies header flushing, heartbeat, backpressure and an abort signal. Extend that surface; do not create a competing framing stack.

## Результат

One explicit streaming contract yields a validated server boundary and a typed client iterator. The application supplies frame schemas and any terminal predicate; framing does not infer business success, cursors or durability. Both a finite log feed and a quiet ongoing observation feed are first-class.

## План

- [x] Reproduce missing bounds/error visibility against the released parser with controlled local sources; record the baseline without claiming all NDJSON must require a final newline.
- [x] Design a streaming declaration using existing contract/client machinery: input, item schema, encoding and documented completion policy.
- [x] Bound encoded frame/body bytes before unbounded accumulation and validate decoded frames; specify malformed JSON, invalid UTF-8 and trailing-line behavior.
- [x] Tie request abort, body disposal, iterator return and client close to one operation lifetime, including pending next() and suspension at yield.
- [x] Separate header-open timeout, optional total lifetime and slow-reader behavior; silence alone is not a subscription failure.
- [x] Preserve pre-header HTTP errors; define safe typed post-header failures without leaking internal exception text.
- [x] Provide compatibility/migration for rawResponse, parseNDJSON and NDJSON/SSE routes; do not silently widen tool exposure.

## Acceptance

- [x] Packed Bun/Node examples infer request and frame types from schemas; invalid producer/client shapes fail typechecking.
- [x] Fragmented UTF-8/JSON, oversize unterminated lines, malformed frames and truncated required terminals have explicit bounded outcomes.
- [x] Quiet cancellation and cancellation at a yielded frame release server admission, not merely the local iterator.
- [x] A fast producer and stalled reader cannot create an unbounded byte queue; heartbeat cannot bypass backpressure indefinitely.
- [x] Existing quiet-stream headers/heartbeat/disconnect guarantees remain covered by exact regression cases.
- [x] The public primitive contains no mandatory node IDs, epochs, topic names or domain envelope; publish documentation and packed evidence.

Related completed baseline: docs/backlog/done/2026-08-25-a-long-lived-streaming-route-needs-a-primitive.md.

## Выполнено до публикации

- An endpoint `stream` descriptor is Zod-first and HTTP-only. It carries the
  item schema, `ndjson`/`sse` framing, a 256 KiB default frame bound, optional
  lifetime/heartbeat/idle policies and an optional terminal schema.
- Server iteration validates before framing and emits scrubbed typed terminal
  errors after headers. Client iteration validates every item, refuses malformed
  or truncated wires, and aborts the owned request on `return()`.
- `parseNDJSON` and `parseSSE` now default to a 1 MiB line ceiling, use fatal
  UTF-8 decoding and fail closed when no explicit error callback handles a bad
  frame. Existing raw/route APIs remain available.

## Регрессия

`packages/core/tests/contract-streaming.test.ts`:

- `the typed client yields validated NDJSON items and requires a terminal`
- `post-header producer failures are typed and scrub internal messages`
- `client return aborts a quiet server source through the same operation signal`
- `malformed, invalid UTF-8 and oversized unterminated lines fail closed`
- `a truncated wire and missing declared terminal are explicit client failures`
- `one oversized producer frame becomes a bounded safe stream error`

`packages/core/tests/openapi.test.ts`:

- `describes contract streams without pretending their envelope is buffered JSON`

The packed Bun and Node lanes compile schema-derived iterator types and execute
a quiet long-lived stream through the installed tarball.
