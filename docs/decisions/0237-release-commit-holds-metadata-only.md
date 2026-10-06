# 0237 — The release commit holds release metadata only

**Status:** Accepted
**Date:** 2026-10-05

Builds on ADR 0136. Invariants I8 and I14.

## Decision

A release tag points at the head of the default branch. That head is the
`release(train): <summary> in X.Y.Z` commit of the train, or fix commits with their own
conventional types stacked directly on it.

The release commit holds release metadata only: package versions, changelogs, `release-train.json`,
the lockfile, the promoted migration sections and the maturity-cadence sentences that rolling a
changelog moves. It is never empty. Every feature and fix is a separate commit before it, with a
conventional subject (`feat(scope): …`, `fix(scope): …`) and a body that says what changed and why.

After a red candidate, the repair is a commit with its own type on the release branch. The tagged
head must still have a green exact-SHA push run, so a repair needs a green run of its own before
the tag. An empty commit is refused wherever it stands. A repeated `release(train)` subject over
source changes is not a release commit and is refused.

The rule is enforced at three places that share one implementation (`scripts/release-subject.ts`):
`pre-push` for a pushed release commit, `release:train` before the first tag, and the publishing
workflow's `assert-subject` step.

## Why

Every commit used to wear the release subject so that the tag could sit on it. A release
collapsed into one commit of unrelated changes, `git bisect` and `git revert` could only act on a
whole release, repairs needed release subjects, and one empty commit carried a tag. The tag needs
the exact-SHA CI evidence and a head the release commit shaped; it does not need every change to be
named after the release.

## Consequences

- `git log` of a release shows one commit per change and one metadata commit.
- A release commit that carries source or documentation changes is refused before it is pushed.
- The window searched below the tagged head is 50 first-parent commits.

## Amendment — the work is not split per change

The release commit's rule stands: it holds release metadata only. The sentence "every feature and
fix is a separate commit before it" is withdrawn: a release's work is committed before the release
commit as one commit, or as many as the work needs, each with a conventional subject
(`feat(scope): …`, `fix(scope): …`) and a body that says what changed and why. Nothing refuses a
release for how its work was divided; `scripts/release-subject.ts` refuses only a release commit that
carries more than metadata.
