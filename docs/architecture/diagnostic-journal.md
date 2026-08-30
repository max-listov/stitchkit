---
title: Bounded diagnostic journal architecture
description: Current schema, admission, ordering, file ownership, rotation and truthful settlement contract.
type: architecture
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Bounded diagnostic journal architecture

`createDiagnosticJournal()` is one optional process-local metadata sink in
`stitchkit/application`. It is deliberately smaller than a log platform and weaker than a durable
store.

## Why this is a distinct composition

| Existing surface | Existing guarantee | Guarantee it does not own |
| --- | --- | --- |
| `createBoundedAdmission` | physical concurrency and truthful caller timeout | FIFO retention, serialized byte accounting and file ownership |
| `createBoundedChannel` | finite ordered or replaceable pending delivery | in-flight bytes, serialization, append and rotation |
| application/request/agent sinks | isolated observation and bounded pending count | deterministic file order, retained bytes and generations |
| managed files | contained finite reads and writes | append lifecycle, journal frames and rotation |

The journal reuses ordered channel delivery and adds only the missing owner: one synchronous
schema/serialization admission boundary, one writer and one rotating file set. Existing primitives
and their semantics remain unchanged.

## State and admission

```text
open ──close──▶ draining ──writer + file close──▶ closed
  │                  │
  └──writer/rotation/close failure─────────────▶ failed
```

`submit(event)` is synchronous. It increments `received`, validates through the owner schema,
verifies JSON compatibility, serializes the complete JSONL frame and checks all applicable limits
before retaining it. There is no producer callback and therefore no hidden asynchronous preparation
queue.

An accepted frame is:

```json
{"schemaVersion":1,"epoch":"process-uuid","sequence":1,"event":{}}
```

Only accepted frames consume a sequence. `pendingItems` and `pendingBytes` include queued and
in-flight frames until the physical append attempt settles. Overload refuses synchronously rather
than waiting or evicting accepted ordered evidence.

| Outcome | Meaning |
| --- | --- |
| `accepted` | complete serialized frame is retained inside the declared memory bounds |
| `invalid` / `oversized` | input failed its schema/JSON or serialized limit before admission |
| `item-capacity` / `byte-capacity` | current retained work leaves no declared capacity |
| `closed` / `failed` | admission is no longer open |

## Filesystem ownership and retention

The operator supplies a normalized absolute path whose parent already exists. The parent is
canonicalized once, allowing normal host aliases such as a symlinked temporary directory while
binding all later operations to one directory. The final journal, lock and generation paths never
follow symlinks. This is a local POSIX Bun/Node boundary in an operator-controlled directory, not
an adversarial multi-user filesystem sandbox.

The manager exclusively creates `<path>.lock`; a second live manager fails to open. Newly created
files and the lock use mode `0600` by default. `maxFiles` counts the active file plus numbered
generations, so disk retention is at most `maxFiles × maxFileBytes` for frames created by this
manager. A pre-existing complete active file may initially exceed the configured limit; it is
rotated before the next append. Unexpected unrelated files are untouched.

Rotation happens before a frame that would exceed `maxFileBytes`. A frame larger than one file is
refused before admission. A non-empty startup tail without a newline is not parsed or repaired: it
is rotated intact, `partialTails` increments and the fresh process epoch begins in a new file.

The `.lock` is exclusive ownership, not a crash lease. Abrupt death can leave it behind; an
operator removes it only after proving the old process is gone.

## Settlement and failure truth

One worker appends accepted frames in sequence. `flush()` captures the latest accepted sequence at
call time and waits until every append attempt through that sequence settles. It does not call or
promise `fsync`. `close()` closes admission immediately and waits for the same worker plus file and
lock cleanup. Timeout or cancellation ends only that caller's wait; retained capacity is released
only when physical work settles.

A write or rotation failure terminalizes the journal, counts the current and remaining accepted
frames as failed, drains their retained bytes and refuses later submissions. Close failure is also
terminal. `onFailure` receives the internal cause out of band; its own rejection is isolated and is
never written back into this journal.

There is intentionally no replay, reader, remote upload, exactly-once claim, provider payload
capture or durable receipt. Applications needing any of those use an application-owned store or
deployment log pipeline.
