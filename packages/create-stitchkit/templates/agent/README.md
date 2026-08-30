# Stitchkit Agent

A small, real terminal coding agent. The official TUI package owns terminal interaction while
Stitchkit owns durable messages, runs, direct typed tools, approvals, recovery and resources.

## Start

```bash
cp .env.example .env
# Fill OPENROUTER_API_KEY.
bun run dev
```

Use `/model` to choose any live tool-capable model. Weekly popularity and benchmark facts stay
separate in the catalog. File reads and searches run directly. Writes, patches and shell commands
show an approval card bound to the exact durable tool call; press `Y` or `N`.

Source edits restart the terminal host through `bun --watch`, while `.stitchkit/agent.sqlite`
retains durable conversations and recovery evidence. Every launch opens a fresh conversation;
use `/resume` to return to an earlier one. `/clear` starts clean without deleting the conversation
you are leaving.

## Shape

- `stitchkit.agent.ts` — the small, typed composition point for theme, catalog and runtime policy.
- `src/runtime.ts` — host policy and composition of published Stitchkit primitives.
- `@stitchkit/tui` — commands, transcript, model/session pickers and local attach protocol.
- `instructions/` — eager instructions with explicit provenance.
- `skills/*/SKILL.md` — lazily discoverable skills read through the direct `read_resource` tool.
- `.stitchkit/` — ignored local durable state, session descriptors, bounded metadata diagnostics
  and approval secret.

While the TUI is open, `/status` shows its session ID. Another local process can submit through
the same controller without racing the runtime:

```bash
bunx stitchkit-agent send --session SESSION_ID -- "Inspect the current project"
```

The coding root is a path boundary, not an operating-system sandbox. Run the process in a container
or another isolated environment before granting it access to untrusted projects or executables.
