---
title: "ADR 0118: Operation capacity belongs to the underlying work"
description: "Process-local admission combines finite global and per-key budgets atomically, and a caller timeout never releases capacity still used by underlying work."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0118 — Operation capacity belongs to the underlying work

## Context

Application admission answers whether the process is ready and tracks accepted
work. It does not express a global concurrency cap, a per-key cap, or bounded
rate windows. Reimplementing those counters in handlers and workers creates
different refusal and release races.

A caller deadline is especially dangerous: its Promise can settle while an
upstream operation ignores cancellation and continues consuming the scarce
resource.

## Decision

`createBoundedAdmission` is a process-local, no-queue lease mechanism. It
atomically evaluates global concurrency/rate and optional per-key
concurrency/rate/max-key budgets, then optionally acquires the existing
application admission lease. A refusal rolls every local reservation back.

Rate windows use an injected monotonic clock and return `retryAfterMs` only when
the oldest retained sample establishes it. Concurrency refusals do not invent a
retry time.

`run` may stop waiting on caller abort or timeout and signals the work, but the
lease remains active until the work actually settles. `release` is idempotent;
`drain` reports real remaining work; `force` closes admission and reports what
is still physically active rather than pretending to terminate it.

## Consequences

- HTTP handlers and independent local workers can share the same finite
  accounting without importing agent or domain policy.
- Per-key and rate registries retire records after their active/sample lifetime,
  so declared bounds remain meaningful.
- There is deliberately no hidden waiting queue or distributed lock claim.
- Applications translate refusal reasons into their own protocol response.
