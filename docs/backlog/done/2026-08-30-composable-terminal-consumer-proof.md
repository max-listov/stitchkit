---
title: Composable terminal consumer proof
description: Prove a packed multi-session consumer can compose the terminal core and headless harness without importing the official agent application.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 09:15 +0000
pipeline: composable-terminal-primitives
order: 3
depends-on: 2026-08-30-renderer-neutral-terminal-state-primitives.md
---

## Зачем

A reusable API is not proven by its own implementation. A packed consumer must compose a live
session list, selected transcript, commands and operations while keeping process supervision and
domain cards outside Stitchkit and reusing the published harness rather than copying it.

## Результат

- A packed fixture imports `@stitchkit/tui/core` and the published headless harness as independent
  leaves.
- The fixture drives live reorder/removal, transcript streaming, command selection, confirmation
  and attachment through real package exports.
- Public docs state the boundary between generic terminal mechanics, the official agent host and
  consumer-owned supervision.

## План

- [x] Add a typed packed supervisor fixture over the core export.
- [x] Exercise core import isolation in Bun, Node and bundler-compatible resolution.
- [x] Add a bounded PTY lifecycle lane for the official host.
- [x] Document layered imports and ownership boundaries.

## Acceptance

- [x] The fixture typechecks and runs from packed archives without workspace resolution.
- [x] No consumer fixture imports internal source paths or copies an agent/provider loop.
- [x] PTY exit proves restored input mode, removed local artifacts and no active run leak.
- [x] Existing root imports remain source- and behavior-compatible.

## Что сделано

- [x] Packed proof: `scripts/tui-packed-lane.ts` installs packed core/TUI archives, typechecks a
  Bundler consumer, runs Bun root/core composition and runs a Node `./core` consumer.
- [x] PTY proof: the same lane starts the installed binary through a real pseudo-terminal, exits
  through Ctrl+C under normal and throwing harness close, and rejects residual session artifacts.
- [x] Documentation: `docs/architecture/terminal-host.md`, `docs/api/reference.md`, root `README.md`
  and `packages/tui/README.md` define the core/root/consumer ownership boundary.
- [x] Compatibility: the existing `.` package export is unchanged and all 32 focused TUI tests pass.
