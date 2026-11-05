# Changelog

## [Unreleased]

## [0.4.0] - 2026-11-05

### ⚠️ Breaking changes

**Who must act:** projects that build their own `TerminalLabels` object instead of using
`terminalLabelsEn` / `terminalLabelsRu`, and hosts that relied on `runAgentTui` staying alive
after SIGINT or SIGTERM.

- `stitchkit-tui/core` — **`TerminalLabels` gains `noFields` and `crashed`.** A form without fields
  now says it has no parameters, and `runTerminalApp` heads an escaped render error; both words
  come from the labels like every other. Add the two strings to a custom labels object.
  `// before: { …labels }` → `// after: { …labels, noFields: 'No parameters · Enter to run', crashed: 'The application stopped on an error' }`.
  See the [migration](UPGRADING.md).
- `stitchkit-tui` — **`runAgentTui` exits the process on Ctrl-C, SIGTERM, SIGHUP and the other signals OpenTUI catches** after it
  closed the session host, the controller and the diagnostics, or after `closeTimeoutMs` (5000 ms)
  at the latest. It used to close on SIGINT and SIGTERM only and kept the process, and a closed
  window (SIGHUP) left a process drawing frames. A host that owns the process opts out:
  `// before: runAgentTui(config)` → `// after: runAgentTui(defineAgentTui({ …config, exitSignals: [] }))`.
  See the [migration](UPGRADING.md).

### Added

- `stitchkit-tui/core`, `stitchkit-tui/widgets` — `TerminalTable` draws state in colour: a row's
  `tone` (`muted` for a stopped process, `danger` for a failed one) and a column's
  `tone(value, row)` for one cell over it, from the palette of the terminal's background. The
  selected row keeps its tone; `danger` and `warning` are also bold and `muted` dim
  (`terminalToneAttributes`), so the state stays visible without colour. The gallery's monitor
  shows a STATE column with stopped services muted and errored ones red.
- `stitchkit-tui/widgets` — `runTerminalApp(screen, options)`: the renderer, the theme and labels
  providers, `TerminalErrorBoundary` showing the cause on screen, and an exit with 128 + the signal
  number after `onClose` on every signal OpenTUI catches (SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGABRT,
  SIGPIPE, SIGBUS), and with 0 on a Ctrl-C no screen took — the quit key, which raw mode delivers
  as a key, not as SIGINT. OpenTUI's own
  listeners only restore the terminal, which cancels each signal's default exit: any timer then
  kept a window-less process alive.
- `stitchkit-tui/build` — `compileTerminalApp` and `terminalNativePlugin`: one executable for any
  Bun compile target from any machine. The target's `@opentui/core-<os>-<arch>` comes from the
  registry at the version the installed `@opentui/core` pins, verified against `bun.lock`; other
  platforms' packages become a module that throws; musl targets are refused, because OpenTUI picks
  musl at run time. React's production build is defined at build time.
- `stitchkit-tui/testing` — `renderTerminalTest`: a screen inside the kit's providers on a test
  terminal; every key runs inside React's `act` and a lone Esc waits out the parser's escape
  timeout, so a test has no `act` and no sleeps.

### Fixed

- `stitchkit-tui/widgets` — `TerminalForm` without fields answers Enter with `onSubmit({})` and Esc
  with `onCancel`; it ignored every key.
- `stitchkit-tui/widgets` — a screen that throws under React's production build shows its error:
  OpenTUI's root boundary is compiled with `jsxDEV`, which production React does not export, and
  left the terminal blank.

### Changed

- Targets stitchkit `^0.120.0`, keeping consumers on one framework copy when they adopt the peer-free `stitchkit/tools` barrel.
- The README names how to choose React's production build: at build time, never by setting
  `NODE_ENV` at run time.
- The agent shell's palette follows the terminal's background while it runs, as the widgets do;
  it was chosen once at start.

## [0.3.0] - 2026-11-04

### ⚠️ Breaking changes

**Who must act:** projects that pass `theme` to `defineAgentTui`, import `AgentTuiTheme`,
`defaultAgentTuiTheme`, `resolveAgentTuiTheme` or `AgentTuiStatusTone`, or install `stitchkit-tui`
without `react`, `@opentui/core` and `@opentui/react` of their own.

- `stitchkit-tui` — **one palette for the whole kit.** `AgentTuiTheme`, `defaultAgentTuiTheme` and
  `resolveAgentTuiTheme` are removed; the agent host, the widgets and the status line read one
  `TerminalPalette` with a dark and a light variant, and every tone is a `TerminalTone`
  (`AgentTuiStatusTone` is gone). `theme` keeps its field names and gains `themeMode`.

  ```ts
  // before
  import { defaultAgentTuiTheme, type AgentTuiStatusTone } from 'stitchkit-tui';
  // after
  import { terminalPalettes, type TerminalTone } from 'stitchkit-tui/core';
  defineAgentTui({ /* … */ theme: { accent: '#e58a66' }, themeMode: 'light' });
  ```

- `stitchkit-tui` — **React and OpenTUI are peers; `stitchkit` is an optional peer.** An
  application that renders the kit's widgets inside its own tree needs the same React and renderer
  copy, so the package no longer installs its own. Add `react`, `@opentui/core` and
  `@opentui/react` in the ranges `bun info stitchkit-tui peerDependencies` prints. A monitor or CLI
  front-end that imports only `stitchkit-tui/core` or `stitchkit-tui/widgets` no longer needs
  `stitchkit`.

### Added

- `stitchkit-tui/widgets` — OpenTUI React widgets for building any terminal application: app shell
  with breadcrumbs, status lines, fitted key hints and toasts; titled panels; a virtualized live
  table with sort, tree, filter and htop keys; a sectioned picker with fuzzy search and match
  highlighting; forms generated from JSON Schema; text and JSON pagers; htop meters and a core grid;
  btop braille charts and sparklines; tabs with badges; spinner, progress bar, loading/error/empty
  states, confirmation dialog, details and key help. The palette follows the terminal's reported
  background, and every word comes from `TerminalLabels` (English and Russian bundled).
- `stitchkit-tui/core` — the renderer-neutral state behind them: table, list, form (with
  `terminalFormFieldsFromJsonSchema`), tabs, navigation stack, focus ring with layers, notices,
  bounded time series, meters, progress and spinners, conflict-checked keymaps that also draw the
  footer, multi-word fuzzy search, cell-width text measurement, truncation and wrapping, and
  `sanitizeTerminalText` for any text the application did not write.
- `stitchkit-tui-gallery` — every widget live in one binary: a method catalogue, a process monitor
  and the small widgets, switchable between palettes and languages.

### Fixed

- `stitchkit-tui` — `stitchkit-agent` runs React's production build unless `NODE_ENV` says
  otherwise. The development build records a performance measure with a props diff for every
  render and Bun keeps them all, so a long session grew without bound.
- `stitchkit-tui/core` — `reduceTerminalCollection` and `visibleTerminalCollectionRange` no longer
  re-validate every key on each cursor step; keys are validated when they arrive.

## [0.2.14] - 2026-11-04

### Changed

- Targets stitchkit `^0.119.0`, keeping consumers on one framework copy when they adopt the configured factory exposure, the raw tracking attribution and the complete GeoIP snapshot. Renders through `@opentui/core` and `@opentui/react` 0.8 and resolves `ai` 7.0.162 and Zod 4.6.7. No terminal source change is needed.

## [0.2.13] - 2026-11-03

### Changed

- Targets stitchkit `^0.118.0`, keeping consumers on one framework copy when they adopt the Telegram update queue fixes. No terminal source change is needed.

## [0.2.12] - 2026-11-02

### Changed

- Targets stitchkit `^0.117.0`, keeping consumers on one framework copy when they adopt the per-chat Telegram pause and the tracking contract entry. No terminal source change is needed.

## [0.2.11] - 2026-11-02

### Changed

- Targets stitchkit `^0.116.0`, keeping consumers on one framework copy when they adopt the send-only Telegram pause. No terminal source change is needed.

## [0.2.10] - 2026-11-02

### Changed

- Targets stitchkit `^0.115.0`, keeping consumers on one framework copy when they adopt contained CLI downloads. No terminal source change is needed.

## [0.2.9] - 2026-10-30

### Changed

- Targets stitchkit `^0.114.0`, keeping consumers on one framework copy when they adopt the shared Telegram outbound budget and the new send-failure reason. No terminal source change is needed.

## [0.2.8] - 2026-10-26

### Changed

- Targets stitchkit `^0.113.0`, keeping consumers on one framework copy when they adopt the agent-runtime store driver's `insert` history mutation. No terminal source change is needed.

## [0.2.7] - 2026-10-24

### Changed

- Targets stitchkit `^0.112.0`, keeping consumers on one framework copy when they adopt the explicit CLI array positional grammar. No terminal source change is needed.

## [0.2.6] - 2026-10-17

### Changed

- Targets stitchkit `^0.111.0`, keeping consumers on one framework copy when they adopt the bounded request-body defaults. No terminal source change is needed.

## [0.2.5] - 2026-10-14

### Changed

- Targets stitchkit `^0.110.0`, keeping consumers on one framework copy when they adopt the core lifecycle classification change. No terminal source change is needed.

## [0.2.4] - 2026-10-10

### Changed

- Targets stitchkit `^0.109.0` (peer range `^0.108.0` → `^0.109.0`). No terminal source
  change is needed; the companion release keeps consumers on one framework copy when they adopt
  the new core version.

## [0.2.3] - 2026-10-06

### Changed

- Targets stitchkit `^0.108.0` (peer range `^0.107.0` → `^0.108.0`). No source change: the
  terminal uses none of the `stitchkit/telegram`, `stitchkit/files/packaging` or stream-reader
  names 0.108.0 changed.

## [0.2.2] - 2026-10-06

### Changed

- Targets stitchkit `^0.107.0` (peer range `^0.106.0` → `^0.107.0`). No source change: the
  terminal uses neither `stitchkit/files/packaging` nor the Darwin loader that 0.107.0 changed.

## [0.2.1] - 2026-10-06

### Changed

- Targets stitchkit `^0.106.0` (peer range `^0.105.0` → `^0.106.0`). No source change: the
  terminal uses none of the `stitchkit/process` names 0.106.0 changed.

## [0.2.0] - 2026-10-05

### ⚠️ Breaking changes

**Who must act:** projects that install `stitchkit-tui` without listing `stitchkit` in their own
dependencies.

- `stitchkit-tui` — **`stitchkit` is a peer dependency, not a dependency.** The project's own
  stitchkit is the one the terminal uses, so an install holds a single copy of the framework. As a
  dependency, the range frozen when the package was packed (`^0.94.0` in 0.1.4) gave every project
  on a newer framework a second, older stitchkit beside its own, and errors crossing the package
  boundary failed `instanceof`.

  ```jsonc
  // before — stitchkit arrived through stitchkit-tui
  { "dependencies": { "stitchkit-tui": "^0.1.4" } }
  // after — the project names the framework it runs
  { "dependencies": { "stitchkit-tui": "^0.2.0", "stitchkit": "^0.105.0" } }
  ```

## [0.1.4] — 2026-09-23

### Fixed

- **Depends on stitchkit `^0.94.0`, as 0.1.3 meant to.** 0.1.3 was published
  depending on `^0.93.0`: the packer takes a workspace version from the
  lockfile, which still recorded the previous core release. A project on 0.94.0
  therefore installed a second, older framework beside the terminal. The
  release gate now refuses a lockfile that disagrees with the manifests.

## [0.1.3] — 2026-09-23

### Changed

- Meant to target stitchkit 0.94.0 (published range `^0.90.5` → `^0.94.0`), but
  shipped depending on `^0.93.0` — see 0.1.4. No source change was needed: the
  terminal imports none of the names 0.94.0 moved.
- Updated OpenTUI to 0.5.12 and the AI SDK to 7.0.111.

## [0.1.2] — 2026-09-20

### Changed

- Updated the OpenTUI, AI SDK, React and Zod runtime set to their current compatible
  stable releases, with matching React and Bun declarations for consumers.

## [0.1.1] — 2026-08-30

### Fixed

- The official terminal package publishes as `stitchkit-tui`, matching the existing unscoped
  `stitchkit` and `create-stitchkit` family. The unavailable `@stitchkit` registry namespace is
  not part of the public package identity.

## [0.1.0] — 2026-08-30

### Added

- Official composable Agent TUI with durable transcript, multiline composer, slash commands,
  model and conversation pickers, per-call approvals, scrolling and custom themes.
- Authenticated local session discovery and `status`, `send` and `interrupt` commands that reuse
  the terminal host's single runtime controller.
- Fresh-by-default launch and clear semantics, explicit `/resume` conversation selection and a
  bounded metadata-only lifecycle journal per terminal session.
- Terminal-native default chrome, executable keyboard-owned slash suggestions and replaceable
  typed status rows with selected-model context capacity and durable usage.
- Renderer-neutral `stitchkit-tui/core` collection, feed, pane, command and operation state
  machines for richer terminal applications that do not import the official agent view.
- Searchable bounded model picker, identity-checked concurrent conversation switching, independent
  atomic model-selection records and packed Bun/Node plus PTY lifecycle proofs.
