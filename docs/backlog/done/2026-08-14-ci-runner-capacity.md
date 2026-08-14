---
title: "Capacity-aligned CI graph"
description: Keep the complete release gate below three minutes without a tenth job waiting for GitHub runner capacity.
type: task
status: done
created: 2026-08-14
updated: 2026-08-15
completed: 2026-08-15 00:00 +07:00
related: docs/backlog/done/2026-08-14-ci-release-critical-path.md
---

# Capacity-aligned CI graph

## Зачем

Exact-SHA run
[`31820891822`](https://github.com/max-listov/stitchkit/actions/runs/31820891822)
was green but took `4:03`. Nine jobs started at `16:46:21`; the tenth,
`Starter head / repository / webkit`, could start only at `16:48:18` after a
runner became free, then completed normally in `2:01`. The CI graph therefore
exceeds the available nine-job parallel capacity even though every individual
gate fits the three-minute budget.

The separate Node consumer job repeats checkout, Bun install and the core build.
Core already owns the same build and finishes in under one minute, while Node
smoke plus the packed consumer lane take about thirty seconds in a separate job.
Running those checks after the core build removes the tenth runner and duplicate
work without removing a single release gate or browser case.

## Результат

- Branch CI expands to exactly nine release-critical jobs: one framework,
  Node-consumer and publication-artifact job plus eight starter cells.
- Node 22 smoke and the packed external-consumer lane remain mandatory.
- All 150 starter browser cases remain split across the existing eight cells.
- A final exact-SHA GitHub workflow is fully green below `3:00` wall-clock.

## План

- [x] Install Node 22 in the core job and run Node smoke plus consumer lane after
  the single shared build.
- [x] Remove the standalone Node job and its duplicate checkout, install and
  build.
- [x] Update executable workflow tests to pin the combined gate and forbid a
  standalone Node job.
- [x] Update the CI architecture reference with the nine-job capacity boundary.
- [x] Run the full local verification gate.
- [x] Push and require a green exact-SHA GitHub run below three minutes.

## Acceptance

- [x] The workflow has one static core job and one eight-cell starter matrix.
- [x] Core explicitly provisions Node 22 before running `smoke:node` and
  `consumer-lane` after `bun run build`.
- [x] There is no standalone `node-smoke` job or second core build.
- [x] The starter mode, variant and browser matrix remains unchanged.
- [x] Publication artifacts are still produced once from the exact validated
  tree and consumed by the exact-SHA release workflow.
- [x] The complete local `bun run verify` passes.
- [x] The final exact-SHA GitHub workflow is green below `3:00`.
- [x] Package versions, changelogs, tags and npm publications remain unchanged.

## Что сделано

- [x] **CI:** `.github/workflows/ci.yml` now runs framework, Node 22 smoke,
  packed consumer validation and publication-artifact packing in one job after
  one checkout, install and build; the eight-cell starter matrix is unchanged.
- [x] **Executable policy:** `scripts/workflow-permissions.test.ts`, test
  `the graph fits nine runners without dropping the Node consumer gate`, pins
  the nine-job topology, Node 22 setup, both Node gates and the single build.
- [x] **Architecture:** `docs/architecture/ci-release.md` records the nine-runner
  capacity boundary and the shared core/Node build without weakening coverage.
- [x] **Local validation:** `bun run verify` passed across lint, types, tests,
  build, Node smoke, consumer lane and both complete packed starter lanes.
- [x] **Exact-SHA validation:** commit
  `03a01368930367056f145e3dc90c7dce638b6125` passed all nine jobs in
  [`2:12`](https://github.com/max-listov/stitchkit/actions/runs/31821800334);
  every job started within two seconds and the slowest retained starter cell
  completed in `2:09`.
- [x] **Release boundary:** no package version, changelog, tag, release or npm
  publication was changed or created.
