---
title: An input cannot join a run already in flight
description: A message arriving mid-run can only queue behind it or end it; there is no supported way to hand it to the loop between tool calls and keep the run going.
type: task
status: inbox
created: 2026-08-25
updated: 2026-08-25
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

- [ ] Read the related task first — it settles the vocabulary (`supersede`) and
      the axis this one sits on.
- [ ] Decide whether the accept path grows a `running` run's inputs directly, or
      a separate durable operation records the absorption. The CAS invariants in
      `store-driver.ts` currently refuse the first.
- [ ] Decide what happens when the run ends before the step boundary is reached
      — the input must not be lost, so it presumably falls back to a queued
      successor.
- [ ] Decide whether the absorbed input reaches the loop as a projected history
      message or as `prepareStep` `messages`, and what an application-supplied
      `prepareStep` sees.

## Acceptance

- [ ] A test shows a run absorbing an input mid-flight, continuing, and ending
      with both inputs in `inputMessageIds`.
- [ ] A test shows the fallback when the run ends first: the input is answered,
      not dropped.
- [ ] Both submitting tickets resolve to the same terminal result.
