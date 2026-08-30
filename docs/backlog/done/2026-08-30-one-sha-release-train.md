---
title: One-SHA package-aware release train
description: Validate and publish every package selected for one release from one exact tree without serial platform waits or duplicated lanes.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
priority: P0
---

# One-SHA package-aware release train

## Problem

Every package release currently creates a new release commit and pays for the same whole-repository
CI. The portable framework job also waits for both Darwin builders before it starts, although only
publication assembly needs their binaries. Darwin then runs the complete packed consumer suite to
qualify one contained-files fixture, and the starter matrix runs both published-target and packed-
HEAD modes even when only one can differ. A multi-package release therefore serialises independent
work and repeats equivalent work on identical bytes.

## Plan

- [x] Make one checked-in release manifest the source of the targets and versions carried by a
      `release(train)` commit; every selected tag may point at that same exact SHA.
- [x] Plan CI from the release manifest or changed paths and emit explicit portable, TUI, starter,
      supervised, Darwin and artifact requirements.
- [x] Start portable validation immediately. Make only artifact assembly wait for real Darwin
      binaries, and qualify those binaries with the narrow packed contained-files proof.
- [x] Run only the meaningful starter mode for a package release; reserve the complete target ×
      HEAD matrix for nightly/manual full verification.
- [x] Pack and upload only selected release artifacts, while keeping publication exact-SHA,
      immutable and fail-closed.
- [x] Execute the local release DAG with at most two heavy lanes concurrently and memoize it by
      exact tree, toolchain, lane environment and selected targets.
- [x] Keep ordinary pushes fast, run the complete cross-package matrix nightly, and mechanically
      test planner, workflow wiring, train subjects and multi-tag publication.
- [x] Update contributor/release architecture documentation and record the decision in an ADR.

## Acceptance

- [x] Two or more selected package tags are accepted from one green release commit and one
      exact-SHA CI run; tag membership and version identity are fail-closed.
- [x] The portable job has no Darwin dependency; only core artifact assembly consumes both native
      leaves.
- [x] Darwin executes the packed file/search/resource/race fixture under Bun and Node without the
      unrelated full consumer suite.
- [x] A TUI-only release does not run core, Darwin, starter or supervised lanes.
- [x] A starter-only release runs target compatibility once per variant/browser and does not run
      the equivalent HEAD matrix.
- [x] Nightly/manual full validation still covers every package and both starter modes.

## Implementation evidence

- `scripts/release-train.ts`, `scripts/release-plan.ts` and `release-train.json` own the validated
  multi-package identity and exact tag membership.
- `scripts/ci-plan.ts` and `.github/workflows/ci.yml` own target/path planning, parallel portable
  work, scheduled full audits and selected artifact assembly.
- `packages/core/scripts/consumer-lane/run.mjs --contained-files-only` retains packed Bun/Node
  platform proof without executing unrelated fixtures on both Darwin architectures.
- `scripts/verify.ts` runs structural prerequisites once and selected heavy lanes with concurrency
  two; its gate name includes the sorted target set.
- `scripts/ci-plan.test.ts`, `scripts/verify.test.ts`, `scripts/gate-parity.test.ts`,
  `scripts/workflow-permissions.test.ts` and `scripts/release-plan.test.ts` cover the planner, bound,
  workflow graph and train subject/membership.
- `bun run starter-lane` and `bun run supervised-lane` passed concurrently on the selected
  starter-only release surface; the release conveyor owns the final exact-tree memo proof.
