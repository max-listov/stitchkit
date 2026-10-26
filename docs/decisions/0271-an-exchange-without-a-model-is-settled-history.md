---
title: "ADR 0271: An exchange without a model is settled history"
description: "A keyed seed with placement 'after-settled' writes an exchange that happened without a model after the settled history and ahead of any active run; drivers apply it as an anchored insert."
type: decision
status: accepted
created: 2026-10-26 19:53 +07:00
updated: 2026-10-26 19:53 +07:00
---

# ADR 0271 — An exchange without a model is settled history

**Invariants:** I8, I14, I15. Extends [ADR 0178](0178-instructions-carry-a-role.md).

## Context

A consuming project executes a confirmed direct command (a voice "turn the lights off") without a
model and answers with a receipt. The conversation's agent must know it happened on the next turn.
The store had no write for that: `seedConversationInput` puts user instructions at the head of
history; a run without a model (`acceptInputAndAssignRun` + `acquireRun` + `commitRunTerminal`)
conflicts with a run in flight, and a failure between those calls leaves an active run that
recovery continues with a model; `appendEvent` writes the event log, which neither the model nor
compaction reads. So the project called a no-tools model once per command just to record it, and
without that call kept the facts in process memory, lost on restart.

## Decision

The keyed once-only seed is the one write of history no run owns; it gains a `placement`.
Absent or `'lead'` keeps ADR 0178's instructions at the head. `'after-settled'` takes committed
`user` and completed `assistant` messages without a `runId` and places them after the settled
history and ahead of the first message of any active run (queued or running: its input, or its
answer once checkpointed). With no active run that is the tail. The seed receipt makes it exactly
once per key and outlives compaction, as for instructions.

Placed there, an active run's input and answer stay adjacent, and the next run reads the
exchange before the input it was queued behind. The run in flight does not see it: its prompt was
assembled before the exchange existed.

Drivers receive the placement as one new history mutation, `insert`: a message ahead of the active
row `beforeMessageId`, or at the end when absent; a message already present is replaced in place.
The memory and SQLite stores, the Prisma example and `runAgentStoreConformance` carry it.

## Consequences

A command completed without a model costs one store transaction and no provider call, survives a
restart, and reaches the model, compaction and branch replay like any history. A custom driver must
handle `insert` (a breaking change of `AgentRuntimeStoreDriver`, migrated in 0.113.0). Proven in
`packages/core/tests/agent-settled-exchange.test.ts` (an exchange written while a run is held in
its provider call lands ahead of that run's input; the next request carries it) and in the
conformance kit's settled-exchange scenario.
