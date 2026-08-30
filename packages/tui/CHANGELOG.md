# Changelog

## [Unreleased]

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
