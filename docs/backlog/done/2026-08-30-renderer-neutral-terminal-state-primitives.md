---
title: Renderer-neutral terminal state primitives
description: Publish pure collection, viewport, pane, command and operation state machines below the official OpenTUI host.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 09:15 +0000
pipeline: composable-terminal-primitives
order: 2
depends-on: 2026-08-30-terminal-host-correctness-and-recovery.md
---

## Зачем

Session supervisors and other live terminal applications need the same hard mechanics as an agent
chat but own different cards, actions and runtime identities. Pure state contracts let them reuse
selection, navigation and operation safety while keeping their renderer and domain UI independent.

## Результат

- `@stitchkit/tui/core` exports Zod-first pure state machines with no renderer/runtime imports.
- Live collections retain selection by caller-owned key across sort, insert and removal.
- Windowing, split panes, command palettes and confirmed async operations have explicit transitions.
- The official TUI consumes the same command and viewport primitives instead of parallel logic.

## План

- [x] Implement keyed live collection selection and visible-window reduction.
- [x] Generalize the feed viewport without agent-specific names.
- [x] Implement split-pane focus/resize and responsive single-pane state.
- [x] Implement command palette navigation, exact dispatch and collision validation.
- [x] Implement confirmation/pending/result operation state.
- [x] Add the `./core` export and dependency-boundary tests.

## Acceptance

- [x] Reordering cannot move selection to a different identity.
- [x] Removal selects the deterministic nearest survivor and empty collections select nothing.
- [x] Pane sizes always respect declared bounds and narrow mode exposes exactly one pane.
- [x] Command aliases and names fail closed on collisions; partial input never dispatches.
- [x] `@stitchkit/tui/core` can be imported in Bun and Node without React/OpenTUI/agent-runtime.

## Что сделано

- [x] Core state: `packages/tui/src/core/collection.ts`, `viewport.ts`, `panes.ts`,
  `command-palette.ts` and `operation.ts`.
- [x] Package boundary: `packages/tui/package.json` publishes `./core`; the built
  `dist/core/index.js` has no React, OpenTUI, Stitchkit or agent-runtime import.
- [x] Regression: `packages/tui/tests/core.test.ts`, cases under `renderer-neutral terminal core`,
  cover reorder/removal, feed tailing, pane bounds, exact commands and serialized operations.
- [x] Root reuse: `packages/tui/src/commands.ts` and `packages/tui/src/viewport.ts` delegate to the
  same core state rather than carrying parallel implementations.
