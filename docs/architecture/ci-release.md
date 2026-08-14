---
title: CI and exact-SHA release pipeline
description: Parallel release gates, immutable publication inputs and the three-minute branch CI budget.
type: architecture
status: active
created: 2026-08-14
updated: 2026-08-14
---

# CI and exact-SHA release pipeline

Stitchkit separates validation from publication. Branch CI builds the package
tarballs and proves every supported runtime and starter surface. A tag workflow
may publish only those already validated tarballs from the exact successful
commit SHA; it never rebuilds publication inputs.

## Branch CI graph

Every expensive gate is eligible to start at workflow time zero:

| Job | Guarantee |
|---|---|
| `core` | lint, TypeScript, unit/integration tests, package build, packed docs and the two immutable release tarballs |
| `node-smoke` | Node 22 imports, runtime smoke and packed external-consumer lane |
| `starter / target / blank / chromium` | blank published-target scaffold in desktop and mobile Chromium |
| `starter / target / blank / webkit` | blank published-target scaffold in WebKit |
| `starter / target / repository / chromium` | repository published-target example in desktop and mobile Chromium |
| `starter / target / repository / webkit` | repository published-target example in WebKit |
| `starter / head / blank / chromium` | blank packed-HEAD scaffold in desktop and mobile Chromium |
| `starter / head / blank / webkit` | blank packed-HEAD scaffold in WebKit |
| `starter / head / repository / chromium` | repository packed-HEAD example in desktop and mobile Chromium |
| `starter / head / repository / webkit` | repository packed-HEAD example in WebKit |

Each starter cell owns its generated workspace and PostgreSQL database. The
matrix keeps `fail-fast: false`, so one failure does not hide results from the
other seven surfaces. Across the matrix the existing 33 blank and 42 repository
browser cases run in both modes: 150 browser cases, including Chromium, WebKit
and the mobile project.

Browser revisions come from the frozen lockfile. Every starter cell runs in the
official Playwright image for that exact version, pinned by immutable OCI digest.
The image already contains Chromium, WebKit and their system libraries; branch CI
therefore performs no live `apt` provisioning or browser download. Chromium and
WebKit execution still proceed on separate runners, but setup latency no longer
depends on package-mirror or browser-CDN variance. The repository install also
skips its development-only prepare hook: the lane itself creates, installs and
validates its own disposable scaffold.

There is no serial summary job. GitHub marks the workflow successful only when
every matrix cell and independent framework job succeeds. The publisher selects
that successful completed workflow for the exact commit SHA, so the workflow's
native conclusion is already the fail-closed aggregate.

Superseded branch or pull-request runs are cancelled. Tag publication is a
separate non-cancellable workflow, so an in-progress npm publication can never
be interrupted by a newer commit.

## Performance budget

The successful branch workflow has a wall-clock budget of three minutes on the
normal GitHub-hosted runner path. No gate may be removed to meet the budget. A
regression is diagnosed from the longest parallel job's step timings; the fix
must remove duplicated setup or serial dependency rather than weaken coverage.
The pinned Playwright image is advanced together with the lockfile browser
version; a version mismatch fails browser launch instead of silently downloading
a different runtime.

## Publication boundary

`core` packs `stitchkit` and `create-stitchkit` once and uploads the
`release-packages` artifact. The tag workflow then:

1. validates the tag, package version and changelog entry;
2. requires a successful branch CI run for the exact tag SHA;
3. downloads `release-packages` from that run ID;
4. publishes only the tarball whose name and version match the validated plan;
5. creates the GitHub release from the same changelog entry.

Workflow permissions default to `contents: read`. OIDC `id-token: write` exists
only in the protected `npm-production` publish job. Every third-party action is
pinned to a full commit SHA.

## Local equivalents

`bun run verify` remains the complete local framework gate and composes both
target starter variants. `bun run starter-head-lane` composes both HEAD variants.
For a focused lane, call the executable directly with one explicit combination:

```bash
bun scripts/starter-lane.ts --mode=target --variant=blank --browser=all
bun scripts/starter-lane.ts --mode=head --variant=repository --browser=webkit
```

Missing, duplicate or unknown mode/variant/browser arguments fail before a
workspace is created, preventing an accidentally partial CI gate.
