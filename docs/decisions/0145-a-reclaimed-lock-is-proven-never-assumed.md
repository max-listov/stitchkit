---
title: A reclaimed lock is proven, never assumed
description: The diagnostic journal may reclaim an abandoned lock only from a liveness check on the recorded owner, and no age-based reclaim is offered at any price.
type: decision
status: active
created: 2026-09-01
updated: 2026-09-01
---

# 0145 — A reclaimed lock is proven, never assumed

## Decision

`createDiagnosticJournal` accepts `lock: 'refuse' | 'reclaim-stale'`, defaulting to `refuse`.
`reclaim-stale` reclaims a present lock **only** when the recorded owner is provably gone. The
lock file carries `{ pid, host, acquiredAt }`, and the proof is a liveness check —
`process.kill(pid, 0)` answering `ESRCH`. Every other answer refuses: `EPERM` is a live process
under another user, a foreign `host` is a process this machine cannot probe, and an unreadable or
ownerless lock establishes nothing.

**No timeout, age or heartbeat variant will be added.** This is the part worth writing down,
because it is the request that will keep arriving: an age threshold is easy, and every consumer
who has just been woken by a stuck daemon will ask for it.

## Why an age threshold is the wrong instrument

The lock exists to keep two live writers off one ordered journal. The only case it exists for is
therefore the one an age threshold cannot see: a writer that is alive but slow — paused on a full
disk, descheduled, stopped in a debugger, blocked on a network filesystem. Time cannot separate
that writer from a dead one, so a threshold does not make the reclaim safer; it moves the failure
from "the service will not start" to "two writers corrupted the sequence", which is the failure
the whole mechanism was built to prevent. A guarantee traded for a heuristic reads as an
improvement exactly until the first interleaved journal.

The liveness check has a residual risk and it points the safe way. A recycled PID can only make a
**dead** owner look alive, because the owner records its own identity; so the check errs toward
refusing to reclaim, never toward reclaiming over a live writer. A false refusal costs an
operator one `rm`; a false reclaim costs the journal's only guarantee.

## Consequences

- An unattended service restarted by its supervisor after `SIGKILL` recovers without a human,
  which is the case that motivated the option.
- The default is unchanged, so nothing about an existing deployment moves.
- `getStatus().lock` reports the policy and whether this journal started by reclaiming, so a
  reclaim is visible in diagnostics rather than silent.
- A lock written before this ADR carries no owner record. It is never reclaimed — correctly:
  absence cannot be established from a file that says nothing.
- The same shape applies to any future file-backed exclusive resource in this repository. The
  rule is the instrument, not the journal: prove the owner is gone, or refuse.
