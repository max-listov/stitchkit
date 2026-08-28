---
title: "ADR 0125: Streaming bodies bound retained bytes, not lifetime traffic"
description: "Unix response policy separates finite cumulative bodies from pull-driven streams whose lifetime traffic is not a memory bound."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0125 — Streaming bodies bound retained bytes, not lifetime traffic

## Context

A finite HTTP response needs a cumulative byte ceiling: otherwise a caller that
buffers it can grow without bound. A long-lived NDJSON or SSE subscription has a
different invariant. Its frame, socket queue and consumer backlog must be bounded,
but the total bytes successfully drained over its lifetime are not retained memory.
Applying the unary 16 MiB total to both shapes eventually terminates every healthy
subscription.

Neither `Content-Type` nor an operation name declares memory ownership. `Infinity`
also erases the distinction instead of expressing it, and an automatic reconnect
would invent delivery semantics the transport cannot know.

## Decision

`createUnixClientTransport` has two explicit response-body modes:

- `bounded` is the default and applies `maxResponseBytes`, defaulting to 16 MiB;
- `streaming` removes only the cumulative response-total check and cannot be
  combined with `maxResponseBytes`.

Streaming remains pull-driven. Node pauses its `IncomingMessage` behind a
one-chunk Web stream queue; Bun pauses its socket and emits at most 64 KiB from
the owned wire buffer per pull. Request bytes, headers, connections, redirects,
framing validation, cancellation and transport shutdown keep their finite bounds.
Frame and application backlog bounds belong to the stream contract and consumer.

## Consequences

- Unary clients stay fail-closed without configuration changes.
- A subscription opts in at composition time with
  `responseBodyMode: 'streaming'`; the adapter never guesses from response data.
- Lifetime traffic may exceed 16 MiB while a stalled reader still stops the
  producer and cancellation releases the connection slot.
- Applications needing unary and streaming calls can compose separate transport
  handles, making the weaker cumulative policy visible at the call boundary.
