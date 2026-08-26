---
title: "ADR 0113: An absorbed input is committed with the answer, never before it"
description: "inject returns with the absorption written in the absorbing run's terminal transaction, so a run that ends any other way leaves an ordinary queued successor."
type: decision
status: accepted
created: 2026-08-26
updated: 2026-08-26
---

# ADR 0113 — An absorbed input is committed with the answer

## Context

`inputPolicy: 'inject'` — hand a newly arrived input to the loop between tool
calls and let the run continue — shipped in 0.63.0 and was withdrawn in 0.65.0.
An adversarial read found four defects, and all four trace to one ordering
mistake: **the absorption was committed durably at a step boundary, before the
answer existed.**

- `absorbed` became the only run state that was neither active, nor
  recoverable, nor terminal. `listActive` and `scanRecoverable` excluded it,
  `recoverRun` refused it, and no terminal reason could produce it.
- `close()` between the absorb and the answer reported `settled: true` while
  leaving the input permanently unanswerable, invisible to recovery, and its
  idempotency key **refused forever** on retry — the exact case idempotency keys
  exist for.
- The absorb re-projected the whole snapshot, so an unrelated queued input
  reached the model inside a run that never recorded it, and was then answered a
  second time by its own run.
- `inject` with `coalescePending` refused a legitimate submission, because the
  reservation pointed at a run that had since become `absorbed`.

The capability is worth having. It is right whenever the new input refines
rather than redirects and the finished steps are still valuable — the second
message in "summarise this thread… actually, in bullet points" should not throw
away the reading the first one paid for.

## Decision

**Nothing durable happens until the run settles.**

The loop may put a pending input into the *prompt* at a step boundary — that
half was right. What it may not do is write anything about it. The absorption is
a field on `commitRunTerminal`:

```ts
absorb?: { runId: string; inputMessageIds: string[] }[]
```

and it is applied in the same transaction as the terminal record. In that one
transaction the absorbed inputs join the absorbing run's `inputMessageIds`, and
each absorbed run becomes terminal with `terminalReason: 'absorbed'` and
`absorbedIntoRunId` pointing at the run that answered it.

Everything follows from that ordering:

**A run that ends any other way leaves an ordinary queued successor.** A crash,
a `close()`, an interrupt, a failure — none of them commit an absorption,
because the commit is the terminal record itself. The successor is exactly what
every other policy already produces, and recovery already knows what to do with
it. There is no state in which an accepted input is unanswerable.

**Only a completing run may absorb.** An interrupted or failed run took the
input into its prompt and then stopped; it has not answered it. The executor
does not send `absorb` unless the terminal reason completes the run, and the
reducer refuses it if it arrives anyway.

**No new run state.** `absorbed` maps to the `superseded` state, which is
already in every enumeration — terminal, not active, not recoverable. The reason
says which of the two happened; the pointer says where the answer went. Minting
a state was the withdrawn design's first mistake, and it is not repeated.

**No assistant message for an absorbed run.** It produced nothing. Writing an
empty message would be a record claiming this run answered when it did not; its
reserved assistant identity simply stays unused. The answer is reachable through
`absorbedIntoRunId`, and the store follows that pointer itself when a duplicate
submission arrives on the absorbed run's idempotency key — which is what makes a
retry after a restart return the answer instead of an empty terminal record.

**Only the taken admission's own message reaches the prompt.** Not a
re-projection of the snapshot. An unrelated queued input cannot be carried in by
an absorption it has nothing to do with.

**Absorption is whole or not at all, and it is offered, not asserted.** The
registry that tells a run in flight what it *may* take on is process-local and
may be lost to a crash, a close, or a restart without consequence: every entry
in it is also a queued run in the store. At commit time an entry whose run is no
longer queued, or whose input set no longer matches the run exactly, is
**dropped** — the terminal record is not held hostage to a successor's
bookkeeping, and a dropped successor runs on its own.

**Composing with `coalescePending`.** That option lets a third submission join
the queued successor instead of stacking behind it, so one successor can carry
several inputs — and an absorption that covered only some of them would leave a
run that is terminal with inputs nobody answered. So the registry deduplicates
by *input*, not by run, and the executor re-takes at every boundary,
accumulating per run. A coalesced input that arrives before the absorbing run's
last boundary joins the same absorption. One that arrives after it cancels the
absorption, and the successor answers all of its inputs itself — the absorbing
run has then answered one of them too, which is a duplicate answer and never a
missing one.

## Consequences

`inject` is back, with `queue` semantics in the coordinator: it never ends the
run in flight, and the successor is an ordinary queued run until the absorbing
run's terminal commit says otherwise.

The store reducer gained plural effects — `runRecords`, `historyMutations` —
because one mutation now settles two runs. They must be written in one
transaction; a driver that persists one record of the pair fails
`runAgentStoreConformance`.

The executor installs a `prepareStep` hook when injection is possible, and
composes with an application's own. When it is not possible — the configured
`inputPolicy` can never return `'inject'` — nothing is installed and no boundary
does any work, so a runtime that does not use this pays nothing for it.

An absorbed run's ticket resolves through the same path in-process and after a
restart: the coordinator eventually starts it, the executor reads the durable
record, sees `absorbed`, and returns the absorbing run's result. There is one
resolution path, not two, and it is reached from the store rather than from
anything held in memory.
