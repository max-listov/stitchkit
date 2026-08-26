---
title: A condition that rewards not looking
description: ADR 0111 gates promotion on a minor with no breaking change, which a surface nobody reads satisfies perfectly; replace it with evidence that a deliberate adversarial read found nothing.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 01:53 +0000
related: docs/backlog/done/2026-08-25-can-the-agent-runtime-be-promoted-to-stable.md
---

## Зачем

ADR 0111 named two conditions for promoting `stitchkit/agent-runtime` from
evolving to stable. The first is wrong, and it was written yesterday.

> **A minor with no breaking change to the surface.** Not a promise to stop
> breaking it — evidence that it has stopped.

It is not evidence of that. **A break rate measures how hard the surface was
being read, not how settled its shape is**, and a surface nobody examines scores
perfectly. The repository already contains the counter-example: **0.61.0 broke
nothing in `/agent-runtime`** — not because it had settled, but because that
release's work was in the application kernel and realtime. The condition was
already satisfied once and meant nothing.

Worse, it is satisfiable on purpose. "Deliberately do not touch it for one
minor" meets the letter and proves the opposite of what it claims.

### What the breaks actually were

Twelve breaking items across 0.62, 0.63 and 0.64, and **not one of them is a
change of mind about the shape.** Every one is a repair of something the surface
was asserting falsely: cost under-reported on every multi-step run; `usage`
absent where it meant "unknown"; a discarded fragment reaching the model;
enums that could not tell a supersede from an interrupt; a provider failure
reporting itself as a policy stop; `partial` meaning nothing; an invariant the
type could not express.

Three of four releases broke the surface because three of four releases had
someone reading it closely, and every close read found something real.

### The two questions that got conflated

- **What does adopting this cost me?** The break rate answers this honestly. A
  consumer pays a migration whether the break was a repair or a redesign. This
  is why the cadence figure belongs in the entrypoint table and stays.
- **Have we found the bottom?** The break rate says nothing about this, and the
  first condition asked it in the break rate's language.

## Результат

- The promotion condition is evidence that the surface was **read and found
  clean**, not evidence that it was left alone.
- One such read is performed, adversarially, and its outcome is acted on:
  either the surface is promoted, or the findings are fixed and the read is what
  the next attempt has to beat.

## План

- [x] Rewrite condition 1 in ADR 0111. It becomes: an adversarial read of the
      whole surface, by reviewers who did not write it, returning nothing that
      would justify a break. Say plainly why a break count cannot stand in for
      it, and keep the cadence figure for the question it does answer.
- [x] Run that read. Independent lenses, read-only, over the whole of
      `packages/core/src/agent-runtime` and the public surface it exports —
      contract truthfulness, invariants that live in prose, durability and
      recovery, concurrency, and the store/driver boundary.
- [x] Act on the outcome without deciding it in advance. Findings are fixed and
      the surface stays evolving; nothing found means the second condition is
      the only one left and promotion is written up.
- [x] Whatever the outcome, record what the read covered, so the next attempt
      raises the bar instead of repeating it.

## Acceptance

- [x] ADR 0111 no longer contains a condition satisfiable by neglect.
- [x] The read happened and is recorded — what was examined, by how many lenses,
      and what came back.
- [x] Every confirmed finding is either fixed with a regression test or
      explicitly declared with a reason.
- [x] `bun run verify` green.

## Что сделано

### The condition

- [x] ADR 0111's first promotion condition rewritten: **an adversarial read that
      finds nothing worth breaking for**, by reviewers who did not write the
      surface. The old one — "a minor with no breaking change" — is satisfiable
      by neglect, and 0.61.0 had already satisfied it for a reason that proved
      nothing. The cadence figure stays, for the question it does answer.
- [x] Written into ADR 0103 as a standing rule that "no consumer depends on it
      yet" is never an argument.

### The read

Four independent lenses, read-only, each told to find defects rather than
confirm quality: **invariants living in prose**, **durability and crash
consistency**, **concurrency and lifecycle**, **the consumer's experience against
the published package**. Together they read all twenty files of the module, the
guide, five ADRs, three releases of changelog, the reference Prisma adapter and
the conformance kit; wrote and ran roughly forty throwaway probes; and one of
them built a working consumer application against published 0.64.0.

**Outcome: not promoted.** Over forty findings, the great majority reproduced.

### What the read found, and what was done

- [x] **A compacted conversation could not run at all.** `ai` refuses a
      system-role entry in `messages`, and the projection put `system` and
      `summary` records there — so every run after a compaction failed, and
      `interruptedAssistant: 'system-note'` did the same. Live in 0.62.0 through
      0.64.0. Fixed: the projection returns `system` separately and the executor
      feeds the instructions channel. The suite had stayed green because the
      projection tests asserted *shape* and never handed the result to a
      provider — `agent-runtime-provider-valid.test.ts` now does.
- [x] **`inject` withdrawn.** Four findings, one ordering mistake: the
      absorption committed durably before the answer existed. Redesign filed.
- [x] **`recoverRun` destroyed the run's spend and reset its fencing token** —
      the one path that exists to recover from a crash. A validator built a lease
      steal on the second half and overwrote a live answer with a zombie commit.
- [x] **A run record must now agree with itself**; `runStateForTerminalReason`
      exported so a caller derives the state rather than guessing it.
- [x] **`AgentRunMetrics.usage` required** — the invariant was held on one of
      two channels.
- [x] **`idleTimeoutMs` defaults to 60 000** — there was no default, so a hung
      stream held the lane forever.
- [x] **`context_overflow` replaces the dead `tool_failure`** — this runtime's
      own refusal stopped reporting itself as a provider failure.
- [x] **Durable events stop reporting phantom gaps**; transient events keep the
      one that is real.
- [x] **The budget stops protecting records the model never hears** — the 0.62.0
      fix had named one status; three walkers now share one home.
- [x] **Compaction may not replace a live run's assistant message.**
- [x] **`scanRecoverable`'s reference cursor no longer restarts at the
      beginning** when the run it names leaves the recoverable set.
- [x] **The conformance kit stopped certifying blind**: fencing round-trip,
      stale token, foreign owner, `scanRecoverable`, durable interrupt.
- [x] **`ACTIVE_AGENT_RUN_STATES` exported** — driver authors were hardcoding it.
- [x] Documentation corrected where it contradicted the code: durable spend,
      the policy count, the entry-point example that did not typecheck, the
      missing MCP peer in the install line, `partial`'s retired meaning, the
      one-directional independence claim, and the reconciliation snippet that
      read the droppable channel instead of the durable one.
- [x] **A regression in my own fix, twenty minutes old**, caught by the third
      lens: carrying the whole candidate through a reason change made an
      interrupted run durably name a stop policy that had not stopped it.

### What was deliberately not fixed, and where it went

- [x] `docs/backlog/inbox/2026-08-26-an-input-that-joins-a-run-needs-the-absorption-to-be-atomic-with-the-answer.md`
- [x] `docs/backlog/inbox/2026-08-26-one-surface-two-provenance-vocabularies.md`
- [x] `docs/backlog/inbox/2026-08-26-loadsnapshot-is-the-only-history-read-and-it-is-unbounded.md`

### What the read covered, for the next attempt to beat

- [x] Not reached by any lens, recorded so the next read starts here: a live
      PostgreSQL run of the conformance kit; a genuine multi-process fencing
      race; `compaction` racing an absorb; `persistGeneratedFile`, file/source
      /reasoning parts, tool-approval parts, `runs.key`, and the OpenRouter
      adapter against a real provider.

### Вердикт

- [x] **Промоушен не выдан.** Условие отработало ровно так, как должно: разбор
      нашёл дно не там, где его искали. Второе условие — объявленность известных
      пробелов — теперь выполнено; первое требует чтения, которое вернётся
      пустым, и это чтение ещё не случалось.
