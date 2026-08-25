---
title: Where a reconciled cost belongs
description: Whether a later-known provider figure may be attached to a closed run, and whether that belongs in the core at all.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 14:59 +0000
related: docs/backlog/in-progress/2026-08-25-an-abandoned-run-under-reports-what-it-spent.md
---

## Зачем

Whether a provider bills for a call that was aborted mid-flight cannot be known
inside the process. The authoritative number arrives later, from the provider's
own accounting. So a figure the runtime reports as `unavailable` stays
`unavailable` forever unless something can attach the real one afterwards.

The obvious shape — amend the terminal run — runs into the store's central
invariant. A terminal run is an absorbing state: `commitRunTerminal` requires
`running | interrupt_requested`, `checkpoint` requires `running`, `recoverRun`
requires `queued | running | interrupt_requested`. Nothing may touch a run once
it is terminal, and the fencing and CAS design is built on that.

Worse than the guard is the coupling. Every mutation CASes the **conversation
head**, so a late billing write would bump the conversation version and make a
concurrent `replaceCompactedRange` conflict — and a conflicting compaction
discards the summary it just paid a model to produce. **An accounting event would
be able to throw away a model-generated summary.** That is the decisive argument
against the mutation shape, independent of taste.

The append-only shape avoids it but is the expensive one: a new driver namespace,
a new table, its own pagination and its own conformance coverage — a genuine
second write path for every adapter. The cheap shape has the bad coupling and the
good shape is costly, which is itself a signal about where this belongs.

**And it may not belong here at all.** ADR 0002 keeps billing out of the core;
`VISION.md` says "optional application runtime, not a job platform". Reporting
what the runtime observed is unambiguously ours — nothing else can see it.
Accepting an externally-sourced authoritative number, storing it against a closed
record and answering questions about it is a ledger. The tell is the question
this needs answered next: what happens to a reconciled figure for a run the
application can no longer find — a retention question, which is a ledger's
question, not a runtime's.

The application already has everything it needs to do this itself: a durable,
externally-resolvable `runId`, and an honest per-run figure once the related task
lands. The provider's later accounting joins on `runId` in a table the
application owns.

## Результат

- A written decision, as an ADR, on whether a reconciled cost may enter the core
  at all — and if not, the guide says where it goes instead and how to join.

## План

- [x] Write the ADR. The recommendation from both plan validators is "no, this
      lives in the application"; the ADR must argue it rather than assert it, and
      must survive the obvious counter-argument that the core already stores
      conversation state so one more column is free.
- [x] If the answer is yes: append-only, keyed by `runId`, **outside** the
      conversation aggregate and with no head CAS, precisely so accounting can
      never conflict with a conversation operation.
- [x] Pre-empt the follow-on requests in the same ADR: the core records a
      currency, it never converts one; it never aggregates, attributes per user,
      or enforces a budget.
- [x] Either way, document the join in `docs/guide/agent-runtime.md`.

## Acceptance

- [x] ADR in `docs/decisions/` + row in `docs/decisions/README.md`.
- [x] The guide shows the reconciliation join, wherever it was decided to live.

## Что сделано

- [x] ADR `docs/decisions/0110-a-reconciled-cost-belongs-to-the-application.md`
      + row in `docs/decisions/README.md`. The answer is **no** — a reconciled
      cost is the application's ledger, joined on `runId`.
- [x] The argument is made rather than asserted, and rests on a mechanism rather
      than taste: every store mutation compare-and-swaps the conversation head,
      so a late billing write could conflict a concurrent
      `replaceCompactedRange` into discarding a summary it had just paid a model
      to produce. An accounting write must not be able to do that.
- [x] The counter-argument is answered: the append-only shape avoids the
      coupling and costs a new driver namespace, table, pagination and
      conformance entry — a second write path in every adapter, for data the
      core has no other reason to hold.
- [x] The shape is fixed in advance in case it is ever revisited: append-only,
      keyed by `runId`, outside the conversation aggregate, no head CAS.
- [x] Three follow-on requests pre-empted in the same ADR: the core records a
      currency and never converts one; never aggregates; never enforces a budget.
- [x] `docs/guide/agent-runtime.md` → `### Reconciling with the provider's own
      accounting` shows the join, including that a row is written even when the
      figure is `unavailable` — that row is what the later figure attaches to.

### Что не сделано

- [x] No code. The deliverable was a decision, and the decision is that the core
      gains nothing.
