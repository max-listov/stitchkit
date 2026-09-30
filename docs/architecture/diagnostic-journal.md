---
title: Bounded diagnostic journal architecture
description: Current schema, admission, ordering, file ownership, rotation, bounded reading and explicit recovery observations.
type: architecture
status: active
created: 2026-08-30
updated: 2026-09-30 17:41 +07:00
---

# Bounded diagnostic journal architecture

`createDiagnosticJournal()` is one optional process-local metadata sink in
`stitchkit/application/diagnostic-journal`. Its pure schemas stay in
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
refused before admission. A non-empty startup tail without a newline is rotated intact,
`partialTails` increments and the fresh process epoch begins in a new file. The usual finite
retention policy still evicts the oldest generation when its slots are full. With `maxFiles: 1`,
startup instead throws `DiagnosticJournalRecoveryError`, without deleting active or archived
evidence, and releases the lock: preserving the torn file requires at least two slots.

After acquiring the lock and rotating a torn active tail, startup uses the shared reader to
inspect all retained generations and the active file. It validates the version-1 frame and JSON
payload, without imposing today's event schema on historical payloads. If it finds damage,
`getStatus().recovery` records counts plus the first and last anomaly, retaining constant-size
diagnostics. This is a startup observation, not a continuous scan. Preserved bytes let another
start reconstruct the diagnosis. It does not recurse through this journal's writer.

The `.lock` is exclusive ownership, not a crash lease. Abrupt death can leave it behind. The
default policy refuses it; `reclaim-stale` requires machine/process liveness evidence, as described
in the guide. Inspection and recovery failures close the file and release an acquired lock.

## Bounded snapshot reader

`readDiagnosticJournal({ paths, eventSchema, maxLineBytes, signal? })` lives in the filesystem
leaf. The caller chooses normalized absolute paths and their order, including which retained
generations exist. Each file is opened without following a final symlink, checked as a regular
file, and read only through its size at open. Later appends are outside that file's snapshot.
Missing paths, denied access, unsafe file types and mid-read truncation throw; they never become
row anomalies. This is a reader of operator-owned files, not a lock against a concurrent rotator.

One 64 KiB chunk and at most `maxLineBytes` of a line body are retained. An oversized row drops
its buffer, counts bytes through LF/EOF, emits an anomaly, and continues with the next row.
Valid frames are validated once through the caller's event schema, preserving its output type.
Anomalies identify NUL, invalid UTF-8/JSON/frame/event, oversized rows and unterminated tails.
They include zero-based byte offset, one-based line, tail/interior position, termination and
skipped bytes including LF. A valid frame without LF emits a warning with zero skipped bytes
and then its frame. Cancellation, early iterator return and failures close the open handle.

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

There is intentionally no managed replay, remote upload, exactly-once claim, provider payload
capture or durable receipt. Applications needing any of those use an application-owned store or
deployment log pipeline.
