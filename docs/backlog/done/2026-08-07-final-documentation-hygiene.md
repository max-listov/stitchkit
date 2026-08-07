---
title: Final documentation hygiene for 0.37.0
description: Remove the remaining volatile source-size claim and repair the active backlog link moved by the 0.37.0 task closure.
type: task
status: done
created: 2026-08-07
updated: 2026-08-07
completed: 2026-08-07 07:23 +00:00
---

# Final documentation hygiene for 0.37.0

## Plan

- [x] Replace the two stale `~8500` README claims with durable wording.
- [x] Point the MCP rejection icebox task at the completed native registration task.
- [x] Verify active documentation links and formatting.

## Acceptance

- [x] Public overview documentation contains no volatile source-line count.
- [x] The active icebox task references an existing file.
- [x] Documentation checks are clean.

## Что сделано

- [x] **README:** both volatile source-size claims were replaced with durable
      wording about the focused, inspectable core and explicit adapters.
- [x] **Backlog:** the active MCP rejection icebox task now points to the
      completed framework-owned native MCP registration task.
- [x] **Verification:** `bun run lint`, `bun run check`, `git diff --check` and
      targeted active-link/source-count checks pass.
- [x] **Scope:** runtime code and archived `done/` records were not changed.
