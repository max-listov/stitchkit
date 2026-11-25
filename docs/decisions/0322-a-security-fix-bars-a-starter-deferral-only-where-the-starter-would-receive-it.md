---
title: "ADR 0322 — A security fix bars a starter deferral only where the starter would receive it"
description: "A core release with a ### Security section may defer the starter HEAD lane only when the starter targets another pre-1.0 minor, and only with a review naming the follow-up starter release, which must be the next train."
type: decision
status: accepted
amends: ["0099"]
created: 2026-11-25
updated: 2026-11-25
---

# ADR 0322 — A security fix bars a starter deferral only where the starter would receive it

Practice. Invariant P. Amends [ADR 0099](0099-starter-head-skips-require-versioned-review.md):
the deferred review it allows gains one rule for a release that carries a security fix.

## Context

ADR 0099 lets an unaligned breaking core release skip the packed local-HEAD starter lane when
`scripts/starter-head-review.json` defers it for that exact core version. A later rule refused
every such deferral when the core release carries a `### Security` section, so that a fix in core
reaches new starter projects in the same release rather than wait behind the review.

That rule assumes the starter would otherwise install the fix. It does only when the starter's
`catalog.stitchkit` range admits the fixed core. Before 1.0 a caret holds one minor: a starter on
`^0.126.0` installs 0.126.x whatever the 0.127.0 release does with the HEAD lane. The fix reaches
new projects only through the next starter release, which advances the catalog with
`bun run update:starter` once the core is on npm — and the starter rides in a later train than the
framework it tracks ([release process](../architecture/release-process.md#two-packages-one-train)).

A breaking 0.127.0 carrying two security fixes met exactly that case: the HEAD template did not
compile against 0.127.0, and a template migrated to 0.127.0 did not compile against the published
0.126.0 — the dual-version conflict ADR 0099 exists for. Refusing the deferral protected no project
and made the fix unreleasable.

## Decision

**A `### Security` section bars a deferral where the starter targets the core's own minor.** There
the starter would install the fixed core, so the HEAD lane must prove the template against it. A
target that is not a pre-1.0 caret range cannot show another minor and is refused the same way.

**On another minor the deferral is allowed only with the follow-up starter it waits for.** The
review names it in `followUp` as `"create-stitchkit@X.Y.Z"`, a version later than
`packages/create-stitchkit/package.json`, and keeps a non-empty `reason`:

```json
{
  "coreVersion": "0.127.0",
  "outcome": "deferred",
  "reason": "One template source cannot build against both the published and the new core.",
  "followUp": "create-stitchkit@0.7.0"
}
```

A security deferral without `followUp` or `reason`, and a `followUp` of another package, another
form or a version not later than the current starter, is refused with its reason
(`starterHeadDecision`, `scripts/release-starter-head.ts`). A release without `### Security` keeps
ADR 0099 unchanged; a `followUp` it records is checked the same way.

**The next train is the named starter.** `release:check` and the pre-push gate read the review in
the newest core release tag. While it names a `followUp` that no `create-stitchkit-v*` tag carries,
they refuse every train that does not publish exactly that version, and refuse it too when its
template range does not admit the deferred core (`scripts/release-starter-follow-up.ts`).

## Alternatives

- **Keep the unconditional refusal.** It blocks the security release itself while the starter
  still cannot carry the fix; the fix reaches nobody sooner.
- **Ship the starter in the same train.** `assertTrainDoesNotOutrunTheStarter` refuses that for a
  reason that still holds: the starter's lockfile cannot resolve a core npm does not serve yet.
- **Leave the follow-up to the operator.** A review that names nothing lets the next train be
  anything; the version in the record is what makes the promise checkable.

## Consequences

- **Operator rule:** the train after a security deferral is the named starter, released right after
  the core publication in the same release session — `bun run update:starter`, migrate the
  template, remove the review, tag it. The [release process](../architecture/release-process.md#two-packages-one-train)
  repeats this rule.
- That train removes the review: once the catalog reaches the core minor, a review left behind is a
  same-minor security deferral and is refused.
- Until the named starter is tagged, no other train passes `release:check`, a core hotfix
  included. A clone without core tags is refused rather than read as "no promise".
- The checks cannot prove "right after" in time: npm publication, the starter's own lanes and the
  tag still take as long as they take. They prove order — nothing else is released in between.
- Negative control: the same `### Security` deferral with the starter on the core's own minor is
  still refused, with or without `followUp` (`scripts/release-starter-head.test.ts`).
