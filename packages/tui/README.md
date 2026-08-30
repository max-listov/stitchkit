# @stitchkit/tui

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
} from '@stitchkit/tui/core';

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

`@stitchkit/tui/core` imports no React, OpenTUI or agent-runtime code. It owns only identity-stable
collections, feed viewport state, split panes, command selection and confirmed operations. Session
cards, process supervision, restart policy and runtime adapters remain with the embedding product.

Every normal launch starts a fresh durable conversation. Use `/resume` (or `/sessions`) to pick
an earlier conversation, and `/clear` to leave the current one resumable while starting clean.
Embedding hosts that intentionally want a fixed identity may set `initialConversationId`.

```ts
import { defineAgentTui, runAgentTui } from '@stitchkit/tui';

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
counts. `theme` remains an independent semantic color override.

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
