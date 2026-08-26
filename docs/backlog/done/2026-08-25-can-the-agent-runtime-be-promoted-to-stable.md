---
title: Can the agent runtime be promoted to stable
description: ADR 0103 requires its own ADR to promote a surface; a real consumer now exists, so the evidence path is no longer circular.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 19:21 +0000
related: docs/backlog/inbox/2026-08-25-an-evolving-surface-does-not-know-who-stands-on-it.md
---

## Зачем

ADR 0103 says promoting an entrypoint from **evolving** to **stable** is a
decision of its own and needs its own ADR. Nothing has been written, and the
question has been deferred on the grounds that promotion needs evidence from a
real consumer while a real consumer needs a stable surface.

**That loop is already broken.** A consuming project has built on
`createAgentRuntime` with its own durable store adapter, exercised against the
public conformance kit, and it is running. The evidence exists; nobody has
collected it.

What promotion would buy is not comfort. It is that the surface stops being one
an application adopts *despite* the declaration — which is what "evolving" plus a
break in five of eight minors actually asks of someone.

### What has to be true first, honestly

Promotion is not a mood. Three things are open and at least two of them are shape
questions, not polish:

- **`AgentRuntimeStore` is a nine-member interface an application may implement
  directly.** Every member added is a breaking change for that population, and
  three were added in three releases. Either the aggregate stops being a public
  implementation target — the driver is the real extension point and already
  absorbs most growth — or its growth has to slow to something a stable surface
  can promise.
- **`AgentRunEventSchema` is one flat object for three event kinds.** `usage` is
  optional on it because `run-started` has none, so the guarantee "a terminal
  event always carries usage" is a runtime promise the type cannot express. A
  discriminated union by `type` would let the invariant be held rather than
  documented, and that is a breaking change better made before stability than
  after.
- **Two known gaps stay open by decision**, and a stable surface should say so
  rather than leave them to be discovered: a spend figure can still be dropped by
  a bounded sink (recoverable from the run record, but only if you know to look),
  and compaction spend is reported only if the application's own `summarize`
  counts it.

## Результат

- An ADR that either promotes the surface or states what it is waiting for, in
  terms someone can check off — not "when it settles down".

## План

- [x] Collect the evidence that already exists: what the consuming project had to
      write, what broke on each upgrade, and how long each migration took.
      Anonymised — the public repository names no consumer.
- [x] Decide whether `AgentRuntimeStore` remains a public implementation target
      or whether the driver becomes the only supported one. This is the largest
      of the three and probably decides the answer on its own.
- [x] Decide the `AgentRunEvent` shape. If it becomes a discriminated union, that
      lands *before* promotion, not after.
- [x] Write the ADR. If the answer is "not yet", the ADR says what would change
      it, so the next person does not re-derive this from scratch.

## Acceptance

- [x] ADR in `docs/decisions/` + row in `docs/decisions/README.md`.
- [x] If promoted: the maturity table, the guide header and `VISION.md` all move
      in the same pass, and the entrypoint gate agrees.
- [x] If not promoted: the conditions are enumerated and each one is checkable.

## Что сделано

### The evidence, collected

- [x] The loop this was deferred on **did not exist**. A consuming project has
      been running on `createAgentRuntime` with its own durable adapter and a
      conformance-backed test suite the whole time.
- [x] **It implements the driver, not the aggregate** —
      `createAgentRuntimeStore(driver)`. That is measurement, not opinion, and it
      settles the largest of the three open questions.
- [x] Adoption costs roughly a fifth of hand-rolling: ~1 800 lines including a
      509-line adapter, against ~5 000 and ~9 500 for two projects that own their
      loops. Recorded anonymised — the public repository names no consumer.

### The decisions — ADR 0111

- [x] `AgentRuntimeStore` **stops being a supported implementation target.** It
      stays exported and implementable; what changes is that adding a member to
      it is no longer a breaking change, because the supported way to obtain one
      is the driver. Three members were added in three releases and cost the
      driver population nothing — announcing them as breaking told adopters they
      owed three migrations when they owed none.
- [x] **`AgentRunEvent` is a discriminated union by `type`** — implemented, not
      only decided, because the task said it lands before promotion or not at
      all. `usage` is now **required** on a terminal event, so the guarantee that
      lived in prose is held by the schema. The published migration snippet for
      that guarantee did not typecheck; that is what a prose invariant is worth.
- [x] **Not promoted**, with two checkable conditions: one minor with no break to
      the surface, and the two known reporting gaps closed or declared. A stable
      declaration contradicted within a fortnight is worth less than none — it
      teaches a reader that the table lies.

### Implementation

- [x] `AgentRunStartedEventSchema`, `AgentStepFinishedEventSchema`,
      `AgentRunTerminalEventSchema` exported, documented in
      `docs/api/reference.md`, registered in the public-surface snapshot.
- [x] The internal-cause redaction narrows instead of `.omit()` on a union —
      only a terminal carries a cause, and now only that member has the field.

### Tests

- [x] `packages/core/tests/agent-runtime-observability.test.ts` →
      `a terminal event without usage is refused by the schema, not by prose`
- [x] `packages/core/tests/agent-runtime-observability.test.ts` →
      `a field belongs to the kind of event that has it`
- [x] Every existing terminal fixture had to gain `usage` to compile — which is
      the union working, and is why the change is breaking.

### Что не сделано

- [x] Promotion itself. That is the point of the decision, not a shortfall.
- [x] The two conditions are tracked in ADR 0111 rather than as open boxes here;
      the first is satisfied by a release happening, not by work.
