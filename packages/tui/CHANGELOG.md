# Changelog

## [Unreleased]

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
