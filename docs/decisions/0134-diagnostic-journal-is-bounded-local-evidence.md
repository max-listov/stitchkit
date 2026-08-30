---
title: "ADR 0134: Diagnostic journal is bounded local evidence"
description: "One schema-owned FIFO writer captures finite local JSONL evidence without claiming durable delivery or creating a second observability framework."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0134 — Diagnostic journal is bounded local evidence

## Context

The application entrypoint already has no-queue admission, ordered/latest bounded channels,
failure-isolated event sinks and managed file operations. None owns the combined contract needed
by a local metadata journal: synchronous schema validation and serialization, retained-byte
admission including the write in flight, one append/rotation order, exclusive path ownership and
finite generations. Reassembling those guarantees in each application makes overload and shutdown
semantics drift.

This evidence is useful after a process problem, but it is not business state. Calling it durable
would be false: an accepted frame is only retained in process memory, an append completion is not
an `fsync`, and abrupt termination may leave a partial tail or stale ownership lock.

## Decision

Expose `createDiagnosticJournal()` from the evolving, server-only `stitchkit/application`
entrypoint. The application supplies a Zod event schema, a normalized absolute local file path and
five positive limits: event bytes, pending items, pending bytes, file bytes and retained files.

`submit()` validates and serializes synchronously before bounded admission. Accepted frames receive
one process UUID epoch and a contiguous sequence, enter one FIFO writer and retain their serialized
bytes until their append attempt settles. Capacity, invalid, oversized, closed and terminal-failure
refusals are explicit and consume no sequence. One manager owns the canonical path through an
exclusive mode-`0600` lock; rotation retains at most the declared number of regular files and never
follows a final-path or generation symlink.

`flush()` waits for accepted append attempts through its call boundary. `close()` stops admission,
drains accepted frames and releases ownership. Their timeout and cancellation options bound only
the caller's wait: physical work and its memory ownership continue until settlement. Writer,
rotation and close failures become terminal status and an isolated optional diagnostic callback;
they never recurse into the journal.

There is no reader or repair API. A non-newline active tail found at startup is preserved by
rotation and counted; the new process starts a fresh epoch and sequence. The path is operator
configuration, never event data.

## Consequences

- Applications get one reusable finite local evidence recipe without changing existing sink or
  observability semantics.
- Exact ordering is process-local. Epoch plus sequence identifies a run boundary but proves neither
  remote receipt nor exactly-once execution.
- `accepted` means accepted to bounded memory; `written` means an append completed; neither means
  storage durability.
- A deployment that requires crash recovery, replay, remote aggregation or stale-lock arbitration
  must provide a real durable store or deployment-owned log collector instead.
- The Node filesystem dependency remains isolated behind `stitchkit/application`; browser-safe
  entrypoints do not import it.
