---
title: "ADR 0123: Terminal output is accepted before commit and tool rounds keep causal order"
description: "A protocol may reject an invalid completed assistant before CAS, and history projection preserves alternating assistant/tool rounds."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0123 — Terminal output is accepted before commit and tool rounds keep causal order

## Context

A provider `stop` with no content was committed as success even when the
application protocol required an answer. The only downstream remedy was to
rewrite an already terminal durable record. Separately, one persisted assistant
can contain several tool steps, but projection grouped every call before every
result. A dependent call therefore appeared parallel with the call whose result
created its input, and final text appeared before its evidence.

## Decision

- A protocol may declare `terminalAcceptance`. The built-in `require-output`
  rule accepts non-blank text, generated files, structured provider parts and
  an explicit tool-only policy stop; a callback may define another rule.
- Acceptance runs only for would-be completed outcomes and before terminal CAS.
  Interrupted, cancelled and failed records retain their actual reason.
- Canonical parts are projected in their persisted order. Adjacent assistant
  parts form one assistant message and adjacent results form one tool message;
  changing role flushes the current round.
- Tool chronology is valid only when every unique call is followed by exactly
  one result. Parallel calls before their results remain one legitimate round.

## Consequences

- Protocols that permit empty completion keep the default `allow-empty` path.
- A rejected candidate is a failed assistant and is never exposed as successful
  durable output.
- A runtime can feed its own multi-step terminal record into the next provider
  call without consumer-side history rewriting.
