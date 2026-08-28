---
title: "ADR 0117: Contract streams own validation and wire termination"
description: "An HTTP-only stream descriptor joins schema-derived items, bounded framing, explicit termination and one cancellation lifetime without replacing raw streaming routes."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0117 — Contract streams own validation and wire termination

## Context

`rawResponse`, `streamingRoute`, `parseNDJSON` and `parseSSE` intentionally solve
separate low-level jobs. Used alone they cannot prove that a producer yields the
declared shape, that a client validates it, or that normal EOF is different from
a truncated operation. An unconstrained line can also grow before JSON parsing.

## Decision

An HTTP endpoint may declare `stream: { item, format, maxFrameBytes,
lifetimeMs, heartbeatMs, idleTimeoutSeconds, terminal }`. Its handler returns an
`AsyncIterable` of schema-derived items and its typed client returns an owned
`AsyncIterableIterator` of the same output type.

The wire is a bounded internal envelope: `data`, safe `error`, and explicit
`end`. The server validates before encoding; the client validates both envelope
and item. EOF without `end`, or `end` without a declared terminal item, fails
explicitly. Iterator `return`, request abort, producer failure and operation
lifetime converge on one cancellation signal.

The descriptor is HTTP-only. It does not create a tool, cursor, replay log,
topic, durable subscription or business completion model. `rawResponse` and raw
`streamingRoute` remain available where the application owns the protocol.

The low-level NDJSON/SSE parsers gain a one-mebibyte default line ceiling and
fatal UTF-8 decoding. Parse errors fail closed unless the caller deliberately
supplies `onParseError`.

## Consequences

- Finite logs and quiet observations share one contract/client pipeline without
  claiming durable delivery.
- The default encoded contract frame limit is 256 KiB and may be tightened per
  endpoint.
- Post-header failures use safe codes because an HTTP status is no longer
  available.
- Existing tolerant parser consumers must opt back into skipping malformed
  records with `onParseError`.
