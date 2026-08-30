---
title: Make workspace checks independent of pre-existing build artifacts
description: Prepare the core package before sibling workspace packages resolve its public exports on a clean checkout.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P0
completed: 2026-08-30 09:47 +0000
---

## Why

The `0.69.0` release candidate passed the full local gate with existing ignored
`packages/core/dist` and nested Agent-starter `node_modules`, but exact-SHA CI runs failed during
`bun run check` on clean checkouts.
The new TUI correctly imports public `stitchkit/agent-runtime` and
`stitchkit/agent-runtime/harness` entrypoints; those exports point to `dist`, which had not yet
been built because the workspace build step followed check and test. Once that was corrected, the
full log exposed the second hidden prerequisite: root preparation installed the application
starter but not the independently locked Agent starter, so `bun x tsgo` attempted to fetch a
nonexistent package instead of using `@typescript/native-preview`'s local binary.

## Result

A normal root `bun install` prepares the workspace-owned core artifact and both independently
locked starter trees before any sibling package is checked or tested. The order is held
mechanically so a clean checkout cannot accidentally rely on a maintainer's ignored build output.

## Plan

- [x] Build the core package in the root prepare lifecycle before preparing nested starter trees.
- [x] Install both independently locked starter trees and add regression coverage for both
      preparation invariants.
- [x] Reproduce a clean-artifact check and complete the exact release gate.
- [x] Keep the failed candidate untagged and hand a replacement commit to the exact-SHA release
      conveyor.

## Acceptance

- [x] A checkout with no `packages/core/dist` or Agent-starter `node_modules` can install and run
      `bun run check`.
- [x] TUI source keeps importing the public Stitchkit entrypoints rather than private source aliases.
- [x] Release planning still requires successful exact-SHA CI before creating any tag; the failed
      candidate has no release tag.

## Что сделано

- [x] Root [`package.json`](../../../package.json) builds the core package during `prepare` before
      nested workspace preparation, and [`scripts/prepare-starter.ts`](../../../scripts/prepare-starter.ts)
      installs both locked starter trees, so every root gate dependency exists after a clean install.
- [x] [`scripts/gate-parity.test.ts`](../../../scripts/gate-parity.test.ts) case
      `root prepare builds Stitchkit before it prepares nested workspaces` and
      `nested preparation installs both independently locked starter trees` hold the dependency
      order and complete nested install set mechanically.
- [x] Clean-artifact proof moved the previous ignored `packages/core/dist` and Agent-starter
      `node_modules` aside, ran `bun install --frozen-lockfile`, asserted the generated harness
      declaration and local `tsgo` binary, then completed `bun run check` with every workspace green.
- [x] Exact-SHA publication remains gated on the replacement release commit's successful CI run;
      failed candidate `8ab190a61ad3471d926dd1f7e4ba5a8941a33123` receives no tag.
