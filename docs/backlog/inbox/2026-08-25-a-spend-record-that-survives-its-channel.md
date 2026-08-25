---
title: A spend record that survives its channel
description: Usage exists only on two bounded fire-and-forget sinks and nowhere durable, so a dropped event is a lost number with nothing to recover it from.
type: task
status: inbox
created: 2026-08-25
updated: 2026-08-25
related: docs/backlog/in-progress/2026-08-25-an-abandoned-run-under-reports-what-it-spent.md
---

## Зачем

The related task makes the reported spend figure *true*. This one is about
whether anyone still has it a second later. Four findings, all reproduced.

**Usage is nowhere durable.** `AgentRunSchema` has no usage or cost field, and
nothing writes usage into the assistant message's `metadata` (probed: it is
`undefined`). The figure exists only on the observability `AgentRunEvent` and the
delivery `AgentRuntimeEvent`, both in-memory and transient.

**Both channels drop it under load, by design, and neither prioritises it.**
`createBoundedSinkManager` is FIFO with a capacity of 1 000 by default and drops
on overflow. A probe forced the drop:

```text
DROPS:   [{ reason: 'capacity', type: 'run-terminal',
            usage: { inputTokens: 100000, cost: { value: 12.5, currency: 'USD' } } }]
WRITTEN: ['run-started']
```

The event carrying nothing survived; the one carrying $12.50 was dropped. With
no durable copy this is unrecoverable — `onDrop` hands the event back, but a
handler that persists it is the durable home this task is about, invented by
every consumer separately.

**A requeued run loses its first attempt.** `recoverRun({ action: 'requeue' })`
rebuilds the run as `queued`; the executor restarts with `usage = undefined`. The
crashed attempt's tokens were only ever in an event its executor never lived to
emit. Not a double-count — a total loss. Nothing accumulates across attempts, and
nothing names the attempt.

**Compaction spend is invisible.** `config.history.compact()` runs inside the run
and calls the application's `summarize()` — a real provider call — with no usage
channel back, no `step-finished`, and no run of its own. `maxAttempts` can pay
for it repeatedly on CAS conflict, all unreported. Either there is a channel back
or the guide must say plainly that compaction spend is the application's to
measure; silence is the current state and it is the worst of the three.

**Checkpoint metrics invite a double-count.** Every `assistant-checkpoint`
republishes the *current* value of the same running variable, so a consumer
summing checkpoint metrics over-reports by roughly the checkpoint count. Once
accumulation lands, checkpoints will carry growing partial sums and the trap
sharpens. `partial` is not a usable guard: it is a constant per event kind, not a
statement about the run.

## Результат

- A spend figure survives the loss of the channel that reported it.
- Checkpoint and terminal figures cannot be summed into a wrong number by a
  reasonable consumer.
- Compaction spend is either reported or explicitly declared out of scope in the
  guide.
- A recovered run's spend is either accumulated across attempts or the loss is
  documented as a property, not left as a surprise.

## План

- [ ] Decide where a durable figure lives: a field on `AgentRun`, the assistant
      message metadata, or nowhere-by-decision. This is a durable-record change
      and needs a line in the store conformance kit, not just a test.
- [ ] Decide whether a spend-carrying event may be dropped at all — a separate
      unbounded path, a drop that is itself an event, or an explicit statement
      that `onDrop` is the contract.
- [ ] Make `partial` mean something about the run, or replace it. Today it says
      which event kind you are holding.
- [ ] Decide checkpoint semantics: cumulative-so-far or delta. Whichever, say it
      where a consumer reads it.
- [ ] Compaction: a usage channel back from `summarize()`, or a written boundary.
- [ ] Recovery across attempts: accumulate, or document the loss.

## Acceptance

- [ ] A test drops a terminal event and shows the figure is still recoverable —
      or the guide states it is not, and a test pins the stated contract.
- [ ] A test sums checkpoint metrics the way a naive consumer would and shows the
      result is either correct or impossible to obtain.
- [ ] A test covers a requeued run's reported spend against the documented rule.
