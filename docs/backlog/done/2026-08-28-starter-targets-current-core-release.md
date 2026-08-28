---
title: Official starter targets the current framework release
description: Ship create-stitchkit against the latest published Stitchkit with both packed target and HEAD compatibility proofs
type: task
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 13:15 +0000
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
- [x] Commit and push the release tree, wait for the successful exact-SHA push
      run, publish the matching tag and verify GitHub/npm artifacts.

## Acceptance

- [x] `catalog.stitchkit` and `template/bun.lock` resolve the same newest stable
      Stitchkit version; no child manifest owns a literal framework range.
- [x] Both scaffold variants typecheck, lint, test, build and pass runtime and
      browser acceptance against the published target and packed HEAD.
- [x] Release metadata names the exact package version and contains no unpromoted
      breaking migration.
- [x] The exact release SHA has a successful `ci.yml` push run.
- [x] The matching `create-stitchkit-v*` tag publishes one installable npm
      artifact whose registry version and integrity match the GitHub release.

## What was done

- Released `create-stitchkit@0.4.3` from commit
  `4a6621810670ede3d40cfe2812d03bc9359de650` under tag
  `create-stitchkit-v0.4.3`. Exact-SHA `ci.yml` run `33174174359` and release
  run `33174508329` both completed successfully.
- Advanced the template's single framework catalog target to `^0.68.6`; its
  frozen lockfile resolves exactly `stitchkit@0.68.6`, while every child
  workspace keeps using `"stitchkit": "catalog:"`.
- Preserved both scaffold variants and supplied the repository variant's
  literal optional `socket.io-client` loader without introducing another
  framework version source.
- `bun run verify` passed the full release tree, including the packed target
  lanes. `bun run starter-head-lane` passed blank and repository variants
  against packed framework HEAD in Chromium and WebKit.
- Stabilized the timer-lifetime regression exposed under full-suite load.
  `packages/core/tests/http-client-stream-cancellation-lifetime.test.ts` —
  `response-body cancellation lifetime — configured HTTP adapter Unix option > all terminal paths release server admission and the finite Unix slot`,
  with the equivalent configured HTTP adapter and Fetch config cases, proves
  the response body remains usable beyond the headers deadline and releases
  admission on every terminal path.
- Corrected the release self-check to read the manifest selected by the release
  scope. `scripts/release-plan.test.ts` —
  `a release commit is checked before it costs a gate > the release commit this repository last made passes it`
  now validates both core and starter release commits against their own package.
- Verified npm registry version `0.4.3`, tarball shasum
  `a810b25896644c781fa7761737d08670e08bc6a4` and integrity
  `sha512-OcHuv8tJJ4h1WgM3SavWZeO/rH17xlNpMSBAR3ly2sNzzTyFHUkYEyrQM5NBHkWUerhzaOoL4y/CKPJu/tOkHw==`
  against the GitHub release for the matching tag.
