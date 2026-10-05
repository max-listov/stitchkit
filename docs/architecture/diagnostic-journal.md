---
title: Bounded diagnostic journal architecture
description: Current schema, admission, ordering, file ownership, rotation, bounded reading and explicit recovery observations.
type: architecture
status: active
created: 2026-08-30
updated: 2026-10-05 20:52 +07:00
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
retention policy still evicts the oldest generation when its slots are full. With `maxFiles: 1`
there is no slot to rotate the torn file into; it is a startup refusal (below).

After acquiring the lock and rotating a torn active tail, startup uses the shared reader to
inspect all retained generations and the active file. It validates the version-1 frame and JSON
payload, without imposing today's event schema on historical payloads. If it finds damage,
`getStatus().recovery` records counts plus the first and last anomaly, retaining constant-size
diagnostics. This is a startup observation, not a continuous scan. Preserved bytes let another
start reconstruct the diagnosis. It does not recurse through this journal's writer.

The `.lock` is exclusive ownership, not a crash lease. Abrupt death can leave it behind. The
default policy refuses it; `reclaim-stale` requires machine/process liveness evidence, as described
in the guide. Inspection and recovery failures close the file and release an acquired lock.

## Startup refusals and quarantine

Three conditions mean opening cannot keep a file in place: a torn active file with `maxFiles: 1`
(`torn-without-retention-slot`), a generation name that is a directory, link or other non-file
(`not-a-regular-file`), and a retained or active file the reader cannot read to its end
(`unreadable`). `onStartupRefusal` decides what happens:

| Policy | Effect |
| --- | --- |
| `quarantine` (default) | the file is renamed to `<file>.quarantined-<epoch>` beside it, the journal starts, `recovery.quarantined` names it with its reason (and `code` for `unreadable`), and every later open names it again until it is removed |
| `fail` | `DiagnosticJournalRecoveryError` with `reason`, `file` and, for a torn single slot, its `recovery` inspection; nothing moves, the lock is released |

A diagnostic journal takes the default: one damaged archive must not keep the application that
depends on it from starting, and the move removes no bytes. A journal that is a source of truth
takes `fail`, because writing past damage there is worse than not starting. If the rename itself
fails, the refusal stands under either policy, with `quarantineFailed: true` and both errors in the
cause.

The `<epoch>` is the opening process's `getStatus().epoch`, so a quarantined name says which run
moved it and never collides with another. The name is outside the generation pattern: retention
never reads, rotates or deletes it, its bytes are outside the `maxFiles × maxFileBytes` bound, and
removing it is the operator's call. Every open lists every `<file>.quarantined-*` and
`<file>.<n>.quarantined-*` beside the journal in `recovery.quarantined`, from the same directory
listing that finds the generations: the files this open moved first, with their `reason` (and
`code`), then the ones earlier opens left, by name and without a reason — their name carries the
epoch of the open that moved them and whose status gave it. The list holds at most 32 entries;
`quarantinedUnlisted` counts the rest, so a directory with thousands of them cannot grow the
status. A file stays listed until the operator removes it, so quarantined files cannot pile up
unseen.

Refusals that are not about retained evidence still throw: a held lock, a path that is not
normalized and absolute, an active path that is not a regular file, a directory that cannot be
listed. A journal opened over them would not write.

There is no journal-level `degraded` state. The kernel degrades only a resource declared
`required: false`, and a required resource cannot depend on an optional one; a quarantining
journal writes, so its resource is healthy and dependants read `journal.getStatus().recovery` from
the value they hold. → [ADR 0240](../decisions/0240-a-diagnostic-journal-quarantines-what-it-cannot-keep.md).

## Stability of the recovery status

`DiagnosticJournalRecoveryStatusSchema` is part of `stitchkit/application` and shares its maturity
(evolving). Consumers embed it in their own protocols, and it is `.strict()`: a reader parsing with
an older copy refuses a key it does not know. Every change to its shape, an added optional field
included, is a `⚠️ Breaking changes` item for `stitchkit/application` in the changelog.

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
