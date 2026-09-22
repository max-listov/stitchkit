# 0191 — A unit of work is not a request, and must not have to pretend

**Status:** Accepted
**Date:** 2026-09-22

## Context

`RequestContext` required `method` and `path`. Work that never arrived over a
transport therefore had to invent them, and a consuming agent loop wrote
`method: 'AGENT'` — which is not a verb, it is the absence of one recorded in
the field for verbs. The scheduled work beside it did not invent anything and
ran with no context at all, which made `setRequestDimensions` a silent no-op and
left its mutations out of the audit entirely.

## Decision

`method`, `path` and `statusCode` are optional; `kind` (`request` | `job`) and
`name` say what the row describes; `runUnitOfWork` runs such work inside one
context and writes the completion record with the same hand a request's is
written with.

**`statusCode` is the part that was nearly missed, and the reason this is an
ADR.** The obvious change is dropping the fabricated verb. Doing only that, and
still requiring an HTTP status, would have put a second invented transport field
in the same row for the same reason — one lie removed and one left, which reads
as a fix. A job's outcome is `ok`, plus `errorCode` when it failed.

`kind` is written on **every** row, requests and tool calls included. A filter
that has to infer "no `method` means a job" is carrying exactly the implicit
knowledge this field exists to remove.

## Consequences

`auditChanges` keeps a row it cannot examine. A job has no verb, so whether it
changed anything is unanswerable from the row, and an audit filter that silently
drops what it did not look at reports zero — indistinguishable from a system in
which nothing happened.

**What was deliberately not done.** `runInMcpRequestContext` still writes
`method: 'MCP'` and `path: '/mcp/<tool>'`. That is not the same lie: an MCP tool
call arrives as a request, over a transport, naming an operation. The decision
is recorded in that file as well, because six months from now it is otherwise
indistinguishable from an oversight.

A wrapper around the request context with the same fields — "like a request, but
for background work" — was refused. It does not remove the invention, it moves
it inside the library, and `method: 'AGENT'` keeps existing with a better
address.

This is the first breaking change on `stitchkit/observability` since 0.83.0. The
migration names one audience: whoever writes these fields into NOT NULL columns.
