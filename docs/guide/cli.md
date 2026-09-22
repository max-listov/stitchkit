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

### A trailing list

When the LAST declared positional is an array field, it takes every remaining
token, each coerced by the array's element type:

```ts
positionals: { handoff: ['to', 'files'] }   // files: z.array(z.string())
```

```
myapp handoff proj a.md b.md     → { to: 'proj', files: ['a.md', 'b.md'] }
myapp handoff proj a.md          → { to: 'proj', files: ['a.md'] }
```

One token is a one-element list, not a scalar, so the parsed shape never depends
on how many a caller happened to pass. Command help marks it:
`Usage: myapp handoff <to> <files...>`. The flag form still works
(`--files '["a.md","b.md"]'`, or a repeated `--files`) — but passing both forms
in one call is an argument error rather than a silent merge.

Only the trailing position is variadic. An array declared anywhere else in the
list keeps taking exactly one token (a JSON array), and its help stays `<tags>`,
so the usage line always says which field is the list.

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
| `--help <text>`       | List only the commands matching a substring                |
| `--count-by <field>`  | Count records per distinct value — see [Aggregate views](#aggregate-views) |
| `--sum <f> [--by <g>]`| Total a numeric field, optionally grouped                  |
| `--sort <field>`      | Order records by a field, largest first                    |
| `--ascending`         | Flip `--sort` to smallest first                            |
| `--top <n>`           | Keep the n leading entries of the view asked for           |
| `--table <a,b>`       | Render named fields as an aligned table                    |

stdout carries the result; structured errors and progress go to stderr. With
`--json`, a success or structured failure is exactly one compact,
newline-terminated JSON record on its respective stream; progress and CLI usage
diagnostics remain ordinary stderr text. This keeps stdout pipeable and
`2>/dev/null` clean. The process exit code carries the error class (`0` ok,
`VALIDATION_ERROR → 1`, `UNAUTHORIZED → 2`, `FORBIDDEN → 3`, `NOT_FOUND → 4`,
…) — override per app with `exitCodes`.

### A narrower question than "all of them"

On a discovered surface `--help` is the only way to learn what exists, and that
can be two hundred commands. At that size the list stops being an answer: it
scrolls past a person and costs an agent the same context an unfiltered result
would. So there is a question between "one command" and "all of them":

```bash
myapp --help broadcast     # also: -h broadcast · help broadcast · --help=broadcast
```

```
Commands matching "broadcast" (3 of 205):
  broadcast_send    Send a broadcast to every subscriber
  broadcast_cancel  Stop a running broadcast
  announce_publish  Publish an announcement as a broadcast
```

The description is searched as well as the name, because the word someone knows
is often in the sentence rather than the name — `announce_publish` above is
matched that way. The count says what was left out.

**No match is an exit code**, not an empty success: `0` over an empty list reads
as "there are none", which is a different statement from "none of these". It
exits with whatever `NOT_FOUND` maps to (`4` by default). Bare `--help` is
unchanged, and `--help=false` still means what it always did — the reserved
boolean's negation — so one value never carries two meanings.

## Application global options

`--json` and friends above are the framework's. An application usually has
globals of its own — which identity key to use, which checkout a call speaks
for, which profile — and they belong to no single operation:

```ts
await createCli({
  name: 'myapp',
  version: '1.0.0',
  globalOptions: z.object({
    caller: z.string().optional().describe('Identity key file'),
    root: z.string().optional().describe('Checkout the call speaks for'),
  }),
  resolveAuth: (globals) => loadIdentity(globals.caller),
  context: (auth, globals) => ({ auth, root: globals.root }),
  runtimeTools: (auth) => catalogFor(auth),
})
```

```
myapp --root /srv/app handoff_read --handoffId u
myapp handoff_read --root /srv/app --handoffId u   # the same call
```

These flags are lifted out of argv wherever they stand — before or after the
command name — validated against the declared schema, and kept out of every
operation's arguments: `handoff_read` above receives `{ handoffId: 'u' }` and
nothing else. The values reach `resolveAuth(globals)`, `context(auth, globals)`
and a native command's `globals`. An invalid value is an argument error naming
the flag; a name that collides with a framework option, or with a field of any
command, is refused at startup rather than shadowing it silently. Past a bare
`--` every token is a literal, so a positional value that reads like a global
survives intact.

Both help levels list them under `Application options:`.

## When the managed surface cannot resolve

A CLI whose commands come from a running server declares them with a factory,
and that factory needs an identity. When `resolveAuth` fails — the server is
down, the key file is missing — the commands it would have named are unknown to
the CLI, but the native ones are not:

```
$ myapp --help
myapp 1.0.0
...
Commands:
  serve  Run the server

Managed commands are unavailable: UNREACHABLE: socket closed
```

Help still lists what does not depend on identity and says, in one line, why the
rest is missing. Calling a name the CLI cannot resolve answers with that same
refusal and the exit code its error class declares through `exitCodes` — never
`Unknown command`, which would claim the name does not exist when the truth is
that it could not be looked up. A native command and its help still run: they
never needed an identity. Identity is still resolved at most once per
invocation, failure included.

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

## Aggregate views

The CLI's audience is agents, scripts and `jq`, so output is JSON. That settles
the *encoding*; it does not settle whether the answer to "how many items per
status" should be every item. Measured on a live server, one ordinary question:

| call | characters returned |
|---|---|
| the listing (98 records) | 34 750 |
| `--count-by status` | ~90 |

An agent pays for every one of those characters in its context window, and `|
jq` does not help: the bytes have been read into the conversation by the time
`jq` sees them. So the aggregate is computed on the result, before anything is
written.

```bash
myapp item_list --count-by status          # { "active": 33, "idle": 33, "stopped": 32 }
myapp item_list --count-by status --top 2  # the two largest groups
myapp item_list --sum messages             # 4753
myapp item_list --sum messages --by status # one total per status
myapp item_list --top 5 --by status        # same view, written the other way round
myapp item_list --table id,status          # the one human-facing shape
```

Two words, one each: **`--by` groups, `--sort` orders.** That leaves `--top` a
single meaning everywhere — *the n leading entries of the view you asked for* —
so the question a CLI actually gets asked composes out of the parts:

```bash
myapp item_list --top 5 --sort messages --table id,messages   # the five biggest, as a table
myapp item_list --sort messages --top 5 --json                # the same five, as records
myapp item_list --sort name --ascending                       # ordered the other way
```

Groups come back largest first for the same reason. A record that carries no
value for the sort field sorts **last in both directions**: it is not the
smallest, it is not on the scale at all, and letting it lead an ascending list
would answer a question nobody asked.

Three rules worth knowing before you rely on them:

- **A field the result does not carry is an argument error.** A group of zero
  over a misspelled field is indistinguishable from a true empty answer, and the
  caller reads it as data. The message names the fields that *are* there.
- **An aggregate needs a collection** — the result itself when it is an array,
  or the single array field of a result object. An aggregate over a scalar, or
  over an object with two array fields, is refused rather than guessed.
- **Without a view flag the output is byte-for-byte what it was.** The flags are
  reserved CLI behaviour like `--json`; they never reach a tool argument.
- **Ordering and grouping do not mix.** `--sort` with `--by`, `--count-by` or
  `--sum` is refused rather than given a second meaning.

A failed call still reports its own error and exit code. An aggregate over an
error is not an answer to the question that was asked.

## Named profiles

A CLI that talks to a deployed server needs an address and a credential per
environment, and the way a person picks one is a name: `--profile prod`.
`globalOptions` gives the flag a home and `resolveAuth(globals)` gives it a
resolution point. The rule that makes the mechanism safe is easy to write the
wrong way round, because the unsafe version reads as kindness:

> the named profile does not exist, but exactly one profile is configured — use it.

That is correct exactly while a single profile exists. The day a second appears
it is a command run against the wrong deployment, with nothing in the output to
say so. **A profile named explicitly and not found is a refusal, never a
substitution.** Substitution survives only where it cannot be wrong: no name was
given at all and exactly one profile exists — and even then it is announced on
stderr. The distinction has to be drawn at resolution; one step later, "prod" and
"prod by default" are the same string.

`createCliProfileStore` is that rule, plus the twenty lines every consumer of
this shape writes:

```ts
import { createCliProfileStore } from 'stitchkit/cli'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const profiles = createCliProfileStore({
  directory: join(homedir(), '.config/myapp/profiles'),
  schema: z.object({ url: z.url(), token: z.string().min(1) }),
  createHint: (name, path) => `write ${path} with {"url","token"} for "${name}"`,
})

await createCli({
  name: 'myapp',
  version,
  globalOptions: z.object({ profile: z.string().optional() }),
  resolveAuth: (globals) => profiles.resolve(globals.profile).value,
  services,
})
```

Files are written `0600` in a `0700` directory — and a profile file other users
can read is refused with the `chmod` that fixes it, because it holds a
credential.

## Distribution and self-update

`createCli` ships no executable, and that is right — but the step after the
executable is not application logic either. It is the same problem for every
consumer, with the same three traps:

1. **The installer cannot parse the manifest.** A `curl … | sh` runs on a
   machine where nothing is installed yet, including `jq`. So the installer is
   generated *from* the manifest, server-side, with the URL and digest already
   substituted — it parses no JSON at all.
2. **Replacing a running binary is a rename, not a write.** Anything else can
   leave a half-written executable on someone's PATH when the connection drops.
3. **The digest covers the decompressed bytes** — the file that will actually be
   executed, not the archive that was transferred.

The framework owns the manifest shape, the installer generation and the update
primitive. The application owns where the assets live, which platforms it
publishes and who may download them.

```ts
import {
  CliBuildManifestSchema, assertCliPublishable, renderCliInstaller,
  selectCliBuildAsset, checkCliUpdate, applyCliUpdate,
} from 'stitchkit/cli'

// Publishing: refuse to republish one version from a different commit —
// otherwise everyone who already installed it never receives the fix.
assertCliPublishable(previous, next)

// Serving: omit `asset` and one script covers every published target, selecting
// by uname at run time — otherwise that dispatch is the last hand-written piece
// of the install path, and every publisher writes the same x86_64 → x64 table.
renderCliInstaller({ manifest, binaryName: 'myapp' })
// Or pin one target explicitly:
renderCliInstaller({ manifest, asset: selectCliBuildAsset(manifest, target), binaryName: 'myapp' })

// Checking: bounded, at most once per interval, silent on any failure.
const check = await checkCliUpdate({ manifestUrl, currentVersion, lastCheckedAt })
if (check.status === 'outdated' && check.asset) {
  // Replacing is always an explicit command, never a side effect of a check.
  await applyCliUpdate({ asset: check.asset })
}
```

`checkCliUpdate` has **four** answers, not three: `skipped`, `current`,
`outdated` and `unknown`. "Could not ask" is not "up to date" — collapsing them
is how a tool goes quiet about its own staleness for months. It never throws,
and a command still exits with the code it earned.

Carry the build stamp inside the binary (`CliBuildStampSchema`,
`formatCliBuildStamp`) so the tool can say what it is rather than leaving the
reader to infer it from behaviour.

### Proving who built it — signing the manifest

The asset digest proves the bytes that arrived are the bytes the manifest named.
It proves nothing about who named them: the manifest and the assets come from
one origin, so whoever can replace one can replace the other. Authorship needs a
key the build carries and the server never holds.

```ts
// Publishing — the only side that holds a private key.
const signature = signCliManifest(manifest, { keyId: 'release-2026', privateKey })
publish({ ...manifest, signature })

// Installing — the trust root is compiled into the binary. One fetched at run
// time from the same origin as the manifest would prove nothing.
const trust = { keys: { 'release-2026': PUBLISHED_KEY } }
const check = await checkCliUpdate({ manifestUrl, currentVersion, trust })
if (check.status === 'outdated' && check.asset) {
  await applyCliUpdate({ asset: check.asset, manifest: check.manifest, trust, backupPath })
}
```

The signature covers `{name, version, commit, builtAt, assets[]}` with **every
asset's digest**, so the chain closes on the file that will execute rather than
on the document describing it; moving an asset to a new URL does not invalidate
it, changing what an asset contains does.

Five verdicts, and `unenforced` is the one that earns its keep: a build with no
pinned key keeps updating, and the fact that nothing was checked is *visible*
rather than assumed. `missing`, `unknown-key` and `invalid` are distinguished
because they need different answers — a key you forgot to pin is not a forged
signature.

A bad verdict does not produce a fifth status. `outdated` is an instruction to
install, and a manifest that failed its signature has not established that there
is a newer build worth installing — only that a document claims one. The check
answers `unknown` with the verdict in its reason, so it is never mistaken for a
network failure. `applyCliUpdate` checks again and refuses **before** the
download: a signature verified after the bytes are on the machine produces a
cleanup problem rather than a refusal.

### A way back — `backupPath` and `rollbackCliUpdate`

Rolling back is a property of updating, not of the application:

```ts
const applied = await applyCliUpdate({ asset, targetPath, backupPath })
// …the new build turns out to be wrong. `backupSha256` is absent when there was
// nothing to keep — a first install — and that is the case with nothing to roll
// back to:
if (applied.backupSha256) {
  rollbackCliUpdate({ targetPath, backupPath, expectedSha256: applied.backupSha256 })
}
```

The copy is taken between "the new bytes verified" and the replacement — earlier
would preserve a binary about to be replaced by a download that then failed its
digest, later has nothing left to copy — and it carries the target's file mode,
because a backup that cannot be executed is not a way back. A first install has
nothing to keep, which is not a failure.

`expectedSha256` is required, not optional. A rollback that installs whatever
happens to be at the backup path is a second install of an unverified binary,
and the day it is used is the day nobody is in a position to check.

### Two release tracks

`assertCliPublishable` takes one manifest **or every manifest already
published**:

```ts
assertCliPublishable([stableManifest, betaManifest], next)
```

With a single argument and two tracks the check is silently useless: `1.2.3`
goes to beta from one commit and to stable from another, the function is called
with the track being published and sees no conflict, and the person who
installed the beta is told they are current forever. Nothing on their machine
looks wrong.

**The channel itself is not an argument of the framework, and will not become
one.** The framework has no model of how your URLs are built and should not: an
asset's address comes from the manifest, and the manifest's address belongs to
your server. A channel is two documents at two addresses — which of them a build
consults is your decision, and `assertCliPublishable` is told about all of them
rather than taught the shape of any.

## One operation per line — `createCliInvoker`

The most common way an agent drives a CLI is not one command: it is a stream —
a JSON line per operation, an answer per line — and a resumable batch of the
same. The mechanics contain nothing product-specific, and until now the
framework left the one piece that cannot be written outside it: running an
already-parsed call.

```ts
import { createCliInvoker, defineCliStreamCommand, defineCliBatchCommand } from 'stitchkit/cli'

const invoker = await createCliInvoker({ name: 'myapp', services })

const outcome = await invoker.invoke('create_item', { title: 'hello', tags: ['a'] })
// { ok: true, exitCode: 0, data: { … } }   — nothing written, nothing exited
```

`invoke` runs the same pipeline a typed command runs — the same validation, the
same `lifecycle` gate, the same hooks — and returns the handler's validated
output with **the exit code the printed path would give**, from the same table.
`data` is typed `unknown`: the surface is resolved at run time from services and
runtime tools, so there is no compile-time name to key a result type on. Narrow
it with the contract's own output schema. That table used to
live inside the function that prints, so the only way to learn a code was to
print it.

Without this, a stream loop had to re-spawn the binary per line: arguments
serialised back into `--flag value` strings, nested objects pushed through
`JSON.stringify` into one argv slot and parsed again on the other side, the
result read back out of stdout text. Three conversions of data the framework was
already holding, plus a process start measured at 0.15 s — thirty seconds for a
two-hundred-line manifest before any work begins. The ban on nesting one stream
inside another was a consequence of that child process, not a rule anyone wanted.

### Mounting the loop

```ts
await createCli({
  name: 'myapp', version, services,
  commands: [
    defineCliStreamCommand({ name: 'jsonl', invoker }),
    defineCliBatchCommand({ name: 'batch', invoker, checkpointPath: '.myapp-batch.json' }),
  ],
})
```

They are factories, not framework-owned names. Reserving `jsonl` and `batch`
would take two names out of a namespace that belongs to the application — one
that already has a `batch` command would either fail at startup or find its own
command silently shadowed — so you mount them under whatever you call them, like
any other command of yours.

Each line is `{ id, command, args }`; each answer is the invocation result plus
that `id`. A line that is not JSON, or has no `id`, is **answered** and the
stream continues: a stream that goes quiet on one line leaves its consumer
unable to tell which request it lost. Answers go to stdout, one object per line,
and nothing else does.

### Resuming a batch

The checkpoint records, per id, a digest of the line that produced the recorded
answer, and is written after **every** line by atomic rename — a checkpoint that
only survives a clean finish protects against exactly the case that does not
happen.

A re-run replays what already ran. A line whose content changed under the same
id is **refused**: replaying it would report success for an operation nobody
ran, and re-running it would repeat a paid call. Both answer a question nobody
asked.

What stays yours: what makes a repeat safe (an idempotency key derived from the
line id), which operations a batch may contain, and how much of it runs at once.
That is product knowledge, and the framework has no business guessing it.

## Commands discovered from a running server

A CLI compiled from contracts carries the surface of the build it was compiled
from. One built from discovery carries the surface the server has *right now* —
which matters, because a long-lived MCP client freezes schemas at connect time
and then refuses the server's own newer fields:

```ts
const discovered = await mountConnections([
  defineMcpClientConnection({
    name: 'api',
    transport: { url },
    token: () => key,
    transports: ['CLI'],   // the opt-in: this server's tools are commands
  }),
])
await createCli({ name: 'myapp', version, runtimeTools: discovered, commands: [...] })
```

`transports` is where the opt-in belongs: a whole server becomes a set of
commands, and a connection without it still contributes nothing to the CLI —
exposure stays explicit, as it is everywhere else in the framework.

One unconvertible schema no longer takes the connection down with it. The tool
is skipped and **named** (`onSkippedTool`, or a stderr line by default), so a
surface of two hundred tools is not lost to one.

**A remote refusal keeps its code.** A failed `tools/call` used to become a
one-sentence `Error` with the result discarded, which cost three things at once:
the code (so `exitCodes` had nothing to map and every remote failure exited `1`),
the message the operator needed, and the error's own class — a plain `Error` is
an *unexpected* error to the runner, so it printed a code frame of the framework
bundle before the JSON failure and was then scrubbed to `INTERNAL_SERVER_ERROR`.
A structured `{ error, details }` body is now relayed as the contract error it
is, on every transport; anything else fails as `UPSTREAM_TOOL_ERROR` carrying
what the server did send. Not `INTERNAL_SERVER_ERROR`, because nothing of ours
broke.

**On the CLI a discovered command prints the answer, not the envelope.**
`tools/call` returns `{ content: [...], structuredContent? }`, and an agent mount
needs exactly that — the parts are what a model is shown. The CLI is different in
kind, because the handler's value is what gets printed, piped and aggregated:
handed the envelope, `--count-by status` groups the *content parts* and answers
`no record carries the field "status" — available: text, type`. So the CLI
transport unwraps, and only it: `structuredContent` when the server sent one, a
lone text part when it parses as JSON, its text when it does not. Several parts,
an image or audio pass through whole — picking one of many would be inventing an
answer.


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
