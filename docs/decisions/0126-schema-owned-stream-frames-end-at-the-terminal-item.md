---
title: "ADR 0126: Schema-owned stream frames end at the terminal item"
description: "An opt-in NDJSON mode carries contract items directly and uses a required terminal item as both completion proof and the I/O ownership boundary."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0126 — Schema-owned stream frames end at the terminal item

## Context

The default contract stream envelope provides three independent wire facts:
data, a safe post-header error, and explicit normal end. Some established
NDJSON protocols already encode those facts in their item schema, including a
terminal item. Wrapping those items changes the protocol and forces an
application to retain a second parser beside the contract client.

An unwrapped stream cannot distinguish successful EOF from a producer failure
after headers. Treating either as success would weaken the contract. Likewise,
observing a terminal item without closing the owned request leaves capacity
occupied while the caller is suspended at the yielded value.

## Decision

Contract streams keep `framing: 'envelope'` and `completion: 'stream-end'` as
their defaults. An endpoint may instead declare NDJSON `framing: 'item'` only
with `completion: 'terminal'` and a terminal schema. Every wire frame is then
the validated item itself; there is no Stitchkit `data` / `error` / `end`
envelope.

The server stops its producer immediately after the matching terminal item and
does not consume trailing values. The client aborts the owned request and
cancels the body reader before yielding that terminal item. EOF before the
terminal fails as `STREAM_TERMINAL_MISSING`; a post-header producer or lifetime
failure closes the item-framed response and reaches the same missing-terminal
proof instead of placing a foreign error object on the schema-owned wire.

NDJSON final-line handling is an independent policy. `finalLine: 'allow'`
remains the default for compatibility. `finalLine: 'require-newline'` rejects a
valid JSON document whose delimiter is missing, so protocols that use the
newline as truncation evidence can retain that guarantee. The low-level
`parseNDJSON` surface accepts the same policy.

## Consequences

- Existing envelope-framed streams retain their exact wire and completion
  behaviour.
- Schema-owned framing is safe only where a terminal item proves success; a
  terminal-free raw feed continues to use `streamingRoute` / `parseNDJSON`.
- Releasing I/O before terminal delivery prevents a consumer suspended at
  `yield` from holding request or admission capacity.
- Blank NDJSON heartbeat lines, fatal UTF-8 decoding, frame-byte bounds,
  backpressure, caller abort and iterator cleanup remain shared mechanics.
