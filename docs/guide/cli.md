# CLI

The same contract and managed runtime tools that drive HTTP, MCP and agent
surfaces can also drive a command-line program. `createCli` composes their
commands with explicitly local binary commands in one router and help tree.
Managed commands — `myapp generate "a fox" --wait`,
`myapp models list --json | jq …` — run through the same validation, auth gate
and error model as every other managed surface (HTTP ≡ MCP ≡ agent ≡ CLI,
[ADR 0014](../decisions/0014-tool-http-parity.md)).

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
design, not a bug. A pathless runtime definition follows the same rule: it must
explicitly include `'CLI'` in `transports`; the undefined default remains
`['MCP', 'AGENT']`. The command name is the tool name — `toolName` if set, else
a verb-aware name from the method + prefix (`list` → `list_widgets`, `get` →
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
  resolveAuth: () => resolveToken(process.env.MYAPP_TOKEN), // lazy, at most once
})
```

`createCli({ signal })` and its wait loop honor an explicit caller
`AbortSignal`. Stitchkit does not install a process-global SIGINT handler for
ordinary CLI programs: if desired, the application binds SIGINT to an
`AbortController` and passes its signal. Aborting wait stops polling only; it
does not cancel the underlying job.

```json
// package.json
{ "bin": { "myapp": "./dist/cli.js" } }
```

`stitchkit/cli` pulls in neither the MCP SDK nor `ai`, so a CLI binary needs no
MCP/agent peer dependencies.

## Pathless managed commands

Use `runtimeTools` when an application operation has no HTTP path but must keep
the canonical operation identity, context, lifecycle/RBAC, hooks and
introspection. It can share one definition with MCP and Agent while opting into
CLI explicitly:

```ts
import { createCli } from 'stitchkit/cli'
import { defineUploadTool } from 'stitchkit/tools'
import { z } from 'zod'

const uploadInput = defineUploadTool({
  name: 'upload_input',
  description: 'Upload one local input file',
  identity: { serviceName: 'jobs', action: 'uploadInput', scope: 'user' },
  output: z.object({ url: z.url() }),
  transports: ['MCP', 'AGENT', 'CLI'],
  upload: (path, context) => uploadFile(path, context.signal),
})

await createCli({
  name: 'myapp',
  version: '1.0.0',
  runtimeTools: [uploadInput],
})
```

`services` and `runtimeTools` may each be static arrays or factories receiving
the resolved identity. A runtime-only CLI is valid; `stitchkit/cli` still pulls
in neither MCP nor AI peers. Contract/runtime name collisions and reserved
option fields fail through the same checks before managed dispatch.

## Native binary commands

Login, self-update, diagnostics, integration setup and shell completion belong
to the executable, not to HTTP/MCP/Agent. Define them with `defineCliCommand`:

```ts
import { createCli, defineCliCommand } from 'stitchkit/cli'
import { z } from 'zod'

const login = defineCliCommand({
  name: 'login',
  description: 'Store credentials for later managed commands',
  input: z.object({ token: z.string() }),
  output: z.object({ configured: z.boolean() }),
  handler: async ({ input }) => {
    await saveToken(input.token)
    return { configured: true }
  },
})

await createCli({
  name: 'myapp',
  version: '1.0.0',
  commands: [login],
  resolveAuth: loadStoredIdentity,
  services: (identity) => createRemoteServices(identity),
})
```

Native commands receive only typed `input`, parsed global `options` and the
configured stdout/stderr writers. They reuse help, argv/stdin parsing,
validation, dry-run, error envelopes and exit mapping, but deliberately have no
fake service/action/scope/method identity, lifecycle or tool hooks and never
appear in MCP/Agent manifests.

A native command with a declared output may also own its final terminal
presentation and successful process status. Both callbacks receive the exact
Zod output type and run only after output validation; help, dry-run and failed
validation never invoke them:

```ts
const doctor = defineCliCommand({
  name: 'doctor',
  description: 'Inspect local health',
  input: z.object({}),
  output: z.object({ status: z.enum(['ok', 'degraded']) }),
  handler: () => ({ status: 'degraded' }),
  present: ({ result, options }) =>
    options.json ? `${JSON.stringify(result)}\n` : `STATUS ${result.status}\n`,
  exitCode: (result) => result.status === 'degraded' ? 1 : 0,
})
```

`present` returns the exact stdout bytes, which Stitchkit writes once. Without
it the canonical JSON output is unchanged. `exitCode` classifies a successfully
validated result and must return an integer in `0..255`; failed `ToolResult`
envelopes and the application-wide `exitCodes` mapping remain authoritative for
failures. A throwing callback, invalid status or non-string presenter becomes a
normalized `INTERNAL_SERVER_ERROR`, never partial success output. Void native
commands cannot declare either callback.

`--version`, a selected native command and its command help run before
`resolveAuth`, services, context or runtime-tool factories. Top-level help is
also credential-free when managed surfaces are static. A dynamic factory must
resolve identity to discover its command names; its collisions are checked at
that resolution boundary. If eager global collision proof matters, keep the
surface static.

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

Without presentation configuration, positional arguments fill non-boolean
fields in declaration order, so `myapp generate "a fox"` is
`--prompt "a fox"`. A piped value fills the first required unset field:
`echo "a fox" | myapp generate`.

For a stable shell grammar, declare the default command, short aliases and the
exact positional fields on `createCli`:

```ts
await createCli({
  name: 'myapp',
  version: '1.0.0',
  services,
  commands: [doctor],
  defaultCommand: 'logs',
  optionAliases: {
    logs: { f: 'follow', n: 'lines' },
  },
  positionals: {
    logs: ['target'],       // `lines` is option-only
    doctor: [],             // no argv positionals
  },
})
```

Now `myapp`, `myapp --json` and `myapp logs --json` select `logs`;
`myapp -f -n 100 --target api` maps to
`logs --follow --lines 100 --target api`. A leading non-option token remains an
explicit command so typos stay loud rather than becoming ambiguous default
positionals; use an explicit `myapp logs api` when passing positionals. Leading
framework globals may precede that explicit command. Top-level `--help`, `-h`
and `--version` never execute the default, and top-level help marks it.

Aliases are command-local, one ASCII letter and validated against the resolved
command schema. `-f` / `-f=false` are boolean forms; values accept `-n 100` and
`-n=100`. Arrays accumulate across short and long forms. `-h` is reserved,
bundles such as `-fn`, attached values such as `-n100`, `--no-f` and unknown
short flags are rejected. Canonical `--no-follow` remains available.

`positionals` replaces automatic schema-order selection only for the named
command. An empty array disables argv positionals. Fields remain available as
long/short options and stdin still fills the first required unset field with the
same schema-aware coercion. Unknown, duplicate or boolean targets and a required
positional after an optional/default positional fail when that command surface
resolves. Native dispatch retains its lazy credential-free boundary; dynamic
managed policies validate when their identity-dependent surface resolves.

The advertised schema is never mutated — a CLI call validates against the exact
same Zod schema an HTTP or MCP call does.

## Global flags

| Flag                  | Effect                                                     |
| --------------------- | ---------------------------------------------------------- |
| `--json`              | Compact success/error JSON records for scripts             |
| `--wait`              | Block-poll an async result to a terminal state             |
| `--wait-timeout <s>`  | Override the `--wait` timeout                              |
| `--output-dir <dir>`  | Download result media into a directory                     |
| `--quiet`             | Suppress non-essential stderr output                       |
| `--dry-run`           | Print the resolved call without executing                  |
| `--help`, `-h`        | Usage — top-level or per-command flag table                |

stdout carries the result; structured errors and progress go to stderr. With
`--json`, a success or structured failure is exactly one compact,
newline-terminated JSON record on its respective stream; progress and CLI usage
diagnostics remain ordinary stderr text. This keeps stdout pipeable and
`2>/dev/null` clean. The process exit code carries the error class (`0` ok,
`VALIDATION_ERROR → 1`, `UNAUTHORIZED → 2`, `FORBIDDEN → 3`, `NOT_FOUND → 4`,
…) — override per app with `exitCodes`.

Per-command help derives the positional form from the same resolved policy as
the argv parser. For example, a required `action` and optional `profile` render as
`Usage: myapp skill <action> [profile] [--flags]`; the argument table also shows
`<action> | --action` and `[profile] | --profile`. Boolean fields remain flags.
Declared aliases render beside their canonical options, for example
`-n, --lines`.

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
      done: (r) => isRecord(r) && ['COMPLETED', 'FAILED'].includes(String(r.status)),
      failed: (r) => isRecord(r) && r.status === 'FAILED',
    },
  },
})
```

`failed` is optional. When it matches either the initial result or a later poll,
polling stops and the CLI emits `WAIT_FAILED` on stderr with a non-zero exit;
the terminal payload is retained under `details.result`. `failed` is checked
before `done`, so overlapping predicates fail closed. A failed poll tool call
keeps its own error code, and an elapsed deadline remains `TIMEOUT`.

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
  resolveAuth: () => resolveIdentityFromToken(process.env.MYAPP_TOKEN),
  context: (identity) => ({ user: identity }),   // resolveFromContext reads this
  lifecycle: { beforeHandle: authHook },          // same policy; HTTP wires it as authorize
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

## Remaining boundary

File-upload (`multipart`) contract endpoints remain CLI-invisible, the same as
on MCP/Agent: their wire body is not a JSON tool form. Model file-oriented
application behavior as a managed pathless command, or binary-only behavior as
a native command. Streaming (SSE) output is not yet piped to stdout.
