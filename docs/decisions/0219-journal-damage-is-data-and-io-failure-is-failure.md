---
title: "ADR 0219: Journal damage is data, an IO failure is an error"
description: "One shared bounded reader keeps valid frames and reports anomalies explicitly; the startup writer restores diagnostics from the saved generations."
status: active
created: 2026-09-30 17:41 +07:00
updated: 2026-09-30 17:41 +07:00
type: decision
---

# ADR 0219 — Journal damage is data, an IO failure is an error

## Context

The writer already rotates an unfinished active file as a whole. But a NUL tail
kept in an archive breaks a consumer that calls `JSON.parse` on every line.
The `partialTails` counter describes only the current run and does not explain
archived damage. The cause of the NUL is unknown; `flush()` does not promise `fsync`.

## Decision

One `readDiagnosticJournal` in the filesystem leaf reads finite snapshots with a
bounded line buffer. The shared frame schema and schema-backed results stay in the
pure application part. Valid frames pass the owner's `eventSchema`; damaged lines
produce separate anomalies with the cause, file, byte offset/line and the size of
the skipped part. Access errors, an unsafe file type and truncation throw.
A valid frame without a trailing LF stays available together with a warning.

The startup writer uses the same reader under an exclusive lock. The check of
historical events is limited to the JSON/frame contract. The recovery status keeps
counts and the first/last anomaly; a repeated start restores it from the saved
files. A damaged active file is rotated as a whole with the usual finite retention.
`maxFiles: 1` refuses before any data is deleted and releases the lock
(amended by ADR 0240: by default the journal quarantines such a file and starts;
the refusal is the `onStartupRefusal: 'fail'` policy).

## Alternatives and verification

Silently ignoring invalid rows hides the loss of evidence. Separate consumer
parsers split the rules in two. Truncating the tail destroys the original bytes;
a new quarantine/sidecar registry adds its own lifecycle and storage. The shared
reader and restorable diagnostics give a verifiable result without them.

Real-file tests check NUL in active/.1/.7, restart/append, byte preservation,
oversized/interior rows, torn UTF-8/JSON, schema refusals, a real EACCES, a
symlink, truncation and cleanup on cancellation. Recovery does not become durable
replay and is not sent recursively into a damaged writer. The decision serves I3,
I8, I10 and I13.
