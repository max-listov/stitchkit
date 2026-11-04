# stitchkit-tui

The official composable terminal host for `stitchkit/agent-runtime`.

It supplies a full durable transcript, multiline composer, slash-command registry, live model
catalog picker, approval cards, conversation switching and an authenticated local session socket.
The package never owns provider policy or tools: applications compose those in one typed config.
The default shell keeps the terminal's own canvas, executes the highlighted slash suggestion on
Enter and shows a compact two-row status line with model capacity and durable usage.

Applications that own a different terminal product shell import the pure state layer instead:

```ts
import {
  createTerminalCollection,
  reduceTerminalCollection,
  createTerminalPaneState,
} from 'stitchkit-tui/core';

let sessions = createTerminalCollection(['one', 'two'], 8, 'two');
sessions = reduceTerminalCollection(sessions, {
  type: 'reconcile',
  keys: ['two', 'one'],
});

const panes = createTerminalPaneState({
  totalSize: 120,
  primarySize: 48,
  minPrimary: 32,
  minSecondary: 48,
});
```

`stitchkit-tui/core` imports no React, OpenTUI or agent-runtime code. Session cards, process
supervision, restart policy and runtime adapters remain with the embedding product.

## Building terminal applications

`stitchkit-tui/widgets` turns that state into finished screens — a CLI front-end, a monitor, a
dashboard, an agent console — on OpenTUI. See every widget live first:

```bash
bunx stitchkit-tui-gallery
```

F1–F3 switch between a method catalogue (sections, fuzzy search, a form generated from JSON Schema,
a confirmation, a spinner, a JSON result, toasts), a process monitor and the small widgets; Ctrl+T
cycles auto/dark/light and Ctrl+L switches English/Russian.

```tsx
import { createCliRenderer } from '@opentui/core';
import { createRoot, useTerminalDimensions } from '@opentui/react';
import { useReducer } from 'react';
import {
  createTerminalList,
  reduceTerminalList,
  terminalLabelsRu,
} from 'stitchkit-tui/core';
import {
  TerminalAppShell,
  TerminalLabelsProvider,
  TerminalList,
  TerminalThemeProvider,
  terminalListKeymap,
} from 'stitchkit-tui/widgets';

function Home() {
  const { width, height } = useTerminalDimensions();
  const [list, dispatch] = useReducer(reduceTerminalList, undefined, () =>
    createTerminalList({
      sections: [{ id: 'methods', title: 'Методы' }],
      items: [
        { key: 'search', title: 'Поиск по всем методам', description: 'Найти метод по имени и описанию' },
        { key: 'docs_read', title: 'docs_read', section: 'methods', meta: 'content' },
      ],
    }),
  );
  return (
    <TerminalAppShell
      breadcrumbs={['Каталог', 'Главная']}
      status={[[{ text: 'Каталог загружен' }, { text: '42 метода' }]]}
      bindings={terminalListKeymap(terminalLabelsRu, { searchable: true })}
      width={width}
      height={height}
    >
      <TerminalList state={list} onAction={dispatch} searchable width={width} height={height - 4} />
    </TerminalAppShell>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(
  <TerminalThemeProvider mode="auto">
    <TerminalLabelsProvider labels={terminalLabelsRu}>
      <Home />
    </TerminalLabelsProvider>
  </TerminalThemeProvider>,
);
```

What the widgets promise:

- **State is yours.** Every widget renders a `create…`/`reduce…` state from `stitchkit-tui/core`
  and reports actions; the application keeps it in `useReducer` or a store and can test it without a
  terminal.
- **Keys are data.** A keymap answers keys and draws the footer, which shortens labels and drops the
  least important hints to fit the width. Focus is a ring plus layers: a dialog takes the keyboard
  and returns it.
- **Foreign text is sanitized.** Anything shown from data passes `sanitizeTerminalText`; JSON is
  printed toned and escaped.
- **Live screens stay put.** Tables and lists draw only their window, rows are rewritten in place,
  every line has a fixed position, and a time series is bounded by its window. The kit's own
  binaries run React's production build; set `NODE_ENV=production` for any screen that lives for
  hours, because React's development build records a measure for every render and Bun keeps them.
- **Words and colours have one source.** `TerminalLabels` (English and Russian bundled) and one
  semantic `TerminalPalette` per terminal background, followed automatically in `auto` mode.

React, `@opentui/core` and `@opentui/react` are peers: install them in the application, so one copy
of each drives the whole tree. `stitchkit` is needed only for the agent host below.

Every normal launch starts a fresh durable conversation. Use `/resume` (or `/sessions`) to pick
an earlier conversation, and `/clear` to leave the current one resumable while starting clean.
Embedding hosts that intentionally want a fixed identity may set `initialConversationId`.

```ts
import { defineAgentTui, runAgentTui } from 'stitchkit-tui';

const config = defineAgentTui({
  context: () => ({}),
  modelCatalog,
  createRuntime: ({ catalog, selections }) => ({ harness, conversations }),
  statusLine: ({ model, activity, conversationId }) => [
    [{ text: model?.name ?? 'no model', tone: 'accent' }],
    [
      { text: conversationId.slice(0, 8), tone: 'muted' },
      { text: activity.toLowerCase(), tone: 'success' },
    ],
  ],
});

await runAgentTui(config);
```

Omit `statusLine` for the default projection, provide a formatter to replace every row, or set it
to `false` to hide the status line. The formatter receives the selected catalog entry, workspace,
activity, local identities and the canonical durable snapshot; it does not receive guessed token
counts. `theme` overrides colours of the kit's `TerminalPalette`, and `themeMode` picks the dark or
light palette.

The bundled CLI loads `stitchkit.agent.ts` by default:

```bash
stitchkit-agent run
stitchkit-agent sessions --workspace /path/to/project
stitchkit-agent send --session SESSION_ID --idempotency-key CALLER_KEY -- "Continue the review"
stitchkit-agent interrupt --session SESSION_ID
```

Local clients authenticate through a mode-`0600` descriptor and Unix socket. They submit through
the live TUI controller, so there is one runtime owner and one durable admission path.
Startup resumes still-queued work and safely skips acquired work by default. A host may provide
`recover` only when it can derive stronger replay evidence; the TUI never invents
`replaySafe: true` for application side effects.

Each terminal session writes a bounded, rotating metadata journal under
`.stitchkit/logs/tui/<session-id>.jsonl`. It records conversation and run identities plus lifecycle
transitions; prompt/model text, reasoning, tool arguments, provider causes and credentials are
discarded before journal admission. Live-session files are retained, alongside the eight newest
inactive session journals.
