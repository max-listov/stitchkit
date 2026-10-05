---
title: "ADR 0224: Shared IO primitives have one owner"
description: Files is extended explicitly, canonical JSON preserves bytes, commands use a neutral mechanism, a retry requires recipient authority.
type: decision
status: active
created: 2026-10-01 20:44 +07:00
updated: 2026-10-01 21:03 +07:00
---

# ADR 0224 — Shared IO primitives have one owner

## Decision

Files atomic/managed writers use a single publication owner. The default atomic
file fsync is kept; directory durability and create without overwrite are chosen
explicitly. A post-publication error carries published=true. A managed read gets
opt-in leaf/link/stability checks and observed metadata; trusted ancestors do not
become hostile containment because of additional path checks.

The canonical JSON production API belongs to primitives and delegates to the
existing serializer. The shared plain-JSON validation is reused by durability and
by the canonical boundary. UTF-16 sorting and manual assembly of members preserve
the historical digest bytes; the strict public boundary has finite depth/nodes/bytes.

Finite native commands belong to the neutral process owner. The agent-runtime
adapts it through the existing sandbox policy with mandatory limits. A new process
entrypoint starts as evolving. Binary IO, environment policy, streaming caller
lifetime and bounded cleanup are declared explicitly. The native leaf does not
become a supervisor/PTY and does not promise to kill descendants that left the
POSIX group.

## External effects

Append-before-run and process-local in-flight are not an interprocess atomic claim.
Existing local-step durability requires a caller-owned execution lease and keeps
the sticky uncertain state. The existing domain-event outbox gives an
application-owned atomic claim and delivered/retryable/terminal/unknown; it is a
different protocol and does not automatically replace the indexed receipt store
and recipient reconciliation.

A hash of absence, a timeout, a missing local row or a null does not prove that the
old recipient request will not complete later. A shared verified-absence retry is
rejected without a recipient-side fence or a stable idempotency capability. No
second delivery engine is created and the at-most-once promise is not extended.
Reconcile must release the caller's await on abort/deadline and ignore a late result.
