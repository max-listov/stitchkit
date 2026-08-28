---
title: Official starter targets the current framework release
description: Ship create-stitchkit against the latest published Stitchkit with both packed target and HEAD compatibility proofs
type: task
status: in-progress
created: 2026-08-28
updated: 2026-08-28
---

# Official starter targets the current framework release

## Why

The official starter is the framework's golden consumer path. Its catalog still
targets `^0.60.1` while npm publishes Stitchkit `0.68.6`; under pre-1.0 caret
semantics a fresh scaffold cannot receive any of the `0.61.0–0.68.6` line.

The scaffolder release must prove both boundaries from the same source tree:
the published target a generated application installs and packed framework HEAD
that future core changes must keep compatible. The repository variant also
needs its literal optional realtime-client peer loader in the published output.

## Result

- The template's single `catalog.stitchkit` range targets the newest stable
  framework release and its frozen lockfile resolves that release.
- Blank and repository variants pass packed target and packed HEAD lanes.
- The scaffolder changelog covers every user-visible change since the previous
  release and `create-stitchkit` is published as the next additive patch.

## Plan

- [x] Advance the template framework target with `bun run update:starter` and
      keep every workspace dependency expressed as `"stitchkit": "catalog:"`.
- [x] Record the current-framework target and repository realtime peer
      composition in the scaffolder changelog.
- [x] Bump only `packages/create-stitchkit/package.json` as an additive patch;
      do not move the independent core version.
- [x] Run the complete local release gate, including packed target, packed HEAD,
      browser, supervised and lockfile lanes.
- [x] Stabilize the response-body cancellation lifetime proof exposed by the
      release pre-push gate, then rerun the complete gate on the resulting tree.
- [ ] Commit and push the release tree, wait for the successful exact-SHA push
      run, publish the matching tag and verify GitHub/npm artifacts.

## Acceptance

- [x] `catalog.stitchkit` and `template/bun.lock` resolve the same newest stable
      Stitchkit version; no child manifest owns a literal framework range.
- [x] Both scaffold variants typecheck, lint, test, build and pass runtime and
      browser acceptance against the published target and packed HEAD.
- [x] Release metadata names the exact package version and contains no unpromoted
      breaking migration.
- [ ] The exact release SHA has a successful `ci.yml` push run.
- [ ] The matching `create-stitchkit-v*` tag publishes one installable npm
      artifact whose registry version and integrity match the GitHub release.
