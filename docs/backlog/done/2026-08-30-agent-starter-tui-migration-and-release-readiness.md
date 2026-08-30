---
title: Agent starter TUI migration and release readiness
description: Reduce the generated agent project to typed customization over the official TUI and prove all packages through packed release lanes.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 5
depends-on: 2026-08-30-official-agent-tui-package.md
completed: 2026-08-30
---

# Agent starter TUI migration and release readiness

## Зачем

The starter must demonstrate composition instead of carrying a fork of the official interface.
The new package also needs the same release metadata, packed artifact and exact-SHA guarantees as
the existing independently versioned packages before it can be released safely.

## Результат

- The agent template contains only its domain config, prompts/resources, tool policy and theme
  overrides; TUI product mechanics come from `@stitchkit/tui`.
- Root gates typecheck, test, build and pack all three packages and exercise a generated agent
  project against packed artifacts.
- `stitchkit-tui-vX.Y.Z` is an independent tag namespace with its own changelog, upgrading guide,
  release-plan validation and npm artifact.
- Architecture, Vision, guides, README and generated agent-facing reference state the final package
  boundaries and commands.

## План

- [x] Replace copied starter UI/runtime glue with `stitchkit.agent.ts` composition.
- [x] Add the packed TUI consumer lane and complete a generated-agent PTY acceptance run.
- [x] Extend release-plan, CI artifact and workflow tests for the independent package.
- [x] Record the package boundary decision and supersede the starter-only TUI decision.
- [x] Update public docs, changelogs and migration guidance.

## Acceptance

- [x] Scaffolded agent source contains no copied command registry, model picker or viewport engine.
- [x] Packed artifacts install without workspace paths or undeclared dependencies.
- [x] Release metadata rejects wrong package versions, scopes, tags, changelogs and missing artifacts.
- [x] The complete `bun run verify` gate passes with no release performed.

## Что сделано

The generated agent now keeps only typed runtime policy, resources and theme composition over the
official package. The root build, checks and full verification include the independently packed TUI
consumer, and release planning recognizes `stitchkit-tui-vX.Y.Z` without coupling core, starter or
TUI versions. The generated README contains the live test path and local attach command.

## Регрессия

- `packages/create-stitchkit/tests/options.test.ts` — `parses the agent template and rejects
  application-only overlays`.
- `packages/create-stitchkit/tests/scaffold.test.ts` — `materialises the Agent template with the
  canonical catalog and no app identity module`.
- `scripts/release-plan.test.ts` — `the subject scope is bound to the tag namespace` and `maps both
  tag namespaces to one release model`.
- `scripts/tui-packed-lane.ts` — packed manifest, CLI, consumer typecheck and installed-binary
  smoke.
