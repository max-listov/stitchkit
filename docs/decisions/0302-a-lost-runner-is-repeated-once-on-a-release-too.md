---
title: "ADR 0302: A lost runner is repeated once on a release run too"
description: The CI retry repeats a push run once, like the nightly run, when every unproven lane carries GitHub's own runner-loss marker; a code failure, a pull request and a second attempt stay red.
type: decision
status: accepted
created: 2026-11-22 07:34 +08:00
updated: 2026-11-22 07:34 +08:00
---

# ADR 0302 — A lost runner is repeated once on a release run too

Serves **I9**. Changes the retry rule recorded in [`ci-release.md`](../architecture/ci-release.md).

## Context

The CI retry repeated only the nightly run when GitHub never assigned a runner or shut one down
mid-job. A push run — the exact-SHA evidence a release reads — was never repeated, so a release
candidate whose macOS lane lost its runner had two exits: a person repeated the run by hand, or the
release stopped on a defect that did not exist. 0.124.5 was published from a manual repeat, with
nothing recording why; the rule said it could not happen.

## Decision

The retry repeats a `push` run by the same rule as a `schedule` run: once, its first attempt,
concluded `failure`, and only when every unproven lane carries GitHub's own loss marker and no
other lane failed. The repeat is `rerun-failed-jobs` of the same run: the same SHA and plan, the
lost lanes and the aggregates that refused them. A pull request is not repeated; a code failure and
a second attempt stay red.

A manual repeat of a candidate is recorded by the release operator with its reason.

## Consequences

- A lost runner no longer stops a release, and no release is published from an unrecorded manual
  repeat.
- The evidence a release reads is still the code's own: the repeat runs the same SHA, and a
  failure in code never qualifies.
- The rule and its practice agree again; a repeat that is neither appears nowhere.
