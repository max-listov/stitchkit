---
title: Independent starter release line
description: Decouple create-stitchkit and its tested Stitchkit target from framework HEAD while preserving an explicit compatibility probe.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 06:02 +00:00
---

# Independent starter release line

## Goal

Keep the published starter on its last explicitly validated Stitchkit range while
the framework can evolve and release independently. Updating the starter target
must be one deliberate, auditable operation rather than an automatic consequence
of changing the framework package version.

## Plan

1. Make `packages/create-stitchkit/template` an autonomous Bun workspace with a
   committed lockfile and a single catalog entry for its supported Stitchkit
   range. Keep only internal `@app/*` edges on `workspace:*`.
2. Stop materialising a Stitchkit version from the `create-stitchkit` package
   version. Generated projects retain the catalog and lockfile tested by the
   canonical template.
3. Remove the package-version equality rule from the packed starter lane. Add a
   blocking static-target lane and a separate local-HEAD compatibility probe.
4. Split release automation: `vX.Y.Z` publishes only `stitchkit`;
   `create-stitchkit-vX.Y.Z` publishes only the scaffolder. Each tag validates
   only its package version and release artifact.
5. Give `create-stitchkit` its own changelog and document the independent
   lifecycle in contributor guidance, package docs and a new indexed ADR.
6. Validate source/editor resolution, both packed modes, tarball hygiene and the
   complete repository gate.

## Acceptance

- [x] The canonical template installs a published Stitchkit range from one Bun
      catalog entry and owns a committed `bun.lock`.
- [x] Framework version changes do not rewrite or publish `create-stitchkit`.
- [x] Generated projects receive the tested catalog and lockfile without a
      scaffold-time version rewrite.
- [x] Static starter verification cannot accidentally resolve framework HEAD.
- [x] A distinct HEAD probe can expose compatibility drift without coupling the
      two release versions.
- [x] Core and scaffolder tags publish independently and verify the matching npm
      artifact.
- [x] Docs, ADR index and both changelogs describe the same release model.
- [x] Lint, typecheck, unit tests, builds, package checks and starter E2E are green.

## Конвейер 0/0

- [x] Task captured with plan and acceptance criteria.
- [x] Plan validators: 0 — intentionally skipped by the requested protocol.
- [x] Moved to `in-progress` before implementation.
- [x] Implement the accepted plan.
- [x] Run project gates.
- [x] Implementation validators: 0 — intentionally skipped by the requested protocol.
- [x] Record the concrete result and move to `done` after green gates.

## Что сделано

- [x] **Template:** `packages/create-stitchkit/template/package.json` owns the
      `stitchkit` catalog target; `packages/create-stitchkit/template/bun.lock`
      freezes its independently tested dependency graph.
- [x] **Scaffolder:** `packages/create-stitchkit/src/scaffold.ts` copies and
      materialises the catalog and lockfile without deriving a framework version
      from the scaffolder package.
- [x] **Compatibility gates:** `scripts/starter-lane.ts` verifies the published
      static target by default and the packed local core only through `--head`;
      `scripts/starter-manifest.ts` is the single catalog read/write boundary.
- [x] **Developer workflow:** `scripts/prepare-starter.ts` installs the nested
      frozen workspace for editor resolution, while the explicit `--head` lane
      probes compatibility against the local core package.
- [x] **Release automation:** `.github/workflows/ci.yml` publishes core from
      `vX.Y.Z` and the scaffolder from `create-stitchkit-vX.Y.Z`, with separate
      version checks, changelogs and npm verification.
- [x] **Documentation:** `docs/decisions/0061-independent-starter-release-line.md`,
      `AGENTS.md`, `CONTRIBUTING.md`, package READMEs and both changelogs describe
      the same independent lifecycle.
- [x] **Validation:** static target and HEAD lanes both passed DB, HTTP, OpenAPI,
      Socket.IO, MCP, CLI, Chromium and WebKit E2E; `bun run verify` passed lint,
      typecheck, 928 unit tests, builds, Node smoke and packed consumer checks.
- [x] **Что не делалось:** no commit, tag, publish, deployment or consumer
      migration was performed.
