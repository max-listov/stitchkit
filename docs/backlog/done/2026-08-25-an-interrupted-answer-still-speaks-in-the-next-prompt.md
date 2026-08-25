---
title: An interrupted answer still speaks in the next prompt
description: A run aborted by a newer user input keeps its half-sentence in history and sends it to the provider, and there is no policy that discards it.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 12:46 +0000
---

## Зачем

`AgentInputPolicy` has two values, `queue` and `interrupt`, and `interrupt`
does not mean what an application reaching for it expects. It aborts the active
run — and keeps everything that run produced.

The shape that exposes it needs no domain at all:

1. A user sends a message. The runtime starts a run and the model begins an
   answer that will take ten seconds.
2. Eight seconds in, the same user sends a second message that redirects the
   conversation. The first answer is now addressed to a question that has been
   withdrawn.
3. The run is aborted. Its partial assistant is committed with
   `status: 'interrupted'` and a `control: 'run-interrupted'` part
   (`terminal-commit.ts` `interruptedCandidate`, and the plain abort path in
   `run-execution.ts` through `assistantStatus`).
4. The next run projects history — and sends that partial to the provider as an
   ordinary assistant turn.

Step 4 is the defect, and it is worse than "a stale sentence is included":
**the projection drops the control marker.** `projectAgentHistoryDetailed`
omits only `streaming` and `failed` messages, and `assistantMessages` reads
`text`, `reasoning`, `tool-call` and `tool-result` — `control` is not among
them. So the model receives a confident half-sentence with nothing to mark it
as cut off, and continues a thought the user has already abandoned.

Proven, not read:

```text
projected: [
  { role: 'user',      content: 'Привет' },
  { role: 'assistant', content: 'Здравствуйте! Мы команда, куда вы хотите' },  // ← interrupted
  { role: 'user',      content: '…' },
]
decisions: a1 → { action: 'projected', reason: 'projected' }
```

An `interrupted` message is `action: 'projected'`. The marker that says it was
interrupted is silently gone.

So today's `interrupt` is the **soft** mode wearing the **hard** mode's name,
and the hard mode does not exist.

### The axis this actually turns on

The tempting fix — "omit interrupted assistants from the projection" — is
wrong, because two interruptions that look identical inside the runtime have
opposite correct answers:

- The user pressed **stop**. The half-answer was streamed to their screen; they
  read it. Dropping it from history makes the conversation lie to the model
  about what the user has seen.
- A newer input **superseded** the run. Whether the half-answer reached anyone
  depends entirely on the delivery surface — a token stream shows it as it is
  produced, a messenger sends nothing until the run is done.

**Whether the partial was delivered is a fact the runtime cannot observe.** It
belongs to the transport the application owns. That is what makes this a
declared policy rather than a default the core can pick, and it is the part of
the pattern that has not been worked out anywhere: the question is never "was
the run interrupted" but "did anyone see what it produced".

### The third mode, and the one that moved out

Three behaviours are wanted when input arrives during a run. Where each stands:

| behaviour | today |
| --- | --- |
| **queue** — finish the run, then take the next input | `inputPolicy: 'queue'` |
| **interrupt** — end the run, keep what it produced | `inputPolicy: 'interrupt'` |
| **supersede** — end the run, discard what it produced, restart with every pending input | **absent — this task** |
| **inject** — do not end the run; add the input between tool calls | absent — its own task |

`inject` used to be a paragraph here. It is now
[`2026-08-25-an-input-cannot-join-a-run-already-in-flight`](../inbox/2026-08-25-an-input-cannot-join-a-run-already-in-flight.md),
because a mode that exists only as a note in another task's open questions is a
mode that gets lost.

### What already works and must not be rebuilt

Three parts of the wanted behaviour are already correct, and the task must
leave them alone:

- **Aborting the active run on a newer input** — `coordinator.ts:175`.
- **Carrying several user messages into one run** —
  `AgentRun.inputMessageIds` is an array and `runs.coalescePending` appends to a
  queued successor atomically (`store-driver.ts` `reduceStore`, `accept`).
- **Per-input choice of mode** — `inputPolicy` already accepts
  `(input) => AgentInputPolicy`, which is the seam an application uses to give
  one conversation surface a different policy from another. The core does not
  need to know which surface is which, and must not learn.

Even without the coalescing, the redirected user's two messages both reach the
next prompt: the first run committed its input before it was aborted. The
missing piece is only the assistant half.

### Is this ours to ship?

Yes, and narrowly. `docs/VISION.md` places the process-local execution protocol
and the typed persistence boundary inside the runtime, and admission policy is
already there — `inputPolicy` exists. What stays outside is every product
decision on top of it: which conversation surface gets which mode, whether an
operator may configure it, and what a user is told when their answer is
discarded. Those are the application's, expressed through the function
`inputPolicy` already accepts.

## Решения

Three questions were open when this task was written. All three are closed, and
the reasoning is recorded because two of them decide the release calibre.

### A superseded run gets its own terminal reason

`'superseded'` joins `AgentTerminalReasonSchema`, with the matching
`AgentRunState` and `AgentMessageStatus`. Not `'interrupted'` plus a flag.

A flag would collapse exactly the two states this task exists to separate, and
collapse them in the field an operator reads first when reconstructing what
happened to a conversation. The separation *is* the deliverable; encoding it as
a modifier on the value it must be distinguished from gives the record back its
ambiguity one layer down.

This is breaking for anyone matching on a terminal reason, and the minor moves.

**The authority for breaking it is ADR 0103, not a headcount.**
`stitchkit/agent-runtime` is declared *evolving*: its shape may be redefined in
any minor, with a marked breaking change and a migration section, never
silently. That is a property of the surface and it holds no matter who has
installed the package. "Nobody depends on it yet" is a true and useful thing to
know — it is why the cost is low *today* — but it is not a licence, it expires
the first time someone runs `bun add stitchkit` for this entrypoint, and a
package published to a public registry cannot enumerate its consumers. The ADR
does not expire. Decisions that must survive the next release are taken against
the durable reason.

### The default projection of an interrupted assistant is marked, not bare

The first draft of this task said the projection rule should default to
"today's behaviour, so nothing changes for a consumer that does not opt in",
while the item beside it said to stop dropping `control` silently. Those two
cannot both hold: today's behaviour *is* the silent drop. The draft handed the
reader a contradiction instead of a decision.

Resolved in favour of the marker. **Compatibility with a defect is not
compatibility** — it is the defect, kept, with a promise attached. A consumer
who does nothing gets the fix.

So there is one rule, not two: an assistant message that ends `interrupted` is
projected *with its interruption legible to the model*. The option chooses the
form; it does not choose whether the fact survives.

### What form the marker takes, and why the role matters

Two forms are worth having, and the difference between them is not cosmetic.

- **`'assistant-marked'` (default)** — the partial stays an assistant turn, with
  the interruption marked inside it. This is right for what `interrupt` means
  today: the user pressed stop, the text was streamed to their screen, they read
  it. The assistant turn is the truthful record of what the human saw, and the
  model should stay consistent with it.
- **`'system-note'`** — the partial is rendered as a system-role line naming it
  as an abandoned fragment (`[interrupted] partial response: …`) rather than as
  an assistant turn.

The reason to offer the second is structural. **An assistant turn in provider
history is a commitment**: the model reads its own previous turn as something it
said and will stay consistent with it. A system line is context. When the
fragment never reached anyone, consistency with it is the last thing wanted —
and the `interrupted` status alone cannot tell the two apart, which is the axis
above restated at the level of a single message. This form is known to work in a
production agent loop outside this repository.

`supersede` never reaches this question: it omits.

## Результат

- A third input policy that discards, not just aborts: the superseded run's
  partial assistant never reaches the provider.
- `'superseded'` is a terminal reason of its own — visible to an operator as a
  distinct outcome, not inferred from a flag.
- The durable record of a superseded run survives. It is excluded from the
  projection, not deleted — run identity, admission receipts and the terminal
  CAS all depend on it existing, and an operator investigating a conversation
  needs to see what was thrown away.
- An interrupted assistant that *is* projected carries a marker the model can
  read, **by default**, instead of passing as a complete turn.
- Both facts are visible in `AgentHistoryProjectionDecision`, so an application
  can assert which of its messages reached the provider.
- The guide states the axis — delivered or not — rather than listing the enum
  values.

## План

- [x] Add `'supersede'` to `AgentInputPolicy`. It aborts the active run like
      `interrupt` and marks the terminal record so the projection can tell the
      two apart.
- [x] Add `'superseded'` to `AgentTerminalReasonSchema`, `AgentRunStateSchema`
      and `AgentMessageStatusSchema`, and extend `assistantStatus` in
      `terminal-status.ts`. That function is the single home the terminal commit
      and the store driver both check against, so the new value must land there
      and not in a fourth copy; `store-driver.ts` `runStateFor` needs the
      matching arm.
- [x] Teach `projectAgentHistoryDetailed` to omit a superseded assistant, with
      its own decision reason.
- [x] Give `AgentHistoryProjectionOptions` an `interruptedAssistant` rule —
      `'assistant-marked'` (default), `'system-note'`, `'omit'`. There is no
      setting that reproduces today's silent drop; the default is the fix.
- [x] Stop dropping `control` silently in `assistantMessages`. Every part that
      does not reach the provider records an `omitted` decision — a marker that
      vanishes without a trace is what made this defect invisible for a release.
- [x] Confirm `supersede` composes with `coalescePending`: the superseding input
      must land in the successor run, and the aborted run must not be the one
      that receives it.
- [x] Document the pattern in `docs/guide/agent-runtime.md` — the four
      behaviours, the delivered-or-not axis, the per-input function as the seam
      for surfaces with different rules, and the role difference between an
      assistant turn and a system note.
- [x] ADR in `docs/decisions/` + a row in `docs/decisions/README.md`: the
      runtime cannot observe delivery, therefore the discard rule is declared.
- [x] `CHANGELOG.md` under `[Unreleased]` with a `### ⚠️ Breaking changes`
      section (new terminal reason; changed default projection of an interrupted
      assistant), each with a before → after, plus an
      `## Unreleased migration:` heading in `docs/guide/upgrading.md`. The minor
      moves.

## Acceptance

- [x] A test drives the real shape end to end: run in flight, second input under
      `supersede`, and the next run's projected prompt contains **both** user
      messages and **no** fragment of the abandoned answer.
- [x] A test proves the superseded run is still in the snapshot with its parts
      intact — discarded from the prompt, not from the record.
- [x] A test reads `terminalReason` and gets `'superseded'`, distinguishing it
      from an `interrupt` in the same conversation without inspecting a flag.
- [x] A test pins `interrupt` under the new default: the partial is still
      projected, and it now carries a marker. It must fail against today's code.
- [x] A test covers each `interruptedAssistant` value, including that
      `'system-note'` produces a `system` role and not an `assistant` one.
- [x] A test covers `supersede` + `coalescePending` together.
- [x] A test fails if a part is dropped from a projection without a decision
      recording it.
- [x] `docs/guide/agent-runtime.md` describes all four behaviours and names the
      unsupported one. **Not linked, deliberately:** only `docs/guide` and
      `docs/api` are inlined into the published `llms-full.txt`, so a relative
      link into `docs/backlog/` would be dead for every consumer reading it
      there. The bullet asked for a link; a dead link is worse than the name.
- [x] Every claim in the guide is one the code makes true — no mode described
      that a consumer cannot select.
- [x] `bun run verify` green — tree `37e011f1f673`, every lane including the
      Postgres agent-store, the packed consumer and starter lanes and the
      supervised PM2 lane.

## Что сделано

### Runtime — the policy

- [x] `AgentInputPolicy` gained `'supersede'`; `AgentStopReason` gained the
      matching reason so `runtime.stop(key, 'supersede')` is the same decision
      by hand — `packages/core/src/agent-runtime/coordinator.ts`.
- [x] The abort reason is distinct per policy, because it is the only thing that
      survives into the terminal record — `coordinator.ts`,
      `runtime-internals.ts` (`abortTerminalReason`).
- [x] `'superseded'` added to `AgentTerminalReasonSchema`, `AgentRunStateSchema`
      and `AgentMessageStatusSchema` — `schemas.ts`; mapped in the two homes that
      already own those mappings, `terminal-status.ts` (`assistantStatus`) and
      `store-driver.ts` (`terminalState`). No fourth copy.

### Runtime — history

- [x] `interruptedAssistant`: `'assistant-marked'` (default), `'system-note'`,
      `'omit'` — `history.ts`. No setting reproduces the previous silent drop.
- [x] The marker is driven by message **status**, not by a `control` part. The
      abort path that closes the stream instead of throwing commits an
      interrupted assistant with no control part at all, so a part-conditioned
      marker would be missing from exactly the runs a newer input ended.
- [x] `omittedParts` on a projected decision names every part type the
      projection does not stand for — previously `source`, `provider`, `control`
      and unresolved `file` vanished upstream with nothing recording it.
- [x] One home for "may this record still be spoken to the model":
      `isSpeakableAssistantStatus` in `terminal-status.ts`, used by
      `compaction.ts` and consistent with `history.ts` and `prompt.ts`.

### Defects found by the implementation validators, all reproduced before fixing

- [x] A durable `interrupt()` landing between the executor's last read and its
      terminal CAS rewrote `superseded` back to `interrupted`, republishing the
      abandoned fragment into the next prompt — `terminal-commit.ts`
      (`interruptedCandidate` now preserves the stronger decision).
- [x] Compaction read a superseded turn as complete: it fed the discarded text
      to the summariser **and** deleted the record via `replacedMessageIds`,
      contradicting this task's own guarantee — `compaction.ts`.
- [x] `selectAgentHistory` classified a superseded turn as
      `protected-incomplete-turn` — the one class eviction refuses to touch — so
      an abandoned fragment was unevictable and pushed real turns out of the
      budget it never occupied. It is now removed with reason `'superseded'` and
      not counted — `prompt.ts`.
- [x] The guide's `inputPolicy` example did not compile (`AgentRuntimeInput.context`
      is `unknown`). Corrected to narrow through `protocol.parseContext`, and the
      corrected form was typechecked against the project tsconfig before shipping.
- [x] Two widened decision unions were not marked breaking; `AgentStopReason`
      changed with no note and no test; `docs/architecture/agent-runtime.md`
      still listed a closed set of terminal states. All corrected.

### Tests — `packages/core/tests/agent-runtime-supersede.test.ts`

- [x] `the next prompt carries both user messages and no abandoned fragment`
- [x] `an interrupt keeps what a supersede discards, and neither reads a flag`
- [x] `the superseding input lands in the successor, not in the run it ended`
- [x] `compaction neither summarises it nor deletes its record`
- [x] `the token budget evicts real turns instead of protecting an abandoned one`
- [x] `a durable interrupt landing on the terminal commit cannot resurrect the fragment`
- [x] `stop() can take the same decision by hand`
- [x] `every message status is read the same way by every walker` — the
      mechanical guard: enumerates `AgentMessageStatusSchema.options` so the next
      enum member cannot be speakable by default in a walker that forgot it.
- [x] `no part type leaves a projection without a decision naming it` —
      enumerates `AgentMessagePartSchema.options` for the same reason.

### Tests — `packages/core/tests/agent-runtime-history.test.ts`

- [x] `the default marks the fragment where a bare one used to go`
- [x] `the marker follows the status, not a control part that may not be there`
- [x] `a system note is context, where an assistant turn would be a commitment`
- [x] `a system note survives the half-finished tool turn that drops an assistant one`
- [x] `omit keeps the fragment out of the request altogether`
- [x] `a superseded turn is omitted under every setting, and says why`
- [x] `a part no content stands for is recorded instead of vanishing`
- [x] `an unresolved file is named as omitted rather than silently dropped`

### Docs

- [x] ADR `docs/decisions/0108-what-a-stopped-run-said-is-a-declared-policy.md`
      + row in `docs/decisions/README.md`.
- [x] `docs/guide/agent-runtime.md` — the four behaviours, the delivered-or-not
      axis, the per-input seam, the role difference between an assistant turn
      and a system note.
- [x] `docs/architecture/agent-runtime.md`, `docs/api/reference.md`,
      `CHANGELOG.md` (`### ⚠️ Breaking changes`), `docs/guide/upgrading.md`
      (`## Unreleased migration:`).

### Falsification

Every mechanism was reverted in isolation and the suite re-run, so the tests are
known to be capable of failing: the interruption marker (3 tests fail), the
superseded omission (2), `omittedParts` (3), the terminal-commit preservation
(1), the compaction guard (1), the budget exclusion (2).

### Что не сделано

- [x] `inject` — moved to its own task,
      `docs/backlog/inbox/2026-08-25-an-input-cannot-join-a-run-already-in-flight.md`.
      Out of scope by decision: it needs a running run's `inputMessageIds` to
      grow, which the accept path allows only while `queued`.
- [x] `isSpeakableAssistantStatus` is **not** exported from the package. It is
      the internal single home for an internal question; publishing it would add
      public surface this task did not ask for.
- [x] No release. Implementation only, per the instruction that opened this work.
