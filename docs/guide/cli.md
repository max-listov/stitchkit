# CLI

The same contract that drives the HTTP API, MCP tools and agent tools also
drives a command-line program. `createCli` turns contract methods into commands
— `myapp generate "a fox" --wait`, `myapp models list --json | jq …` — run
through the very same validation, auth gate and error model as every other
surface (HTTP ≡ MCP ≡ agent ≡ CLI, [ADR 0014](../decisions/0014-tool-http-parity.md)).

It exists for what the other three surfaces cannot do: a generation kicked off
with `Bash(run_in_background)` that notifies on exit, a `SKILL.md` that shells
out in one line, a pipeable terminal command.

## Exposure is opt-in

Unlike MCP and agent — where an endpoint with no `expose` is a tool by default —
**a method becomes a CLI command only when its `expose` lists `'CLI'`.** Adding
the CLI never silently turns your existing API tools into shell commands.

```ts
{ method: 'POST', path: '/', desc: 'Generate media', toolName: 'generate',
  expose: ['CLI', 'MCP', 'AGENT'], input: GenerateInput, output: Generation }   // CLI + MCP + agent
{ method: 'GET', path: '/models', desc: 'List models', toolName: 'list_models',
  expose: ['CLI'] }                                                             // CLI only
{ method: 'GET', path: '/search', desc: 'Search' }                              // HTTP + MCP + AGENT — NOT CLI
```

A fresh contract shows **zero** CLI commands until methods opt in — that is the
design, not a bug. The command name is the tool name — `toolName` if set, else a
verb-aware name from the method + prefix (`list` → `list_widgets`, `get` →
`get_widget`), not a literal `prefix_key`.

## A minimal CLI

stitchkit ships no binary — you write the executable and point your app's `bin`
at it:

```ts
#!/usr/bin/env node
// src/cli.ts
import { createCli } from 'stitchkit/cli'
import { catalogService, generateService } from './services'

await createCli({
  name: 'myapp',
  version: '1.0.0',
  services: [catalogService, generateService],
  auth: process.env.MYAPP_TOKEN,            // resolved ONCE, like a stdio MCP server
})
```

```json
// package.json
{ "bin": { "myapp": "./dist/cli.js" } }
```

`stitchkit/cli` pulls in neither the MCP SDK nor `ai`, so a CLI binary needs no
MCP/agent peer dependencies.

## Calling commands

```
<app> <command> [positional] [--flags]
```

Arguments are coerced to the contract schema's types — every argv token is a
string, the schema says what it should be:

| Zod field            | CLI                                            |
| -------------------- | ---------------------------------------------- |
| `z.string()`         | `--name "box"` or a positional                 |
| `z.number()`         | `--count 3` → `3`                              |
| `z.boolean()`        | `--active` (presence) / `--no-active`          |
| `z.enum([...])`      | `--size large`                                 |
| `z.array(z.string())`| `--tag a --tag b` → `["a","b"]`                |
| `z.object({...})`    | `--opts '{"k":"v"}'` (JSON) or `--opts.k v`    |
| `.optional()` / `.default()` | not required                           |

Positional arguments fill non-boolean fields in declaration order, so
`myapp generate "a fox"` is `--prompt "a fox"`. A piped value fills the first
unset field: `echo "a fox" | myapp generate`.

The advertised schema is never mutated — a CLI call validates against the exact
same Zod schema an HTTP or MCP call does.

## Global flags

| Flag                  | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `--json`              | Raw JSON on stdout for piping / scripts                    |
| `--wait`              | Block-poll an async result to a terminal state             |
| `--wait-timeout <s>`  | Override the `--wait` timeout                              |
| `--output-dir <dir>`  | Download result media into a directory                     |
| `--quiet`             | Suppress non-essential stderr output                       |
| `--dry-run`           | Print the resolved call without executing                  |
| `--help`, `-h`        | Usage — top-level or per-command flag table                |

stdout carries the result; errors and progress go to stderr, so `--json` stays
pipeable and `2>/dev/null` stays clean. The process exit code carries the error
class (`0` ok, `VALIDATION_ERROR → 1`, `UNAUTHORIZED → 2`, `FORBIDDEN → 3`,
`NOT_FOUND → 4`, …) — override per app with `exitCodes`.

## `--wait` — background-friendly generation

`--wait` polls an async result until it is done. It is generic — the core knows
nothing about "generations": you say how to read the poll target, which command
to re-call and when it is done.

```ts
await createCli({
  name: 'myapp',
  version: '1.0.0',
  services,
  wait: {
    generate: {
      tool: 'get_generation',
      poll: (r) => (isRecord(r) && typeof r.id === 'string' ? { id: r.id } : null),
      done: (r) => isRecord(r) && r.status === 'COMPLETED',
    },
  },
})
```

```bash
# foreground
myapp generate "a fox" --wait --output-dir ./out

# background — frees the agent; a notification fires on exit
myapp generate "a fox" --wait --json > result.json &
```

## Auth parity

A scoped command is guarded by the same `createAuthHook` your HTTP server uses —
pass it as `lifecycle`, and inject the identity through `context` so
`resolveFromContext` can read it:

```ts
const authHook = createAuthHook({ /* resolve, resolveFromContext, rules */ })

await createCli({
  name: 'myapp',
  version: '1.0.0',
  auth: await resolveIdentityFromToken(process.env.MYAPP_TOKEN),
  context: (identity) => ({ user: identity }),   // resolveFromContext reads this
  lifecycle: { beforeHandle: authHook },          // same gate as HTTP
  services,
})
```

Without `lifecycle`, a scoped command runs **unguarded** — the scope check lives
entirely inside the `createAuthHook` result, so with no hook wired in there is
nothing to enforce a method's `scope`. This matches the MCP / agent surfaces
exactly ([ADR 0014](../decisions/0014-tool-http-parity.md)): on every tool
transport the auth gate is opt-in, so a contract with scoped methods **must** be
given a `lifecycle` (and `context` identity) to be protected. The gate only
*fails closed* once the hook **is** present but `resolveFromContext` is missing —
then a scoped call has no identity and is rejected.

## Typed context

Use `createToolkit<AppContext>()` to type the injected `context` against your
app's context shape — the tool-side mirror of `createImplement`
([ADR 0017](../decisions/0017-typed-tool-context.md)):

```ts
const tools = createToolkit<{ user: User }>()
await tools.createCli({
  name: 'myapp',
  version: '1.0.0',
  services,
  context: (identity) => ({ user: identity }),   // checked against { user: User }
})
```

## Not in v1

File-upload (`multipart`) endpoints are CLI-invisible, the same as on MCP /
agent — a dedicated upload command (auto-uploading local paths) is future work.
Streaming (SSE) output is not yet piped to stdout.
