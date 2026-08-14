---
title: "CI release critical path under three minutes"
description: Preserve the complete release gate while removing serial starter work from the exact-SHA publication path.
type: task
status: in-progress
created: 2026-08-14
updated: 2026-08-14
---

# CI release critical path under three minutes

## Зачем

The successful `stitchkit@0.48.1` branch CI took 8 minutes 40 seconds before the
25-second tag publisher could start. The package publisher is already fast; the
delay is created by the CI graph: the pinned starter lane runs first, then both
`node-smoke` and the HEAD starter lane wait for it, while each starter lane runs
the blank and repository variants sequentially. A core hotfix therefore waits
for two complete starter generations, four generated installs/builds and 150
browser tests on a serial critical path.

The release gate must become fast without dropping a runtime, browser, starter
variant, packed-package or exact-SHA guarantee.

## Фактический baseline

- CI run `31810655811`: `8:40` wall time.
- Fast core checks through build: `0:48`.
- Target browser install: `0:39`; target starter lane: `2:53`.
- HEAD job started only after target completed; setup/install: `0:31`, browser
  install: `0:56`, HEAD starter lane: `2:36`.
- Node smoke/consumer lane: `0:36`, but it also starts after the first lane.
- Tag publisher run `31811404214`: `0:25`; npm publication itself: `0:08`.
- Target and HEAD each execute 33 blank plus 42 repository browser tests: 150
  browser cases remain mandatory across the complete workflow.

## Результат

- A successful exact-SHA CI run completes in less than three minutes on the
  normal GitHub-hosted runner path.
- Core, Node and every starter mode/variant begin independently; no heavy test
  job waits for another heavy test job.
- All current target/HEAD, blank/repository, Chromium/WebKit/mobile, DB, HTTP,
  OpenAPI, Socket.IO, MCP, CLI, build, type and packed-consumer guarantees stay
  release-blocking.
- The release workflow still publishes only a tarball built from and validated
  by the exact successful branch SHA.
- Package versions and npm tags do not change while this task is implemented.

## План

- [ ] Give the starter lane one explicit `blank | repository` variant per
  invocation while preserving `target | head` as the independent mode.
- [ ] Make local full-lane scripts compose both explicit variants so the local
  `verify` contract remains complete.
- [ ] Split GitHub CI into a fast core artifact job, an independent Node packed
  consumer job and four starter matrix entries (`target/head × blank/repository`).
- [ ] Remove every heavy-job `needs` edge; add one tiny final required aggregator
  that fails unless all matrix entries and both framework jobs succeeded.
- [ ] Install the exact Playwright runtime once per isolated starter job through
  a deterministic, pinned browser environment; never share mutable generated
  applications or databases between matrix entries.
- [ ] Keep exact-SHA tarball selection and OIDC publish permissions unchanged.
- [ ] Add branch/PR concurrency cancellation so superseded SHA checks stop
  consuming runners; tag publication remains non-cancellable.
- [ ] Extend executable workflow tests to pin the parallel graph, complete matrix,
  required aggregator, action SHA pins and publish trust boundary.
- [ ] Add focused tests for starter lane argument parsing and fail-first invalid
  combinations.
- [ ] Document the new CI/release graph and its performance budget in contributor
  and release reference documentation.
- [ ] Push measured iterations without publishing a package until a successful
  branch CI run is below `3:00`.

## Acceptance

- [ ] The complete CI still executes 33 blank and 42 repository browser cases in
  both target and HEAD modes (150 total) and all four matrix entries are required.
- [ ] `core`, `node-smoke` and all starter matrix entries have no dependency on
  one another and are eligible to start at workflow time zero.
- [ ] A failed matrix entry makes the aggregate workflow and exact-SHA release
  selection fail closed.
- [ ] `stitchkit` and `create-stitchkit` tarballs are packed once from the exact
  commit and are not rebuilt inside the publisher.
- [ ] Workflow-level permissions remain `contents: read`; `id-token: write`
  remains confined to the protected release job.
- [ ] `bun run verify` passes locally.
- [ ] A real successful GitHub Actions run completes below `3:00`; the measured
  job and step timeline is recorded in `Что сделано`.
- [ ] No package version, changelog release section, git tag or npm publication is
  produced by this task.

