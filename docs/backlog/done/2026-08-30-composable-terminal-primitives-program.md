---
title: Composable terminal primitives program
description: Make the official terminal host safe to embed and expose renderer-neutral mechanics that richer session supervisors can reuse without copying an agent loop.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 09:15 +0000
pipeline: composable-terminal-primitives
order: 0
depends-on: —
---

## Зачем

The official terminal host proves one durable agent conversation, while richer consumers also need
identity-stable live collections, master-detail panes, command routing and supervised attachment.
Those mechanics must be reusable below the product shell: copying them forks correctness, while
making one application import the complete agent TUI couples unrelated domain and rendering policy.

## Результат

- `@stitchkit/tui` has a dependency-light core layer with pure state machines and a maintained
  OpenTUI agent host above it.
- The headless harness and local attachment boundary are safe under recovery, model changes,
  conversation switches and terminal shutdown.
- A packed generic consumer proves that the core layer can drive a multi-item supervisor without
  importing the official agent application or duplicating its runtime.

## Этапы

1. [Terminal host correctness and recovery](2026-08-30-terminal-host-correctness-and-recovery.md)
2. [Renderer-neutral terminal state primitives](2026-08-30-renderer-neutral-terminal-state-primitives.md)
3. [Composable terminal consumer proof](2026-08-30-composable-terminal-consumer-proof.md)

## Acceptance

- [x] Every stage is closed with exact tests and inspectable evidence.
- [x] Existing direct `@stitchkit/tui` consumers retain their entrypoint and behavior.
- [x] Core imports do not load React, OpenTUI or the agent runtime.
- [x] No second agent loop, event bus or provider abstraction is introduced.

## Что сделано

- [x] Correctness stage closed in `2026-08-30-terminal-host-correctness-and-recovery.md`.
- [x] Core stage closed in `2026-08-30-renderer-neutral-terminal-state-primitives.md`.
- [x] Consumer proof closed in `2026-08-30-composable-terminal-consumer-proof.md`.
- [x] Focused verification: package check/build, 32 TUI tests, targeted Biome check and the packed
  Bun/Node/Bundler/PTY lane are green.
