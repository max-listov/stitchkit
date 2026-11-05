# Upgrading stitchkit-tui

## Released migration: 0.4.0

### Two more labels

**Who must act:** projects that build their own `TerminalLabels` object instead of spreading
`terminalLabelsEn` or `terminalLabelsRu`.

Add the two words; `tsc` names the object that lacks them.

```ts
const labels: TerminalLabels = {
  ...myLabels,
  noFields: 'No parameters · Enter to run',
  crashed: 'The application stopped on an error',
};
```

### Start through runTerminalApp

**Who must act:** applications that create the renderer themselves (`createCliRenderer` +
`createRoot`) and catch signals to destroy it. Nothing breaks if you keep that code; replace
it to drop the copy:

```tsx
// before
const renderer = await createCliRenderer();
createRoot(renderer).render(<TerminalThemeProvider mode='auto'><Home /></TerminalThemeProvider>);
process.on('SIGHUP', () => { renderer.destroy(); process.exit(129); });
// after
await runTerminalApp(<Home />, { onClose: () => store.close() });
```

### runAgentTui exits on signals

**Who must act:** hosts that embed `runAgentTui` and must keep their process running after
Ctrl-C, SIGTERM, SIGHUP or another signal OpenTUI catches.

`runAgentTui` now closes its session and exits the process on those (128 + the signal number,
0 for Ctrl-C, the quit key), waiting at most `closeTimeoutMs` (5000 ms) for the close. Pass `exitSignals: []` to keep
the process, and call the returned `close()` yourself:

```ts
const running = await runAgentTui(defineAgentTui({ ...config, exitSignals: [] }));
process.on('SIGTERM', () => void running.close());
```

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
