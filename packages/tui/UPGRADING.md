# Upgrading stitchkit-tui

## Released migration: 0.3.0

### One palette for the kit

**Who must act:** projects that import `AgentTuiTheme`, `defaultAgentTuiTheme`,
`resolveAgentTuiTheme` or `AgentTuiStatusTone`.

1. Replace `AgentTuiTheme` with `TerminalPalette` and `AgentTuiStatusTone` with `TerminalTone`, both
   from `stitchkit-tui/core`.
2. Replace `defaultAgentTuiTheme` with `terminalPalettes.dark` and `resolveAgentTuiTheme(theme)` with
   `resolveTerminalPalette('dark', theme)`.
3. A `theme` passed to `defineAgentTui` keeps working as-is; add `themeMode: 'light'` for a light
   terminal.

### React and OpenTUI are peers

**Who must act:** projects that install `stitchkit-tui` without `react`, `@opentui/core` and
`@opentui/react` in their own dependencies.

```bash
bun info stitchkit-tui peerDependencies
bun add react @opentui/core @opentui/react
```

Projects that use only `stitchkit-tui/core` or `stitchkit-tui/widgets` may drop `stitchkit` if
nothing else needs it.

## Released migration: 0.2.0

### stitchkit is a peer

**Who must act:** projects that install `stitchkit-tui` without listing `stitchkit` themselves.

`stitchkit-tui` no longer installs the framework for you: add `stitchkit` to your own
`dependencies`, in the range the new `stitchkit-tui` declares as its peer (`bun info
stitchkit-tui peerDependencies`). Remove any `overrides` entry that forced a single stitchkit copy —
the peer makes it unnecessary.

## Released migration: 0.1.0

Initial release. Existing headless runtime compositions remain valid; adopting the terminal host
is optional.
