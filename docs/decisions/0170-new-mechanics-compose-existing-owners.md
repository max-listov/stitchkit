---
title: New mechanics compose existing owners
description: Socket membership, error maps and logging bounds extend the existing auth, error and sanitizer paths; a second DSL or plugin system is rejected.
type: decision
status: accepted
created: 2026-09-06
updated: 2026-09-06
---

# 0170 — New mechanics compose existing owners

## Decision

New cross-cutting mechanics attach to the layer that already owns the fact:

- a socket registry receives an already authenticated `RealtimeServer` and
  owns membership, authorized room tokens, replay buffering and cleanup;
- application error vocabularies extend `defineErrors` and feed the existing
  error hook;
- endpoint dimensions use an explicit typed projector into request context;
- bounded logging extends the existing sanitizer and decorates `StitchLogger`.

We reject a second contract DSL, a server `use` plugin system, namespace export
objects and duplicate release/tracking names. Client trace and release hooks
remain fields of the existing HTTP client configuration.

## Why

Authentication, validated realtime emission, error construction, request
context and redaction already have one implementation each. A parallel helper
would create two security or semantics paths. The proposed syntax layers also
did not remove information: path-parameter inference did, and is recorded in
ADR 0168.

## Consequences

- The registry cannot authenticate or invent event validation; it composes the
  server already in use.
- Replay is revision-aware and can request resynchronization rather than emit a
  stale snapshot after buffered changes.
- Caller fields cannot overwrite framework context, and redaction precedes
  truncation.
- Existing release and tracking names remain canonical; no aliases are added.
