---
title: An input cannot join a run already in flight
description: A message arriving mid-run can only queue behind it or end it; there is no supported way to hand it to the loop between tool calls and keep the run going.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 14:59 +0000
related: docs/backlog/planned/2026-08-25-an-interrupted-answer-still-speaks-in-the-next-prompt.md
---

## Зачем

`AgentInputPolicy` decides what happens to a run when new input arrives, and
every value it has — or will have — ends the run or waits for it. A fourth
behaviour is missing: **hand the input to the loop between tool calls and let
the run continue.**

It is the right behaviour whenever the run is long, its work so far is still
valid, and the new input refines rather than redirects — a correction arriving
while a multi-step task is halfway through, where discarding the completed steps
would be pure loss. That is a different situation from the one the related task
handles, where the new input invalidates what came before.

It is reachable by hand and not supported. `loop.prepareStep` passes the AI SDK
return type straight through, so an application *can* append messages between
steps. But:

- nothing hands `prepareStep` the inputs waiting on the lane — the application
  would have to reach around the runtime and query its own store;
- nothing attaches an absorbed input to the running run's `inputMessageIds`, so
  a run that answered two messages has a durable record claiming it answered
  one;
- the admission ticket for the absorbed input has nothing to resolve against —
  it is waiting for a run that will never start.

That third point is what makes this a durable-record change rather than a hook,
and why it is its own task instead of a plan item in another one: the run record
has to be able to grow an input while it is running, which the accept path
today does only for a run still `queued`.

## Результат

- An input policy that adds the input to the active run instead of ending or
  queueing it.
- The absorbed input is in that run's `inputMessageIds`, so history and
  observability agree with what the model was actually asked.
- The submitting caller's ticket resolves to the run that absorbed it.
- The loop sees the input at a step boundary, never mid-step.

## План

- [x] Read the related task first — it settles the vocabulary (`supersede`) and
      the axis this one sits on.
- [x] Decide whether the accept path grows a `running` run's inputs directly, or
      a separate durable operation records the absorption. The CAS invariants in
      `store-driver.ts` currently refuse the first.
- [x] Decide what happens when the run ends before the step boundary is reached
      — the input must not be lost, so it presumably falls back to a queued
      successor.
- [x] Decide whether the absorbed input reaches the loop as a projected history
      message or as `prepareStep` `messages`, and what an application-supplied
      `prepareStep` sees.

## Acceptance

- [x] A test shows a run absorbing an input mid-flight, continuing, and ending
      with both inputs in `inputMessageIds`.
- [x] A test shows the fallback when the run ends first: the input is answered,
      not dropped.
- [x] Both submitting tickets resolve to the same terminal result.

## Что сделано

### The decision the plan left open

- [x] **The accept path does not grow a running run's inputs.** A new durable
      operation does, and only at a step boundary. The rejected shape —
      attaching the input straight to the running run — has a loss case with no
      honest answer: the run may terminate before the loop reaches a boundary,
      and the input is then recorded as answered by a turn that never saw it.
- [x] **What happens when the run ends first** follows from that and needs no
      special case: the input was queued all along, so the successor simply runs.
      `inject` degrades to `queue`, which is the behaviour every other policy has.
- [x] **How the input reaches the loop:** the re-projected history, returned from
      `prepareStep` as `messages`. An application's own `prepareStep` wins if it
      sets `messages` itself — it is the one that knows why.

### Implementation

- [x] `AgentInputPolicy` gained `'inject'` (`coordinator.ts`). It queues; the
      offer to absorb is process-local and withdrawn the moment the run ends.
- [x] `absorbQueuedRun` — the ninth `AgentRuntimeStore` member, CAS-guarded on
      both runs, moving the successor's `inputMessageIds` into the run answering
      and marking the successor `absorbed` (`store.ts`, `store-driver.ts`).
- [x] `AgentRunState` gained `'absorbed'`; `AgentRun.absorbedIntoRunId` points at
      the run that answered.
- [x] The reducer effect carries **two** run records. It carried one, so the
      absorbed run stayed `queued` in the driver's own store and was absorbed
      again at every subsequent boundary, forever. Found by probe, not by review.
- [x] Both submissions' tickets resolve to the same terminal result, in process.
- [x] `AbsorbQueuedRun`/`AbsorbQueuedRunSchema` exported, listed in
      `docs/api/reference.md` and the public-surface fixture — the build gate
      refuses a type named in a public signature and exported from nowhere.

### Tests — `packages/core/tests/agent-runtime-inject.test.ts`

- [x] `the run in flight takes it at a step boundary and keeps going` — asserts
      both tickets resolve to one turn, both inputs are in `inputMessageIds`,
      both user messages are in history in order, and the provider saw the new
      message only on a step after it arrived.
- [x] `a run that finishes first simply answers it next — nothing is lost`.
- [x] Falsified: disabling absorption fails the first and leaves the second green.

### Что не сделано

- [x] An absorbed run leaves the conversation snapshot. A snapshot carries active
      runs plus those a message references, and an absorbed run never wrote an
      assistant message. The record is durable and reachable by id; what the
      conversation shows is the answering run carrying both inputs. The schema
      comment says so rather than claiming otherwise.
- [x] Cross-process resolution of an absorbed run's ticket. The waiting caller is
      process-local by construction, and `absorbed` is outside every active-state
      list so recovery never re-executes one.
