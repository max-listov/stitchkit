---
title: Official agent TUI package
description: Ship a composable OpenTUI terminal host over the public headless harness and control contracts.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
pipeline: agent-tui-productization
order: 4
depends-on: 2026-08-30-coding-tool-surface-and-search.md, 2026-08-30-agent-model-catalog-and-selection.md, 2026-08-30-agent-conversation-control-and-local-attach.md
completed: 2026-08-30
---

# Official agent TUI package

## Зачем

Terminal product mechanics should be reusable and customizable without becoming core runtime
dependencies. A host should be able to run the official interface as-is or supply its own harness,
model catalog, commands, theme and renderers through one typed entrypoint.

## Результат

- `@stitchkit/tui` exports `defineAgentTui`, a host runner and reusable controller/view primitives.
- Its binary starts from `stitchkit.agent.ts` and exposes local `run`, `sessions`, `status`, `send`
  and `interrupt` commands.
- The interface has a multiline composer, typed slash-command registry, searchable overlays,
  complete transcript scrolling and honest activity/error states.
- Built-ins include `/help`, `/model`, `/new`, `/sessions`, `/resume`, `/status`, `/tools`,
  `/skills`, `/permissions`, `/interrupt`, `/clear` and `/quit`.

## План

- [x] Add the package, build/typecheck/test scripts, exports, binary and typed config loader.
- [x] Implement a command registry with aliases, availability, completion and typed outcomes.
- [x] Implement transcript viewport state: follow-tail, manual scroll, unseen indicator and
  line/page/home/end navigation.
- [x] Implement composer history, draft preservation, multiline input and slash completion.
- [x] Implement model and session selection plus honest tool, skill, permission and status overlays.
- [x] Render tool calls and results compactly with direct names and bounded durable projections.
- [x] Derive admission availability from canonical active runs; keep the last failure as a notice
  instead of an absorbing activity state.
- [x] Send raw provider/tool causes only to operator diagnostics with run/session correlation while
  the model and terminal transcript retain the generic safe envelope.
- [x] Add controller and rendering regression fixtures including long and multimodal output, then
  exercise the packed binary in a real PTY acceptance run.

## Acceptance

- [x] `bunx @stitchkit/tui` can run an unmodified typed config after publication.
- [x] Unknown slash-prefixed user text is never destroyed merely because no command matches.
- [x] Manual scrolling is stable while streaming and follow-tail resumes only on an explicit action.
- [x] A failed tool or provider run settles visibly and leaves the composer usable.
- [x] A canonical Stitchkit tool-error envelope renders as failure even when the provider SDK call
  itself completed successfully.
- [x] OpenTUI/React dependencies are absent from the `stitchkit` core runtime graph.

## Что сделано

`@stitchkit/tui` is an optional Bun/OpenTUI package over one public controller. It provides the
typed config, binary, slash registry, multiline composer, full-catalog model picker, durable
conversation picker, transcript viewport, approval UI and local session commands. Recovery skips
acquired work unless the embedding host supplies explicit evidence; shutdown removes listeners,
renderer and session artifacts through one idempotent close path.

## Регрессия

- `packages/tui/tests/commands.test.ts` — `resolves built-ins and leaves unknown slash input as a
  model prompt` and `fails closed on builtin, custom and alias collisions`.
- `packages/tui/tests/composer-viewport.test.ts` — `stops following while reading history and counts
  unseen appended rows`.
- `packages/tui/tests/transcript.test.ts` — `keeps multimodal files visible and bounds long tool
  output`.
- `packages/tui/tests/keyboard.test.ts` — `recognizes Ctrl+C in raw mode without treating plain c
  as exit`.
- `packages/tui/tests/recovery.test.ts` — `resumes queued work but never invents replay safety for
  an acquired run`.
