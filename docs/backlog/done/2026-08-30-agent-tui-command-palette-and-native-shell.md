---
title: Agent TUI command palette and terminal-native shell
description: Make command completion executable, simplify the terminal shell and expose a typed customizable status line.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 08:43 +0000
related: docs/backlog/done/2026-08-30-fresh-agent-tui-sessions-and-safe-diagnostics.md
---

# Agent TUI command palette and terminal-native shell

## Зачем

The command menu currently looks selected without owning keyboard selection: Enter can submit a
partial slash command to the model instead of opening the advertised command. The shell also
paints an application-wide canvas, spends permanent space on raw identities and key hints, and
does not expose enough runtime facts for an embedding host to shape a useful status line.

## Результат

- Slash suggestions are one keyboard-owned palette: arrows move selection, Tab completes it and
  Enter executes the selected exact command without admitting a model run.
- The default shell preserves the terminal canvas, keeps identity details in `/status`, and uses a
  compact header and focused composer without permanent keyboard instructions.
- A typed status-line formatter can replace or disable the default rows. The default reports the
  selected model, its context capacity, durable usage that is actually available, activity and
  short local identity.

## План

- [x] Extract deterministic command-palette selection and submission rules with regression tests.
- [x] Add a typed status-line context, formatter and truthful default projection.
- [x] Recompose the OpenTUI shell around terminal-native surfaces and compact interaction chrome.
- [x] Document the public customization surface and changed default behavior.
- [x] Run only the focused TUI test, typecheck and build lanes, then exercise the live starter path.

## Acceptance

- [x] Typing `/mo` and pressing Enter opens the model picker and creates no durable model run.
- [x] Up/Down, Tab, Enter and Escape have deterministic palette behavior.
- [x] The default screen has no full-canvas blue fill, raw UUID header or permanent key-hint footer.
- [x] Context capacity and known durable usage are visible without estimating unavailable figures.
- [x] An embedding host can replace the status rows or turn them off through `defineAgentTui`.
- [x] Focused package gates pass without running the repository-wide full gate.

## Что сделано

- [x] Command palette — `packages/tui/src/commands.ts` owns exact selection, wraparound navigation
  and submit-time resolution; `packages/tui/tests/commands.test.ts` covers partial selection,
  dismissal and navigation.
- [x] Status projection — `packages/tui/src/status-line.ts` exposes the formatter context and a
  default based only on catalog capacity and durable snapshot usage;
  `packages/tui/tests/status-line.test.ts` covers known and unavailable usage.
- [x] Terminal shell — `packages/tui/src/App.tsx` keeps the terminal canvas, renders a compact
  header/composer and removes raw identities and permanent key instructions from the main frame.
- [x] Public surface — `packages/tui/src/config.ts`, `packages/tui/README.md`,
  `docs/api/reference.md`, `CHANGELOG.md` and `packages/tui/CHANGELOG.md` document replaceable or
  disabled status rows and keyboard-owned command dispatch.
- [x] Focused verification — all 23 tests in `packages/tui/tests`, `bun run check`, package build
  and a live starter PTY passed. The live `/mo` → Enter path opened the 312-entry model picker and
  a read-only SQLite query confirmed zero runs in that fresh conversation.
- [x] The repository-wide full gate was intentionally not run for this visual/interaction slice.
