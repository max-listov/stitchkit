---
title: Public entrypoint optional-peer bundle matrix
description: Replace scattered bundle checks with an explicit packed-package matrix of entrypoints, features and allowed optional peers.
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 02:26 +00:00
related:
  - docs/backlog/done/2026-08-24-server-barrel-bundle-optional-peers.md
  - docs/backlog/done/2026-08-06-the-published-package-is-tested-as-a-consumer-uses-it.md
---

# Public entrypoint optional-peer bundle matrix

## Зачем

The packed consumer lane protects several optional boundaries with custom code, but no single
manifest states which peers each entrypoint may resolve. A new literal import can therefore create
the same class of bundle failure under a different entrypoint without an obvious review failure.

## Результат

- One declarative matrix names subpath, feature import, runtime target, installed peers, runtime and
  declaration budgets, execution policy and missing-peer expectation.
- The lane bundles every matrix case from the packed tarball, inspects the metafile and executes the
  artifact where the case is runtime-neutral.
- Opt-in adapter cases retain targeted missing-peer diagnostics; neutral cases fail on any
  undeclared peer resolution.

## План

- [x] Inventory every package export and assert exact export-map coverage so a new subpath fails
      until classified.
- [x] Extract current application/testing/remote/agent checks into a reusable matrix runner.
- [x] Cover all subpaths, including mixed-barrel feature rows for `server`, `node` and `tools`, on
      relevant browser/Bun/Node targets.
- [x] Match package-aware inputs and keep separate JS-metafile and emitted-declaration budgets.
- [x] Document the matrix as a release invariant.

## Acceptance

- [x] Each export, including the new operational adapter, is represented or explicitly excluded
      with a reason.
- [x] Minimal cases install no accidental optional peers and execute without them.
- [x] Provider cases may resolve only their declared peer family.
- [x] Intentionally forbidden runtime and type-only inputs fail with the case and package name.

## Что сделано

- `packages/core/scripts/consumer-lane/optional-peer-matrix.mjs` is the single packed-package
  inventory for every current export, mixed-barrel feature budgets and targeted missing-peer
  diagnostics. `run.mjs` invokes it after all four fixture families are installed and exercised.
- Runtime budgets come from Bun metafile package inputs; declaration budgets walk the emitted
  public `.d.ts` graph independently. Fixture dependencies are checked against the case's declared
  installed-peer set before bundling.
- `docs/guide/testing-and-deployment.md` records exact export coverage and peer budgets as release
  invariants; `CHANGELOG.md` records the new release gate.
- Regression coverage: `packages/core/tests/optional-peer-matrix.test.mjs` — `classifies every
  current public export`, `runtime budget failure names the case and forbidden package`, and
  `declaration budget failure names the case and forbidden type-only package`.
