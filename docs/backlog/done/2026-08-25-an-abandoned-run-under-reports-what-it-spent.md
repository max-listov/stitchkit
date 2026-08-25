---
title: An abandoned run under-reports what it spent
description: A run that ends without a provider finish reports no usage at all, and a multi-step one reports its last step as though it were the whole run.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 13:34 +0000
related: docs/backlog/done/2026-08-25-an-interrupted-answer-still-speaks-in-the-next-prompt.md
---

## Зачем

A run costs money whether or not its answer is kept. The runtime's report of that
spend is wrong in three ways, and the worst of them is not on the abandoned path
at all — it is on the ordinary successful one. All three were measured.

### 1. A successful multi-step run reports one step's money as the whole run's

This is the headline, and the first draft of this task missed it by asserting the
success path was correct. `run-execution.ts:561-563`:

```ts
if (part.type === 'finish') {
  const aggregate = normalizeSdkUsage(part.totalUsage);
  usage = { ...aggregate, ...(usage?.cost && { cost: usage.cost }) };
}
```

`normalizeSdkUsage` never produces a `cost`, so the cost carried into the
terminal record is grafted from `usage` — which at that instant holds **the last
finished step**. The SDK's `totalUsage` *is* a sum, so the tokens are right.

Probe — three steps costing $0.50, $1.00 and $1.50:

```text
per-step cost:   [0.5, 1.0, 1.5]        real total 3.00 USD
run-terminal:    tokens 6000 / 600      ← summed, correct
                 cost   1.50 USD        ← last step only, half the truth
                 provenance "provider-reported"
```

Full-run tokens next to one step's money, in one object, both labelled
`provider-reported`. A consumer building spend accounting on this under-reports on **every**
multi-step run, every day, by whatever every step but the last one cost. No
abort required.

### 2. A run that ends without a `finish` reports no usage at all

```json
{ "type": "run-terminal", "terminalReason": "superseded", "durationMs": 25.68 }
```

The `usage` key is **absent**, not zero. So "never reached the provider, spent
nothing" and "burned a minute of the most expensive model and nobody knows how
much" say the same thing. Every usage field already carries
`provenance: … | 'unavailable'` — the word for *we do not know* exists and is
used elsewhere in the same object; the aborted path drops the object instead of
filling it.

### 3. A multi-step run that aborts reports its last step as the run

`run-execution.ts:541` assigns instead of accumulating:

```ts
usage = stepUsage;   // each finish-step overwrites the last
```

Probe — two steps finished (1 000/100 and 2 000/200), abort in the third:
terminal reports **2 000/200**, not 3 000/300, labelled `provider-reported`. On
the success path the following `finish` hides this for tokens. Every path that
ends earlier keeps it: supersede, interrupt, timeout, shutdown, provider failure.

### What the first draft of this task got wrong

Recorded because the corrections are the diagnosis:

- **"The terminal event fires on every path" — false.** Both emits sit inside
  `if (terminalMetrics)`, and `terminalMetrics` is `undefined` when
  `terminal.committedByCaller === false` (`run-execution.ts:624`). A probe that
  abandons a *running* run through `recoverRun` produced two fully finished,
  fully billed steps — 20 000 input tokens — and **zero** terminal rows on either
  channel.
- **"`AgentRunMetrics.partial` already distinguishes a partial run" — false.** It
  is a constant per event kind: `true` on every checkpoint
  (`run-execution.ts:194`), `false` on every terminal including aborted ones
  (`:626`). It says which event you are reading, not what happened to the run.
- **"`cost` is under-reported the same way on aborted paths" — understated.** It
  is under-reported on *all* paths, success included.

### Scope, and what moves out

Both plan validators independently reached the same split, and it is taken:

- **Here:** make the number the runtime reports true — accumulate, label
  honestly, never stay silent. No new store contract, no durable schema change.
- **Not here — `2026-08-25-a-spend-record-that-survives-its-channel.md`:** usage
  has no durable home at all; it lives only on two bounded, drop-on-overflow
  sinks; a requeued run loses its first attempt; compaction spend is invisible;
  checkpoint metrics republish a running total and invite a double-count.
- **Not here — `2026-08-25-where-a-reconciled-cost-belongs.md`:** attaching a
  later-known provider figure to a closed run. A terminal run is an absorbing
  state every store guard depends on, and amending it through the conversation
  aggregate would let an accounting write conflict a compaction into discarding a
  model-generated summary. ADR first; the likely answer is that this is the
  application's ledger, joined on a `runId` the core already gives it.

## Результат

- Cost is the sum of what the steps reported, on every path.
- Token usage on a path that ends before `finish` is the sum of the steps that
  did finish, not the last one.
- A terminal event always carries `usage`. What is unknown says `unavailable`.
- A value the runtime derived says `computed`; only a value the provider handed
  us says `provider-reported`.
- A run terminated by another actor still reports what **this** executor spent.

## План

- [x] Accumulate step usage instead of overwriting: cost, output, reasoning and
      cache tokens sum; input tokens sum too, because the success path already
      publishes the SDK's sum and one field cannot mean cumulative billing on one
      path and peak context on another. Peak context stays derivable from
      `step-finished`, where each step already carries its own input count.
- [x] Sum cost on the success path as well — `totalUsage` has no cost, so the
      graft at `run-execution.ts:563` is the bug, not the abort path.
- [x] Per-field provenance, not one label for the object: a summed field is
      `computed`; a field no step reported stays `unavailable`. A sum containing
      an `unavailable` component is not complete and must not claim to be.
- [x] Emit `usage` on every terminal path, with `unavailable` where nothing was
      reported.
- [x] Emit the **observability** terminal event even when
      `committedByCaller === false` — this executor really spent that money, and
      an operator channel that omits it is why an abandoned run reports nothing.
      Leave the **delivery** `publish` gated as it is: it carries the assistant
      message to the application's transport, and emitting it twice would deliver
      a turn twice. The two channels exist for different readers; only one is
      about spend.
- [x] ADR: the runtime reports what it observed and names what it did not; a
      spend figure never claims a provenance it does not have.
- [x] `docs/guide/agent-runtime.md` — the usage/provenance contract, including
      that a terminal event always carries `usage`.
- [x] `CHANGELOG.md` under `[Unreleased]` with `### ⚠️ Breaking changes`, and a
      `## Unreleased migration:` heading in **`docs/guide/upgrading.md`** (exact
      spelling; the release gate also requires that queue to be empty at release
      time). Changing an accumulated value from `provider-reported` to `computed`
      silently changes the meaning of data a consumer may already filter on —
      `provenance === 'provider-reported'` is the obvious "trust this for
      billing" predicate. The minor moves.

## Acceptance

- [x] A test drives a **successful** three-step run with per-step cost and reads
      the terminal cost as the sum. It must fail against today's code.
- [x] A test drives a multi-step run to abort after two finished steps and reads
      the accumulation, not the last step. It must fail against today's code.
- [x] A test reads a terminal event from a run aborted before any step finished
      and finds `usage` present, every field `unavailable` — distinguishable from
      a run that spent nothing.
- [x] A test pins per-field provenance: summed fields `computed`, unreported
      fields `unavailable`, in the same object.
- [x] A test proves a run terminated by another actor still produces an
      observability terminal event carrying this executor's spend, and does
      **not** produce a second delivery event —
      `an executor that loses the terminal race still reports what it spent`,
      plus `a stolen lease does not erase the spend that preceded it` for the
      sibling path where the commit throws instead of losing.
- [x] No test asserts a number the runtime could not have known.
- [x] `bun run verify` green.

## Процесс

- [x] Two read-only plan validators — both reported; three claims in the first
      draft were false and are corrected above, and the scope split is theirs.
- [x] Task moved to `in-progress/`.
- [x] Implementation.
- [x] Gates.
- [x] Two read-only implementation validators.
- [x] Findings fixed; gates re-run.

## Что сделано

### Runtime

- [x] `addUsage` accumulates step usage — `runtime-internals.ts`. Assigning the
      latest step is what made an abandoned multi-step run report its last step
      as the run, and what made a **successful** one report a third of the money
      beside all of the tokens.
- [x] `mergeRunTotals` merges the SDK's run total per field rather than
      overwriting wholesale, so `normalizeUsage`-supplied reasoning and cache
      counts survive to the terminal event instead of contradicting the run's
      own `step-finished` events.
- [x] `statedUsage` states every field, so a single-step run under a provider
      with no `normalizeUsage` hook no longer omits `cost` entirely while a
      two-step one reports it `unavailable`.
- [x] A run total is `computed`; a step figure is `provider-reported`. The AI
      SDK's `totalUsage` is a sum the SDK performed, not a number a provider
      reported for the run.
- [x] A token floor is `computed`; a cost floor does not exist — one unreported
      step makes the run's cost `unavailable`, and it stays unavailable however
      many steps report afterwards.
- [x] Two currencies, or one cost with no currency, report `unavailable` rather
      than adopting a label.
- [x] The operator terminal event is emitted on paths that used to be silent:
      when this executor lost the terminal CAS, and when the commit **threw**
      because the lease was taken. The delivery event stays gated, because it
      carries the assistant message and would deliver a turn twice.
- [x] A losing executor's event id is qualified by its runtime epoch, so it no
      longer derives the winner's id and get dropped by the sink's default
      deduplication.

### Defects the implementation validators found, all reproduced before fixing

- [x] **Provenance depended on step order.** An unreported step *followed by* a
      reported one kept `provider-reported` on what was really a floor; the same
      two steps the other way round said `computed`. A caller filtering on
      `provider-reported` to decide what to bill against would have billed it.
      This is exactly what ADR 0109 says the code never does — it did.
- [x] **A poisoned cost recovered.** `USD 1 → EUR 2 → USD 4` reported a confident
      `4` for a run that cost $5 and €2, because a floor kept no memory of having
      been poisoned. Cost is now all-or-nothing.
- [x] **A stolen lease erased the spend.** `commitAgentRunTerminal` throws when
      another actor requeues a running run, and the throw was upstream of the
      emit: four fully billed steps, zero rows on either channel.
- [x] **Winner and loser derived the same event id**, so the sink's default
      deduplication silently dropped one of two different spend figures.
- [x] **Adapter-supplied reasoning and cache counts were discarded** by the
      `finish` overwrite — the terminal event contradicted its own step events,
      and the same run reported those fields correctly when aborted.
- [x] **Two published snippets did not compile** (`event.usage.cost` — both are
      optional on a schema shared with `run-started`), and `(n-1)/n` was written
      into an accepted ADR as a general law when the example's own numbers give
      one half.

### One validator finding rejected, with a reason

- [x] A validator recommended merging the two queued `## Unreleased migration:`
      headings into one, on the grounds that the release gate demands an empty
      queue and promoting both yields two identical `## Released migration:`
      headings. `docs/guide/upgrading.md` documents the opposite and is right:
      several queued migrations sitting side by side is the intended state, and
      the release commit promotes them into **one** `## Released migration:`
      with each former heading becoming a `###` subsection. Merging them would
      also have broken the file's own rule against reusing another author's
      heading — the rule that exists because the 0.57.0 migration was lost that
      way. The merge was made and then reverted.

### Tests — `packages/core/tests/agent-runtime-spend.test.ts`

- [x] `a successful multi-step run reports every step of the money`
- [x] `a run that ends before any step finishes says it does not know`
- [x] `the accumulation, not the last step`
- [x] `a stolen lease does not erase the spend that preceded it`
- [x] `an unsettled report cannot wear the identity of a settled one`
- [x] `a sum is computed, however provider-reported its parts were`
- [x] `one step is itself, not a sum of one`
- [x] `a floor is computed whichever step failed to report it`
- [x] `an unknown cost stays unknown however many steps report after it`
- [x] `an unlabelled cost is not assumed to share a currency`
- [x] `a field no step reported stays unavailable instead of becoming zero`
- [x] `two currencies do not add up, and the total says so rather than picking one`
- [x] `an executor that loses the terminal race still reports what it spent`

Plus `packages/core/tests/agent-runtime-terminal.test.ts` →
`settles from the canonical terminal snapshot when another terminal CAS wins`,
updated: it pinned the old behaviour where a losing executor emitted nothing.

### Docs

- [x] ADR `docs/decisions/0109-a-spend-figure-never-claims-a-provenance-it-does-not-have.md`
      + row in `docs/decisions/README.md`.
- [x] `docs/guide/agent-runtime.md` — `### What a run says it spent`, and the
      corrected claim about which channel emits on a lost CAS.
- [x] `CHANGELOG.md` `### ⚠️ Breaking changes`; `docs/guide/upgrading.md`
      `## Unreleased migration: a run reports what it spent`.

### Что не сделано, и куда ушло

- [x] Durability and channel loss — `docs/backlog/inbox/2026-08-25-a-spend-record-that-survives-its-channel.md`.
      Usage is nowhere durable, both sinks drop under load, a requeued run loses
      its first attempt, compaction spend is invisible, and checkpoint metrics
      now carry running totals that must not be summed.
- [x] Late reconciliation — `docs/backlog/inbox/2026-08-25-where-a-reconciled-cost-belongs.md`.
      ADR first; a terminal run is an absorbing state, and amending it through
      the conversation aggregate would let an accounting write conflict a
      compaction into discarding a paid-for summary.
- [x] A provider failure reported as `policy_stop` — found during validation,
      unrelated to this change and predating it:
      `docs/backlog/inbox/2026-08-25-a-provider-failure-reports-itself-as-a-policy-stop.md`.
- [x] Cost is summed in float64; twenty steps at $0.10 give
      `2.0000000000000004`. Recorded here rather than fixed: the schema has no
      decimal type, and introducing one is its own decision.
- [x] No release, no commit, no deploy — per the instruction that opened this
      work.
