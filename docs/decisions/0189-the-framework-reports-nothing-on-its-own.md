# 0189 — The framework reports nothing on its own

**Status:** Accepted
**Date:** 2026-09-22

## Context

A generation tool answers with an id and the waiting is a separate call, bounded
at ten minutes. In a host with widgets that is tolerable — the widget polls and
the person sees a card. In a text host it is silence: the tool is called, nothing
comes back for a minute or ten, and then either the result or a timeout, after
which the model calls again. Neither the person nor the model can tell a queued
job from a stalled provider, while the server knows exactly which it is.

The protocol has the channel. A host sends a `progressToken` in the call's
`_meta` and the server relates `notifications/progress` to that request. The
framework read neither end, so `packages/core/src` contained no occurrence of
either word.

## Decision

`ctx.reportProgress` on every tool call, and **nothing automatic**.

- Present on MCP, agent and CLI calls, a no-op wherever nobody is listening, so
  a handler never branches on transport to say what it is doing. Absent on HTTP,
  which has no channel for it.
- Never throws, never rejects. A message about work must not be able to kill the
  work it describes; a refused notification leaves the host exactly where a host
  that never asked for progress already is.
- `progress` is required by the protocol and is usually the thing a handler does
  not have: it has a stage to name and no scale to name it on. Omitted, the
  ordinal of the update is sent, with no `total`. That is a fact about what
  happened. A synthesised percentage would be a claim nobody measured, and a bar
  stuck at 3% is worse than a counter.
- The framework sends nothing by itself. Progress is meaningful only where an
  operation has observable stages, and manufacturing one per call would be
  inventing a second transport beside the one the protocol provides.

**The one exception, and why it is not a contradiction.** `mountWait` reports
each poll: the phase the last snapshot declared, and that snapshot's own numeric
`progress` when it has one. It is not guessing stages — it already polls and
already holds the answer, and it is precisely the tool whose silence raised the
question. Leaving it out would have left every consumer wiring the same relay by
hand, which is a consumer workaround for a mechanism we own.

## Consequences

`progressToken` is on `McpCallContext` as data; the reporting function is at the
root of the call context and deliberately not on that type, because
`McpCallContext` is also the declared type of `RequestEvent.mcp` and an audit
row's shape must not claim to carry behaviour.

A host that asked for nothing gets byte-for-byte what it got before, including
a plain JSON response rather than a stream. That is asserted, not assumed.
