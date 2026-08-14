---
title: "CI release critical path under three minutes"
description: Preserve the complete release gate while removing serial starter work from the exact-SHA publication path.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-14 23:24 +07:00
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

## Измеренные итерации

- Run `31814466950` flattened core, Node and four mode/variant starter cells. It
  was green in `3:12`; the longest cell spent `1:05` installing every browser's
  host dependencies before running all three browser projects.
- Run `31815275260` removed host provisioning and reached the browser gates in
  roughly two minutes, but correctly failed: the hosted image runs Chromium but
  lacks WebKit's GTK/GStreamer/Flite stack. This rejected experiment proves the
  dependency boundary instead of assuming it from runner documentation.
- Run `31816328883` exercised the final eight-cell graph in `2:31`, but one
  WebKit cell correctly kept the workflow red: a repository E2E assertion used
  a page-wide text locator that became ambiguous when the same value appeared
  in two DOM surfaces. The regression assertion now scopes the value to the one
  required `repository-summary`, retaining both uniqueness and visibility
  checks instead of adding a retry or weakening strict mode.
- Run `31817041259` was fully green but took `3:35`. Nine jobs completed in
  `0:32–2:30`; the outlying target/repository/WebKit cell spent `0:39` in the
  repository install and `1:28` provisioning 181 WebKit OS packages plus browser
  binaries, while its complete isolated starter proof took `0:55`. The runtime
  proof was not slow: live mirror provisioning made the release time unstable.
- Run `31817976772` rejected the preloaded image integration in `0:38`: all
  starter cells reached the pinned container, then `setup-bun` failed because it
  delegates extraction to an absent `unzip` executable. Installing `unzip` by
  live apt would reintroduce the same mirror dependency on every runner. Starter
  cells instead verify and extract Bun's official platform tarball with tools
  already present in the image.
- Run `31818378304` completed in `1:33` and proved that the verified Bun binary
  bootstrap itself is fast, but all starter cells failed when generated package
  scripts invoked the standard sibling command `bunx`. The bootstrap now exposes
  both official command names from the same integrity-checked binary and verifies
  both versions before any repository install.
- Run [`31819016716`](https://github.com/max-listov/stitchkit/actions/runs/31819016716)
  is the complete successful proof: `2:14` wall time from workflow creation to
  conclusion. Core completed in `0:48`, the packed Node consumer in `0:27`, and
  the eight isolated starter cells in `1:48–2:04`. All ten jobs became eligible
  within one second; the longest required surface was target/repository/Chromium
  at `2:04`, leaving 56 seconds of the three-minute budget.
- The final graph splits each mode/variant by browser group. Chromium and mobile
  Chromium remain separate from WebKit. Every cell now uses the immutable
  official image matching the lockfile Playwright version, with browsers and OS
  dependencies already present. All 150 cases remain release-blocking while no
  cell performs live `apt` or browser provisioning.

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

- [x] Give the starter lane one explicit `blank | repository` variant per
  invocation while preserving `target | head` as the independent mode.
- [x] Make local full-lane scripts compose both explicit variants so the local
  `verify` contract remains complete.
- [x] Split GitHub CI into a fast core artifact job, an independent Node packed
  consumer job and eight starter matrix entries (`target/head × blank/repository
  × chromium/webkit`).
- [x] Remove every `needs` edge and use the native workflow conclusion as the
  fail-closed aggregate selected by the exact-SHA publisher.
- [x] Run every isolated starter job in the immutable official image matching
  the lockfile Playwright version; perform no live OS/browser provisioning and
  never share mutable generated applications or databases between entries.
- [x] Keep exact-SHA tarball selection and OIDC publish permissions unchanged.
- [x] Add branch/PR concurrency cancellation so superseded SHA checks stop
  consuming runners; tag publication remains non-cancellable.
- [x] Extend executable workflow tests to pin the parallel graph, complete matrix,
  native fail-closed conclusion, action SHA pins and publish trust boundary.
- [x] Add focused tests for starter lane argument parsing and fail-first invalid
  combinations.
- [x] Document the new CI/release graph and its performance budget in contributor
  and release reference documentation.
- [x] Push measured iterations without publishing a package until a successful
  branch CI run is below `3:00`.

## Acceptance

- [x] The complete CI still executes 33 blank and 42 repository browser cases in
  both target and HEAD modes (150 total) and all eight matrix entries are required.
- [x] `core`, `node-smoke` and all starter matrix entries have no dependency on
  one another and are eligible to start at workflow time zero.
- [x] A failed matrix entry makes the workflow conclusion and exact-SHA release
  selection fail closed without a serial summary runner.
- [x] `stitchkit` and `create-stitchkit` tarballs are packed once from the exact
  commit and are not rebuilt inside the publisher.
- [x] Workflow-level permissions remain `contents: read`; `id-token: write`
  remains confined to the protected release job.
- [x] `bun run verify` passes locally.
- [x] A real successful GitHub Actions run completes below `3:00`; the measured
  job and step timeline is recorded in `Что сделано`.
- [x] No package version, changelog release section, git tag or npm publication is
  produced by this task.

## Что сделано

- [x] **CI graph:** [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
  runs core, packed Node and the complete eight-cell starter matrix independently;
  each starter cell owns its container, generated workspace and PostgreSQL service.
- [x] **Deterministic runtime:** the same workflow uses the immutable lockfile-matched
  Playwright image and an integrity-checked Bun platform tarball exposing both `bun`
  and `bunx`; no cell installs browser or OS dependencies from a live mirror.
- [x] **Starter composition:** [`scripts/starter-lane.ts`](../../../scripts/starter-lane.ts)
  and [`scripts/starter-lane-options.ts`](../../../scripts/starter-lane-options.ts)
  accept one explicit mode/variant/browser surface, while the package scripts still
  compose both variants for the complete local gate.
- [x] **Executable graph checks:**
  [`scripts/workflow-permissions.test.ts`](../../../scripts/workflow-permissions.test.ts)
  covers `cancels superseded branch and pull-request runs`, `core, Node and starter
  gates have no heavy-job dependency`, `the starter matrix contains every mode,
  variant and browser surface`, `starter cells use one immutable lockfile-matched
  browser image`, `the workflow conclusion is the fail-closed aggregate used by
  publication`, and `publication inputs are packed and uploaded only by the core job`.
- [x] **Argument checks:**
  [`scripts/starter-lane-options.test.ts`](../../../scripts/starter-lane-options.test.ts)
  covers `parses explicit mode, variant and browser combinations` and `fails first
  on missing, duplicate, empty and unknown arguments`.
- [x] **Repository browser proof:**
  [`packages/create-stitchkit/examples/repository/e2e/repository.spec.ts`](../../../packages/create-stitchkit/examples/repository/e2e/repository.spec.ts)
  retains `prefetched data hydrates without a loading flash or a client refetch` and
  `renders and refreshes the repository example`; the refreshed value is scoped to
  the required summary surface without weakening strict locator semantics.
- [x] **Documentation:** [`docs/architecture/ci-release.md`](../../architecture/ci-release.md)
  is the current release-graph reference, and [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)
  points contributors to the focused and complete local equivalents.
- [x] **Measured result:** successful run
  [`31819016716`](https://github.com/max-listov/stitchkit/actions/runs/31819016716)
  completed in `2:14` with all ten required jobs green and all 150 browser cases
  release-blocking, versus the measured `8:40` baseline.
- [x] **Release purity:** package versions, release changelog sections, git tags and
  npm publications were not changed or created by this task.
