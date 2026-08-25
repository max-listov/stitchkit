---
title: "ADR 0108: What a stopped run already said is a declared policy, not a default"
description: "The runtime cannot observe whether a partial answer reached anyone, so whether it stays in the conversation is declared by the application rather than chosen by the core."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0108 — What a stopped run already said is a declared policy

## Context

`AgentInputPolicy` had two values. `queue` finishes the run in flight first;
`interrupt` ends it. `interrupt` ended the run and kept everything it had
produced: the partial assistant was committed with `status: 'interrupted'`, and
the next run's projection sent that partial to the provider as an ordinary
assistant turn.

Worse than including a stale sentence, it included one that did not look stale.
`interruptedCandidate` appends a `control: 'run-interrupted'` part, and
`assistantMessages` rendered `text`, `reasoning`, `tool-call` and `tool-result`
— `control` was not among them. The marker was dropped on the way upstream. The
model received a confident half-sentence with nothing to say it had been cut
off, and continued a thought the user had already redirected.

So a third behaviour was wanted: end the run **and** discard what it produced.
The tempting shape was a projection rule — "omit interrupted assistants" — and
it is wrong, because two interruptions that are identical inside the runtime
have opposite correct answers:

- The user pressed **stop**. The partial was streamed to their screen and they
  read it. Dropping it makes the conversation lie to the model about what the
  human has seen.
- A newer input **superseded** the run. Whether the partial reached anyone
  depends entirely on the delivery surface: a token stream shows it as it is
  produced, a surface that sends nothing until the run is done never showed it.

## Decision

**Whether a stopped run's output stays in the conversation is declared by the
application, because the fact it turns on is not observable from inside the
runtime.**

That fact is delivery, and delivery belongs to the transport. The runtime sees
an abort; it cannot see a screen.

Three consequences follow.

**A third input policy, not a flag on the second.** `supersede` ends the run
like `interrupt` and marks the terminal record so the projection can tell them
apart: `terminalReason: 'superseded'`, run state `'superseded'`, assistant
status `'superseded'`. A boolean beside `'interrupted'` would collapse exactly
the two states this separation exists to hold apart, in the field an operator
reads first. The separation is the deliverable; encoding it as a modifier on the
value it must be distinguished from returns the ambiguity one layer down.

**Discarded from the prompt, never from the record.** A superseded run keeps its
parts in the snapshot. Run identity, admission receipts and the terminal CAS all
depend on the record existing, and an operator reconstructing a conversation
needs to see what was thrown away. "Discard" is a statement about the projection
only.

**The projection states what it did.** An interrupted turn that *is* projected
says so to the model, by default. Any part of a projected record that no
projected content stands for is named in that record's
`AgentHistoryProjectionDecision`. There is deliberately no setting that
reproduces the previous output: a silent drop is the defect, not a behaviour to
stay compatible with.

The form of the marker is itself a choice, and the reason is structural. An
assistant turn in provider history is a **commitment** — the model reads its own
previous turn as something it said and stays consistent with it. A system line
is context. `'assistant-marked'` is right when the human read the text;
`'system-note'` is right when the fragment reached nobody. That is the same
axis, restated at the level of one message.

## Consequences

The core learns no product policy. Which conversation surface gets which mode is
expressed through the function `inputPolicy` already accepts — one application
can hold a surface that always supersedes and one that queues, and the runtime
never learns which is which. → ADR 0002.

`AgentTerminalReasonSchema`, `AgentRunStateSchema` and
`AgentMessageStatusSchema` each gain a member, which is breaking for an
exhaustive switch, and the minor moves. The authority for breaking it is
ADR 0103: `stitchkit/agent-runtime` is declared **evolving**, so its shape may be
redefined in any minor with a marked breaking change and a migration section.
That is a property of the surface and does not depend on who has installed the
package — deliberately not "no consumer depends on it yet", which is true today,
cheaper to say, and expires the first time someone runs `bun add`.

A fourth behaviour stays out of scope: handing the input to the loop *between
tool calls* without ending the run. It needs pending inputs delivered to
`prepareStep` and attached to a running run's `inputMessageIds`, which the
accept path does today only for a run still `queued` — a durable-record change
of its own size, tracked separately.

## Alternatives considered

**A projection rule with no new policy.** "Omit interrupted assistants" is one
line and answers the wrong question — it cannot distinguish the stop button from
a supersede, which is the entire distinction.

**A boolean on the interrupted state.** Additive, and it puts the answer back
out of reach in the field an operator reads first.

**Letting the core infer delivery.** It would have to know whether the transport
streams, which is the domain knowledge ADR 0002 keeps out of the core.
