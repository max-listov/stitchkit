---
title: A zombie owner is gone, and it is the safer half of gone
description: reclaim-stale treats a pid that has exited but not been reaped as gone, because a signal probe reports a table entry rather than a running process, and a zombie's pid cannot have been reused.
type: decision
status: active
created: 2026-09-02
updated: 2026-09-02
---

# 0149 — A zombie owner is gone, and it is the safer half of gone

## Decision

`reclaim-stale` reads the owner's process **state** beside the signal probe, and a pid that has
exited without being reaped — a zombie — is reported as `liveness: 'gone'`. The lock is reclaimed.

The state comes from `/proc/<pid>/stat` where it exists and from `ps -o state=` where it does not.
Where neither answers, the owner is treated as present: a refusal to reclaim is the safe outcome and
is what this probe did before it could see a zombie at all.

`DiagnosticJournalLockDiagnosis['liveness']` does **not** gain a value. `gone` is the truthful
answer, so the union is unchanged and this is a patch rather than a breaking minor.

## Why

`process.kill(pid, 0)` reports an **entry in the process table**, not a running process. A child that
has exited and whose parent has not reaped it keeps its entry, so the signal succeeds for a process
that is provably finished. The probe that exists to prove absence reported the clearest possible
absence as presence.

The consequence is the shape ADR 0147 was written to end, reached by a different door: a lock nothing
can reclaim, a supervisor restarting against it forever, and a refusal telling an operator to find
and kill a process that is already gone. The rename case needed a host to be renamed. This one needs
only a parent that does not reap — which is the normal condition for a supervisor running as PID 1 in
a container.

Reported by a consuming application, which measured `Z` and a successful signal on both platforms of
its fleet and reproduced the refusal against 0.73.0.

### Why not a fourth `liveness` value

The first proposal was a distinct value, because `alive | gone | not-probed` appears to have no way
to say "in the table and already exited". It does: the zombie **exited**. It holds no descriptor and
no lock. For every decision the policy makes, that is `gone`, and no consumer has an action that
depends on telling a reaped exit from an unreaped one. Adding a value would widen a public union —
breaking for an exhaustive consumer — to express a distinction nobody acts on.

### Why this is the safer half of `gone`, not a weakening

The instinctive objection is that the entry still exists, so something might still be there. The
opposite is true, and for that exact reason: **a pid cannot be reused until it is reaped**, so a
zombie entry is provably the owner the lock recorded. The ordinary doubt — "what if this pid now
belongs to someone else?" — applies to the *live* branch, not to this one, and the probe's own
comment already accounted for it: reuse can only turn a dead owner into a live one, so its cost is a
refusal to reclaim, never a reclaim over a live writer.

That pid-reuse property is operating-system semantics, read rather than measured; exhausting the pid
space to observe it would be absurd. What was measured here is that the signal succeeds on a zombie,
and that a lock recorded under one was refused.

## Consequences

- A lock whose owner is a zombie on this machine is reclaimed; a lock whose owner is running is still
  refused, and the refusal still says which refusal it is.
- No refusal text calls a zombie a live process, because no refusal is produced for one.
- `packages/core/tests/diagnostic-journal-lock.test.ts` drives the branch with a real zombie, with
  this running process as the negative control, and through a seam for the `ps` fallback and for a
  command name containing a parenthesis — the case that makes "take the third field" wrong.

## Confirmed on the platform this suite cannot execute

The `ps` branch exists for darwin, and a Linux run reaches it only through the seam. The consuming
application that reported the defect ran it on real macOS against the published 0.74.1, with a real
zombie and waiting for the state rather than for a duration:

```
own lock, zombie owner -> RECLAIMED
own lock, LIVE owner   -> REFUSED
pre-identity lock      -> REFUSED
```

The second line is why the first means anything: the guarantee did not weaken, a running owner is
still refused. The third is theirs rather than ours — a lock carrying no identity is `unattributable`
and deliberately not probed here, so they probe it on their side, and there a zombie is named as one.

Recorded because the note above says "through a seam", and a later reader would otherwise be right to
think the darwin path had never run.
