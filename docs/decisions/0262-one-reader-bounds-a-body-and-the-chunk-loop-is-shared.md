---
title: "ADR 0262: One reader bounds a body, and the chunk loop is shared"
description: "readBoundedBody is the public reader of a stream up to a byte limit; every in-core reader of that job runs on one chunk loop."
type: decision
status: accepted
created: 2026-10-17 12:07 +07:00
updated: 2026-10-17 12:07 +07:00
---

# ADR 0262 — One reader bounds a body, and the chunk loop is shared

**Invariants:** I8, I10, I12.

## Context

Reading a stream no further than `maxBytes`, stopping on an abort and cancelling the
source is a small loop with sharp edges: a read that never settles after an abort, a
lock released under a pending read, a cancellation that is awaited on a transport that
never settles it, an abort that must win over the empty-body answer. The framework had
that loop five times (request JSON text, the unix client, connection responses, the
capped download and the sandbox gateway), with different answers on those edges, and
an application had to write a sixth.

## Decision

`readBoundedBody(source, { maxBytes, signal?, limitError, abortError? })` in `stitchkit`
and `stitchkit/http` returns the bytes. It never reads past `maxBytes` plus one chunk,
cancels the source when the limit is crossed and when the signal aborts, answers a
`null` body with an empty result, and lets the caller choose both errors. A body of
exactly `maxBytes` is read.

Inside the core there is one chunk loop, `chunksOf`, which the line readers and the
bounded reader both run on. It races a read with the abort, requests a cancellation
without awaiting it after an abort, and releases the lock only when no abort left a read
pending. The in-core readers of this job — the request text reader, the unix client
body, connection responses, the capped download and the sandbox gateway — run on it and
map its outcome to their own errors. Readers with a different job keep their own code:
an SSE frame reader (a frame limit, a per-chunk accounting hook), the file and
publication writers (a limit checked before a chunk is accepted, feeding a sink) and the
multipart file parts (a text field of a multipart body does use the bounded reader).

A body read that no limit bounded is a defect of the same kind, so the readers that serve
a boundary use the reader with a default: a raw route's `parseBody` reads 1 MiB (a stricter
default than the unbounded read it replaces, so a marked break, with `{ maxBytes }` to raise
it), the authorization server's `/token` and `/register` read 64 KiB (`maxRequestBodyBytes`),
and the audit row reads a request clone up to `payloadMaxBytes`, by default the handler's
`maxJsonBodyBytes`. Each limit is a positive safe integer, refused otherwise, and each cut that
is only observed rather than answered is recorded (`payloadTruncated`).

## Consequences

An application that accepts a body from a socket uses the framework's reader instead of
its own copy, and a fix to the edges lands once. The edges are covered by one test file
and by the installed-package lane on Bun and Node.
