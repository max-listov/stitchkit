---
title: "ADR 0297: A watched read ends with its last subscriber"
description: The watch hub owns the lifetime of each shared read, hands the application a per-read AbortSignal, and treats cancellation as neither a value nor a failure.
type: decision
status: accepted
amends: ["0153"]
created: 2026-11-21 19:43 +08:00
updated: 2026-11-21 19:43 +08:00
---

# ADR 0297 — A watched read ends with its last subscriber

Amends the in-flight read in [ADR 0153](0153-a-watched-read-is-one-read-per-question.md). Serves **I8** and **I9**.

## Context

A key shares one read among every subscriber asking it. When all of them leave,
the read keeps running: the application has no way to know nobody waits for its
answer, because the subscribers are the hub's and so is the knowledge of when
the last one went. A consuming project measured this on a published release —
two subscribers, one read, both gone, and the read still preparing an answer.

The late answer also reached the wrong place. A subscriber arriving before the
abandoned read settled joined the same source, and the old answer was published
to it as the current value.

The application cannot build this beside the hub without a second subscription
registry, which is the duplication I8 refuses.

## Decision

`WatchHubConfig.read` receives one `WatchReadRequest`:
`{ operation, args, scope?, signal }`. The `signal` belongs to that one read.

- It stays live while at least one subscriber watches the key. One of several
  subscribers leaving does not touch it.
- It aborts when the last subscriber leaves — by `close`, `detach` or the
  revocation of its admission scope — and when the hub closes. The hold window
  keeps a known value warm; it does not keep work running.
- An aborted read's outcome is dropped, whether it is a value or an error. It is
  not published, not announced as `unavailable`, not logged and does not move the
  backoff. The key stays dirty, so a subscriber that arrives meanwhile is answered
  by the next read of the same loop.
- Single-flight holds for a read that ignores its signal: the next read of the key
  starts after the abandoned one settles, never beside it.
- The pause after a failure belongs to the key. A subscriber leaving and returning
  neither shortens it nor restarts the count, an abandoned read leaves the count
  alone, and a failed key keeps its source until the pause ends so the next
  subscriber does not meet a source that has forgotten the failure.
- The hub sets no deadline on a read; a read bounds itself by combining the signal
  with its own timeout, and that timeout is an ordinary failure.

The request is an object rather than a fourth position: `read(op, args,
undefined, signal)` is the call shape [api-shape](../architecture/api-shape.md)
refuses.

## Consequences

- Every `read` callback migrates from `(operation, args, scope)` to
  `({ operation, args, scope, signal })`; a read that passes `signal` to its
  driver or `fetch` stops paying for answers nobody wants.
- A cooperative read releases its source as soon as it rejects; a read that
  ignores the signal still holds the source until it settles, as ADR 0153
  requires.
- `close()` stays synchronous. Waiting for an application's own cleanup after
  the abort is the application's, because it owns the read.
