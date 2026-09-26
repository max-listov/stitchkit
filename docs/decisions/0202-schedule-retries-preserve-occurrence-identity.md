---
title: "ADR 0202: Schedule retries preserve occurrence identity"
description: "Indexed retry eligibility, bounded dispatch and fenced settlement share one durable schedule row."
type: decision
status: accepted
created: 2026-09-26 15:50 +07:00
updated: 2026-09-26 15:50 +07:00
---

# ADR 0202 — Schedule retries preserve occurrence identity

## Context

A failed delivery must not become immediately due again: this turns a persistent refusal
into CPU load and an unbounded event stream. Moving the occurrence's due time to implement
backoff loses its cadence and lateness. A lease alone does not fence a late result or a
stale selection made before another process advanced the row.

## Decision

The SQLite schedule row owns three distinct times: `next_at` for the occurrence,
`retry_at` for retry eligibility and `claim_until` for exclusive attempt ownership.
The generated `eligible_at` is their maximum. A partial `(eligible_at, id)` index over
scheduled rows serves the next timer and due batches of at most 32 rows. Claims recheck
eligibility, occurrence, due time and attempt count inside `BEGIN IMMEDIATE`.

Each dispatch has a unique claim token, a 60-second lease and a 30-second deadline.
At most 32 dispatches run concurrently per service; one slow dispatch does not serialize
its batch. The service owns one next-due timer and one deadline timer per in-flight
attempt. A hung batch yields within 30 seconds; newly due work is considered then.
`AbortSignal` requests cancellation; it cannot forcibly stop uncooperative consumer code.
A consumer must honor cancellation and bound its own resources.

A resolved `void` means delivery succeeded. A typed `{ status: 'retry', reason }` or a
throw retries the same occurrence after 1, 2, 4, 8, 16, 32, then 60 seconds, capped at 60
seconds without a maximum attempt count. A typed `{ status: 'terminal', reason }` stops
the entire schedule, including recurring schedules, in `failed` state. Failures record
one `schedule/failed` event per accepted attempt, with attempt count and retry time;
terminal failure sets `terminal: true` and no retry time. There is no polling event.

Settlement checks state, token, unexpired lease, occurrence and original due time before
any write or event. Cancellation and stale results do not produce `schedule/fired` or
`schedule/late`. Successful delivery advances the occurrence, clears retry diagnostics
and coalesces missed periodic slots arithmetically onto the original cadence.

Storage failures reach `onError` and arm one recovery timer with the same bounded delay.
Idle ticks do not open write transactions. Diagnostic retention remains the store owner's
policy; retry pacing bounds amplification but does not impose an event retention policy.

## Delivery boundary and migration

The idempotency key `schedule:<id>:<occurrence>` survives retries and process failure.
Admission in a consumer and scheduler settlement are separate transactions: delivery is
**at least once**. Consumers must durably deduplicate that key; neither a lease nor a
local timeout provides exactly-once side effects.

SQLite v4 adds retry columns and indexed generated eligibility transactionally, preserving
existing schedules, due times and active claims. Migrate with old scheduler processes
stopped: they do not understand retry eligibility or `failed`. Rollback requires a backup
from before migration; older runtimes refuse a future schema version. No second store is
introduced. The runtime remains a separately bounded product (I4, I8, I10, I13, I15).
