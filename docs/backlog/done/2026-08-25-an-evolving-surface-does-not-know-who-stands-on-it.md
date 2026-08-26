---
title: An evolving surface does not know who stands on it
description: ADR 0103 lets an evolving entrypoint be redefined in any minor, and nothing tells the maintainer whether anyone is standing on it or how far behind they are.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 19:21 +0000
---

## Зачем

ADR 0103 says an **evolving** entrypoint may be redefined in any minor, with a
marked breaking change and a migration section. That is the right rule and it is
not in question. What is missing is the thing that makes it safe to exercise.

`stitchkit/agent-runtime` has taken a breaking change in **five of the eight
minors** since it shipped in 0.56.2 — 0.57, 0.59, 0.60, 0.62, 0.63. Two of those
were made in a single afternoon, and one of them added a **ninth member to
`AgentRuntimeStore`**, which every application implementing the aggregate
directly must add by hand.

Twice during that afternoon the argument "nobody depends on this yet" was
offered in support of breaking it. **The argument was factually wrong at the
time it was made** — a consuming project had already built on
`createAgentRuntime`, with its own durable store adapter and a conformance-backed
test suite, and was pinned four minors back. The decisions themselves stand,
because they were taken against ADR 0103 and explicitly *not* against a
headcount; that was the right instinct and it is why nothing has to be revisited.
But the near miss is the point: an argument that would have been decisive was
both available and false, and nothing in the repository could have contradicted
it.

### What is actually missing

Not telemetry, and not a registry of consumers — the package is on a public
registry and cannot enumerate who installed it. Three cheaper things:

- **A cadence the surface declares.** "May be redefined in any minor" is a
  permission, not a plan. Five breaks in eight minors is a rate, and a consumer
  deciding whether to build on the surface is really asking for the rate, not the
  permission.
- **A cost signal in the changelog entry.** "Adds a member to an interface an
  application may implement" and "adds an optional field" are both `⚠️ Breaking`
  today, and they are not remotely the same amount of work downstream. A reader
  planning an upgrade across four minors cannot see which ones will cost a day.
- **A way to check an adapter against the current contract without upgrading.**
  The store conformance kit exists and is public; nothing says "run this before
  you bump" or fails usefully when the interface has grown.

## Результат

- The evolving declaration carries an observed cadence, not just a permission.
- A breaking entry says what it costs a consumer, not only what changed.
- Upgrading an `AgentRuntimeStore` implementation across minors has a mechanical
  first step that reports what is missing.

## План

- [x] Decide what the maturity table publishes beside "evolving" — a break rate,
      a last-broken version, or a stability window. Whatever it is, it must be
      derivable from the changelog rather than maintained by hand, or it rots.
- [x] Decide a cost marker for breaking entries and apply it to the ones already
      written. Candidate axis: does this change require the consumer to write
      code, or only to re-read a value?
- [x] Make the store conformance kit runnable as a pre-upgrade check, and say so
      in `docs/guide/upgrading.md`.
- [x] Write down, in ADR 0103 or its successor, that "no consumer depends on it"
      is never an argument for breaking an evolving surface — the ADR is the
      authority precisely because it does not depend on a fact nobody can check.

## Acceptance

- [x] The maturity table shows the cadence and a test fails when it drifts from
      the changelog.
- [x] Every `### ⚠️ Breaking changes` item carries its cost marker, checked by a
      gate rather than by review.
- [x] `docs/guide/upgrading.md` names the pre-upgrade conformance step.

## Что сделано

### Cadence, derived rather than maintained

- [x] `scripts/surface-cadence.ts` derives from the changelog how often an
      evolving surface has actually been redefined. The entrypoint table in
      `docs/guide/getting-started.md` carries the sentence beside "evolving".
- [x] **The first hand count was wrong.** It said five of eight; the derived
      figure is **six of eight**, because one release worded its breaking entry
      differently. ADR 0111 was corrected before it was accepted. That is the
      whole argument for deriving it — a number kept by hand beside a table is a
      number that rots, and this one rotted inside an hour.
- [x] `scripts/surface-cadence.test.ts` fails when the table and the changelog
      drift, so a release that breaks the surface again cannot leave the table
      claiming otherwise.

### A cost signal on breaking entries

- [x] `assertBreakingAudience` in `scripts/release-plan.ts`, wired into the
      release gate: a `### ⚠️ Breaking changes` section must open with a
      `**Who must act:**` line. "Adds a member to an interface an application may
      implement" and "adds an optional field" were both `⚠️ Breaking`, and are
      not remotely the same amount of work downstream.
- [x] The line is first in the section on purpose — a reader skimming for the
      cost never has to read the change to find it.
- [x] Applied to the sections already written for 0.63.0 and `[Unreleased]`.
      History is not retrofitted; the gate is for what ships from here.

### The pre-upgrade check

- [x] `docs/guide/upgrading.md` → *Before you bump, if you implement an agent
      store*: run `runAgentStoreConformance` on the version you are leaving and
      again after. Green then red names what the contract grew, in one run,
      instead of one failure at a time in production.

### The rule that made this necessary

- [x] Written into ADR 0103 itself: **"no consumer depends on it yet" is never an
      argument for redefining an evolving surface.** A package on a public
      registry cannot enumerate who installed it, so the claim is unfalsifiable
      in principle — and it was made twice in one afternoon here and was false
      both times.

### Tests

- [x] `scripts/surface-cadence.test.ts` → `counts a minor once however many
      patches broke it`, `a breaking section about another surface does not
      count`, `the maturity table carries the figure the changelog supports`
- [x] `scripts/release-plan.test.ts` → `a breaking section says who has to act`
      (four cases, including that this repository's own notes pass)

### Что не сделано

- [x] No telemetry and no consumer registry. A public registry cannot enumerate
      installs, and pretending otherwise would rebuild the unfalsifiable claim
      this task exists to retire.
- [x] Cost markers on historical breaking entries. The gate applies to what
      ships from here; retrofitting thirty versions would be archaeology, and a
      marker guessed after the fact is worth less than none.
