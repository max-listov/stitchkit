---
title: CI and exact-SHA release pipeline
description: Package-aware evidence lanes, one-SHA release trains and immutable publication inputs.
type: architecture
status: active
created: 2026-08-14
updated: 2026-08-30
---

# CI and exact-SHA release pipeline

Validation and publication are separate. Branch CI proves an exact tree and uploads immutable
tarballs; tag workflows may only publish those tarballs from the successful push run for the same
SHA. They never rebuild publication input.

## One release train

`release-train.json` is the source of truth for a release commit. It lists one or more package
targets and their exact versions. A release commit uses the subject `release(train): …`; every tag
selected by the manifest points at that same branch head and consumes the same CI run:

```json
{
  "schemaVersion": 1,
  "releases": [
    { "target": "core", "version": "0.71.0" },
    { "target": "create-stitchkit", "version": "0.4.5" }
  ]
}
```

The pre-push and tag gates parse the manifest, require each version to equal its package manifest,
validate that package's changelog/migration channel and refuse a tag not selected by the train.
`bun run release:train` creates and pushes all selected tags after the exact-SHA push CI is green.
Single-package legacy commands remain valid, but a coordinated release never needs bookkeeping
commits between tags.

## Target-aware CI graph

`scripts/ci-plan.ts` maps either the release train or ordinary changed paths to named evidence.
Every job starts after the small planner, not after another platform:

| Job | Runs when | Guarantee |
| --- | --- | --- |
| `repository` | always | workflow/release contracts, formatting and script types/tests |
| `portable` | core/shared change | core types/tests/build, PostgreSQL adapter, smokes and packed consumer |
| `tui` | TUI target/change | terminal package types/tests/build and packed host |
| `starter-package` | starter compatibility is selected | scaffolder and authored template types |
| `darwin-contained-files` | core target/change | real arm64/x64 native build and narrow packed Bun/Node file/search/resource/race proof |
| `supervised` | core or starter | generated roles under the pinned PM2 supervisor |
| `starter` | core or starter | two variants × two browsers on the compatibility edge that can differ |
| `artifacts` | release train | waits for selected evidence, downloads Darwin leaves only for core, packs selected packages |
| `result` | always | fails closed if any selected job failed or was cancelled |

A starter-only release runs published-target mode. A core release runs packed-HEAD mode. The full
target × HEAD cross-product runs nightly and on `workflow_dispatch`; it remains the audit for the
planner and for interactions that no package diff predicts. Chromium and WebKit still use the
lockfile-matched Playwright image pinned by immutable digest and the exact pinned Bun tarball hash.

The portable core job has no Darwin dependency. Real macOS qualification still packs and installs
the public package, but `--contained-files-only` executes only the surface whose implementation is
platform-specific. Artifact assembly is the sole consumer of both validated native leaves.

## Local gate

`bun run verify` remains the exhaustive portable gate. Ordinary pushes use `verify:fast`. A release
push uses `bun scripts/verify.ts --release --if-changed`: structural steps and build run once, then
independent selected heavy lanes execute with maximum concurrency two. The green memo is keyed by
the exact working-tree hash, toolchain, lane environment and selected target set, so pre-push reuses
the one final run and any edit invalidates it.

Template unit tests are not run again at root after the generated starter lane has executed the
same tests from the packed scaffold. Authored template type checks remain separate because they
catch source drift before generation.

## Publication boundary

The tag workflow:

1. validates tag, package version, changelog and membership in the train;
2. requires successful `ci.yml` push CI for the exact tag SHA;
3. downloads that run's `release-packages` artifact;
4. publishes only the matching tarball, idempotently refusing different bytes at an existing
   version;
5. creates the GitHub release from the validated changelog entry.

Workflow permissions default to `contents: read`. OIDC `id-token: write` exists only in the
protected `npm-production` publication job. Every third-party action is pinned to a full commit
SHA. Superseded branch/PR runs are cancellable; tag publication is not.
