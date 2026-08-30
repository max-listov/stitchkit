---
title: Agent TUI productization program
description: Turn the reference terminal host into an official composable package over the headless agent runtime.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 0
depends-on: —
completed: 2026-08-30
---

# Agent TUI productization program

## Зачем

The editable agent starter proves the runtime in a real terminal, but it currently owns product
mechanics that every terminal host would have to copy: command routing, model discovery and
selection, conversation navigation, transcript viewport state and local process attachment. The
framework needs one optional official TUI composition without moving rendering dependencies into
the core package or replacing the lower-level runtime and tool surfaces.

## Результат

- `stitchkit` remains the headless source of durable agent, model, tool and control semantics.
- `@stitchkit/tui` owns the Bun/OpenTUI terminal product, a binary and an editable typed config.
- `create-stitchkit --template agent` becomes a thin consumer of that package.
- A running terminal exposes a local session identity and accepts authenticated programmatic input
  into the same durable conversation.
- The full OpenRouter tool-capable catalog is searchable; current popularity and benchmark signals
  are presented with their source and observation timestamp, never inferred from model names.
- The release tree has package, packed-consumer, PTY and publication-plan coverage but is not
  published until a separate release command.

## План

- [x] Complete the coding-tool surface and bounded search task.
- [x] Complete the provider-neutral model catalog and selection task.
- [x] Complete the durable conversation control and local attachment task.
- [x] Complete the official TUI package task.
- [x] Complete the starter migration and release-readiness task.
- [x] Run the named 2/2 validation conveyor across the whole program.

## Порядок

The first three tasks define independent headless contracts and may proceed in parallel. The TUI
depends on all three because it is a projection and controller, not another runtime. The starter
and release wiring follow last so packed fixtures exercise the public package rather than copied
source.

## Acceptance

- [x] Every child task is in `done/` with its own named evidence.
- [x] `bun run verify` passes on the complete review tree.
- [x] A real PTY run covers model selection, a direct tool call, scrolling, interruption and local
  programmatic submission to the displayed session id.
- [x] No release, tag, publication or deploy occurs in this conveyor.

## Что сделано

The program leaves core headless and adds one optional official TUI package, a thin generated agent
consumer, direct coding tools, live model discovery with separately sourced evidence, durable
conversation navigation and authenticated local attachment. Two independent read-only validators
audited runtime safety and terminal/product behavior; their P0/P1 findings were fixed before the
final gate. A real generated-agent PTY run selected a live model, called `read_file`, scrolled,
accepted an external submission into the displayed session and interrupted its active run.

## Регрессия

- `packages/core/tests/agent-coding-tools.test.ts` — `preserves direct identities across bounded
  read, write, patch and command calls`.
- `packages/tui/tests/controller.test.ts` — `keeps selections isolated per conversation and applies
  changes to the next submit`.
- `packages/tui/tests/session.test.ts` — `routes authenticated external submissions through the
  live host`.
- `packages/tui/tests/recovery.test.ts` — `resumes queued work but never invents replay safety for
  an acquired run`.
