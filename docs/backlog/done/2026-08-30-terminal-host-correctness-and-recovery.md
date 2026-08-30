---
title: Terminal host correctness and recovery
description: Close recovery, attachment, model-continuation, viewport and shutdown gaps before the terminal host becomes a reusable dependency.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 09:15 +0000
pipeline: composable-terminal-primitives
order: 1
depends-on: 2026-08-30-composable-terminal-primitives-program.md
---

## Зачем

Reusable terminal mechanics amplify their invariants. A host that guesses replay safety, applies a
new model to an existing approval, accepts a reused PID as a live session or leaves the terminal in
raw mode after a failed close is not a safe foundation for another application.

## Результат

- Recovery is host-policy driven and defaults closed for runs whose side effects are unknown.
- Approval continuation preserves the admitted run's durable model identity.
- Conversation refreshes, session discovery and process cleanup reject stale generations.
- The live transcript viewport owns follow-tail/manual-scroll state and reports unseen content.
- Model selection is searchable across the bounded catalog and exposes metadata provenance.

## План

- [x] Replace unconditional recovery replay with an explicit host policy and safe default.
- [x] Preserve pinned model identity through approval continuation and discard stale refreshes.
- [x] Authenticate discovered local sessions and make startup/close cleanup idempotent.
- [x] Connect the viewport reducer to the rendered transcript and expose unseen/follow-tail state.
- [x] Make model selection searchable and bounded without silently truncating the catalog.
- [x] Add focused regression and terminal lifecycle coverage.

## Acceptance

- [x] A non-queued interrupted run is never re-executed without positive host policy.
- [x] Changing the selected model while approval is pending does not change the continuation model.
- [x] A stale refresh or reused PID cannot replace the active conversation/session state.
- [x] Manual scroll remains stable while deltas arrive and returning to tail clears unseen state.
- [x] Cleanup restores the terminal and removes local session artifacts on success and failure.

## Что сделано

- [x] Recovery and continuation: `packages/tui/src/run.tsx` and
  `packages/tui/src/controller.ts`; regression cases `Agent TUI recovery policy > resumes queued
  work but never invents replay safety for an acquired run`, `continues an approval with the model
  pinned in durable run evidence` and `discards a slower conversation switch after a newer identity
  wins`.
- [x] Local identity and selections: `packages/tui/src/session.ts` and
  `packages/tui/src/config.ts`; regression cases `does not publish a stale descriptor merely because
  its pid was reused` and `keeps concurrent hosts and conversations in independent atomic records`.
- [x] Live terminal behavior: `packages/tui/src/App.tsx`, `packages/tui/src/model-picker.ts` and
  `packages/tui/src/core/viewport.ts`; regression cases `stops following while reading history and
  counts unseen appended rows` and `searches the complete catalog but retains only the renderer
  bound`.
- [x] Real lifecycle: `scripts/tui-packed-lane.ts` runs packed success and failing-close PTYs, then
  proves no descriptor/socket remains.
