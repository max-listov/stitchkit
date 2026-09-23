# 0198 — Stable is earned, and kept on a budget

**Status:** Accepted
**Date:** 2026-09-23

Amends [ADR 0103](0103-entrypoints-declare-their-maturity.md) and is read together
with [0111](0111-the-driver-is-the-extension-point-and-the-runtime-is-not-stable-yet.md).
Invariant I14.

## Context

ADR 0103 split the entrypoints into **stable** and **evolving** so a consumer can
tell how often a surface moves. It then detached the word from any consequence:

> The level changes no versioning policy. A minor still carries breaking changes
> and a patch is still additive, uniformly, for every entrypoint.

The changelog shows what that costs. In the thirty days before this decision
there were 83 releases, and 34 of them carried a `### ⚠️ Breaking changes`
section. Several of those broke entrypoints the table calls stable. Every
breaking minor is a manual migration in every consuming project, and the
consuming projects this repository's owner can see sit on five different
minors, the furthest about forty minors behind. At this pace "stable" describes
how a surface was meant to behave, not how it behaves, and the road to 1.0 —
which the roadmap defines as API stability — does not get shorter.

Two things were missing. **What makes an entrypoint stable** was never stated:
a new entrypoint could be declared stable on its first day, with nobody outside
this repository using it. And **what stable costs the maintainer** was nothing,
so nothing slowed a break down.

The tempting fix — count who imports each entrypoint and demote or remove the
unused ones — is closed twice over. ADR 0103: "Demotion does not exist." ADR
0111: "no consumer depends on this yet" is never an argument, because a package
on a public registry cannot enumerate who installed it. A usage count can
justify *not yet promoting*; it can never justify taking a promise back.

## Decision

### Stable is earned

1. **A new entrypoint starts evolving.** Declaring it stable on arrival is no
   longer possible.
2. **Promotion to stable requires two independent consumers** — two consuming
   applications with their own owners and release cycles, each importing the
   entrypoint in production code. This repository's own tests, examples and
   starter template do not count, and neither do two services of one
   application. The promoting ADR (ADR 0103 already requires one) records the
   count and what was measured. It does not record names: consuming projects
   are not named in this repository.
3. **No demotion and no removal on a usage count.** A stable entrypoint with one
   known consumer, or none, stays stable. The census that feeds rule 2 is only
   ever read in the direction of promotion. This keeps ADR 0103 and ADR 0111 as
   they are.
4. **Runtime mirrors are exempt from rule 2.** `stitchkit/node` is the Node
   face of `stitchkit/server`: the same handler, hooks and contract served
   through another runtime. Its shape is not found on its own — it follows
   `/server`, which earns stability on its own terms. Requiring separate Node
   consumers would give an application on Node a weaker promise than the
   identical surface on Bun, for reasons that have nothing to do with the shape.
   A mirror is stable exactly when the entrypoint it mirrors is.

The entrypoints that are stable today stay stable. The maturity table in
`docs/guide/getting-started.md` remains the one place a level is declared, and
the budget below reads it from there.

### Stable is kept on a budget

5. **A stable entrypoint may be broken in at most one minor per rolling seven
   days.** The window runs over release dates, taken from the changelog headings
   (`## [x.y.z] — YYYY-MM-DD`), and is anchored on the date of the release being
   judged, not on the clock — a tag re-checked a month later gets the answer it
   got when it was cut. One minor that breaks several stable entrypoints spends
   the budget once: the budget is on migrations, and a consumer moves across a
   minor in one pass. So the cheap way to stay inside it is the right one — batch
   the breaks.
6. **Every breaking entry that touches a stable entrypoint cites an ADR**
   (`→ ADR NNNN`). One consolidating ADR may authorise several entries.
7. **Evolving entrypoints break freely**, as ADR 0103 allows, and spend no budget.
8. **Every new breaking entry starts with the entrypoint name(s) it breaks**,
   backticked, before anything else:

   ```md
   - `stitchkit/tools`, `stitchkit/contract` — **`createMcpHandler` no longer
     accepts `foo`** — it moved to `bar` because … → ADR NNNN
   ```

   This is what makes the feed separable — a reader of one entrypoint greps for
   its name — and it is the only thing the budget classifies by. The words of an
   entry are not matched against anything; the prefix is.

### This amends ADR 0103

ADR 0103's sentence "The level changes no versioning policy" no longer holds
for stable entrypoints: from this decision, stable carries the cadence limit of
rule 5 and the citation rule of rule 6. The rest of that paragraph still holds —
a minor carries breaking changes and a patch is additive, uniformly, for every
entrypoint. ADRs are not edited; the index row for 0103 points here.

### Effective from 0.94.0

The rules above bind releases from **0.94.0** on. Earlier releases are not
counted and their entries are not reformatted: they were written under a rule
that did not exist, and counting them would refuse the very release that
adopts this one. 0.94.0 itself counts, so the first release the budget can
refuse is the one after it.

### Held mechanically

`bun run release:check` prints, for the core version in the release train,

```
stable breaking: N in 30 days, M in 7 days (budget 1)
```

and the same metadata gate — `release:check`, the `pre-push` hook on a release
commit or tag, and the publishing workflow — refuses a release from 0.94.0 on
when:

- it breaks a stable entrypoint and more than one minor, itself included, did so
  within seven days of its date;
- one of its breaking entries does not start with an entrypoint from the
  maturity table;
- one of its entries for a stable entrypoint cites no ADR;
- it breaks a stable entrypoint and its heading carries no date, so the window
  cannot be measured.

The count, the classification and the effective version live in
`scripts/surface-cadence.ts`, beside the cadence figures the maturity table
already derives from the changelog.

## Consequences

- A stable break now waits for a free week or joins the minor that already
  spent it. That is the intended pressure: fewer, larger migrations.
- A new entrypoint pays for its early freedom with a promotion ADR later. It
  keeps that freedom until real consumers exist, which is when a stable promise
  starts to matter.
- A breaking section reads as a list of entrypoints, and one consumer can skip
  the entries that are not theirs.
- The count trusts the prefix. An entry that names an evolving entrypoint while
  in fact breaking a stable one escapes the budget. That is a review question,
  as the no-`as` rule is: the gate makes the claim explicit and checkable, it
  cannot make it true.
- The budget can be spent by an urgent fix. A security fix that must break a
  stable entrypoint in a spent week is a reason for a new ADR, not for a
  silent exception in the gate.

## Alternatives considered

**Demote or remove what nobody imports.** Closed by ADR 0103 and ADR 0111, and
unfalsifiable for a public package.

**Leave the policy unwritten and rely on restraint.** That is the arrangement
the thirty-day figures above measure.

**Budget by release count instead of by date.** A release count shrinks when
releases slow down and grows when they speed up. A consumer migrates by the
calendar, so the window is a calendar one.

**Match breaking entries to entrypoints by their vocabulary**, as the cadence
figures do. It works for a figure a person reads, and it fails silently when
the vocabulary is too narrow: the agent-runtime term list has been widened four
times for exactly that reason. A refusal needs a classification that cannot
miss, so the entry states it.
