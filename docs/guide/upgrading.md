# Upgrading stitchkit

How to move a consuming project from one stitchkit version to another — including
across many versions at once (a project frozen on an old version, then jumped
forward). The process is mechanical: stitchkit marks every breaking change in one
place and one format, so you can recover the full migration from the version diff.

## The one rule that makes this work

A release that breaks a public API leads its `CHANGELOG.md` entry with a
**`### ⚠️ Breaking changes`** section (exact heading), each item carrying a
**before → after** snippet. A version with **no** such section is **purely
additive** — adopting it changes nothing in your code. (See
[`AGENTS.md` → Breaking changes](../../AGENTS.md).)

So upgrading is: read the `### ⚠️ Breaking changes` of every version *above* your
current one *up to* your target, and apply each snippet.

## What your range does, and does not, do for you

A caret range (`"stitchkit": "^0.71.0"`) is a real gate: it resolves `< 0.72.0`,
so a plain `install` picks up every patch — fixes, new API, no code changes —
and **never** crosses a minor. Crossing one is always something you chose.

**An exact pin (`"stitchkit": "0.71.0"`) is a different arrangement, and it is
easy to mistake for a safer version of the same one.** It does not opt you out
of breaking changes; it opts you out of *every* change, patches included. No
install will move you, nothing will warn you, and the gap grows quietly — a
project pinned exactly for a few months is typically several minors behind and
has had no signal at all that this is so. That is a legitimate choice, but it
makes one thing your job rather than the resolver's:

- **Check deliberately.** `npm view stitchkit version` against your pin, on
  whatever cadence suits the project. Nothing else will raise it.
- **Then upgrade across the whole gap at once**, exactly as below: apply the
  `### ⚠️ Breaking changes` of every version above your pin up to your target,
  in order. A pin held across four minors is four migrations, not one, and
  three of them may be a single snippet each.

The mechanical part is identical either way. Only the *noticing* differs, and an
exact pin moves it onto you.

## Released migration: 0.80.0

One thing, and only if you parse an async-operation snapshot.

```bash
rg -n "createAsyncOperationSnapshotSchema"
```

`progress` on a parsed snapshot used to be `unknown`. The factory built its
object shapes with a conditional spread, and the narrowing inside it widened
your schema back to a bare `ZodType`, so the emitted declaration threw the type
argument away. It is now the output of the schema you configured.

```ts
const schema = createAsyncOperationSnapshotSchema({
  progress: z.object({ done: z.number(), total: z.number() }),
  failure: z.object({ code: z.string() }),
})
const snap = schema.parse(body)
if (snap.phase === 'running') {
  // before: `snap.progress` was `unknown` — this needed a cast or a narrow
  // after:  it is `{ done: number; total: number } | undefined`
  console.log(snap.progress?.done)
}
```

**If you cast it**, delete the cast — it was working around the erased type.
**If you assigned something else to it**, the compiler now refuses, and it was
already a value the schema rejected at run time.

**If you pass explicit type arguments**, the no-progress form takes one now, not
two: the factory is two overloads. Pass none.

```ts
// before: createAsyncOperationSnapshotSchema<undefined, typeof Failure>({ failure: Failure })
// after:  createAsyncOperationSnapshotSchema({ failure: Failure })
```

Nothing about parsing moves. A snapshot configured without `progress` still
strips an unexpected `progress` rather than refusing it — that behaviour is why
this is overloads and not one normalised key.

**If you compile with `skipLibCheck: false`**, this is also the release that
makes `stitchkit/tools/contract` compile at all: it carried five `TS2344`
errors, one per phase, from the same conditional spread.

## Released migration: 0.79.0

One thing, and only if you assert on the whole snapshot.

```bash
rg -n "getSnapshot\(\)|projectApplicationStatus|status\(\)" --glob '*.test.ts' --glob '*.spec.ts'
```

`ApplicationSnapshot` and `ApplicationStatusProjection` each gained a
`restarting` field — ids in the snapshot, a count in the projection. A reader
that names the fields it wants is unaffected. A test that compares the whole
object with `toEqual` fails until it adds the field:

```ts
// before
expect(body).toEqual({ id, lifecycle: 'ready', /* … */ resources: { total: 1, ready: 1, degraded: 0, failed: 0 } })
// after
expect(body).toEqual({ id, lifecycle: 'ready', /* … */ resources: { total: 1, ready: 1, degraded: 0, failed: 0 }, restarting: 0 })
```

It is zero except while a restart is running, and then it names the subtree being
replaced. That is the point: a snapshot taken mid-restart used to be
indistinguishable from a resource that had failed on its own, so a dashboard read
a planned replacement as an outage.

**If you watch a hub across a restart**, nothing to change, but the behaviour is
different and better: closing a hub now tells its subscribers `unavailable` /
`source-unavailable` instead of dropping them, so a page stops showing a value
that will never update again.

**If you need a tool contract in a browser**, `stitchkit/tools/contract` now
carries the async-operation helpers, its schemas and the view-file input/output
without the runtime. `stitchkit/tools` still exports all of them.

## Released migration: 0.78.0

Two mechanical edits. Find them both:

```bash
rg -n "createDecisionPipeline|createDiagnosticJournal" --glob '*.ts' --glob '*.tsx'
```

**1. `createDecisionPipeline` takes a deadline.**

```ts
// before
createDecisionPipeline([policyA, policyB])
// after
createDecisionPipeline([policyA, policyB], { policyTimeoutMs: 2_000 })
```

Pick a number your slowest policy comfortably beats. There is no default on
purpose: a policy that never settles hangs every caller of the operation it
guards, and the framework has no basis for choosing that number for you.

Past the deadline — and on a throw, and on a non-decision — the pipeline raises
`DecisionPolicyError` naming the policy, with the trace so far. If you already
catch that for a bad return value, you now catch two more cases with it.

**2. `createDiagnosticJournal` moved.**

```ts
// before
import { createDiagnosticJournal } from 'stitchkit/application'
// after
import { createDiagnosticJournal } from 'stitchkit/application/diagnostic-journal'
```

Only the factory moved. `DiagnosticJournalConfig`, every
`DiagnosticJournal*Schema` and `readDiagnosticJournalLockDiagnosis` stay where
they were.

**If you restart resources**, nothing to change — but three things that did not
work now do: a managed schedule can be restarted, a restarted keyspace accepts
writes again, and a restarted managed server is actually shut down at exit. If
you pass `managedServerResource` a server *instance*, a restart is now refused
by name; pass a factory (`server: (context) => …`) to restart it.

## Released migration: 0.77.0

Two type renames, and only if you named them. Nothing runtime moved.

```bash
rg -n "EventDecision|EventUndecided" --glob '*.ts' --glob '*.tsx'
```

```ts
// before
import type { EventDecision, EventUndecided } from 'stitchkit/live'
// after
import type { PolicyDecision, UndecidedOutcome } from 'stitchkit/live'
```

The shapes are identical — `{ outcome: 'allow' } | { outcome: 'deny', reason } | { outcome: 'defer' }`
and `'allow' | 'deny'`. If you only ever *return* decisions from listeners and never named the
type, the search above finds nothing and there is nothing to do.

They were renamed because `createDecisionPipeline` (new in this release) votes with exactly the
same three outcomes, and two identical types under two names is the thing that makes a search for
either one return half the truth.

## Released migration: 0.76.0

One change, and only if you hand `createWatchClient` a transport you wrote yourself.

```bash
rg -n "createWatchClient" --glob '*.ts'
```

If the `transport:` you pass is a bound realtime client — `bindRealtimeClient(...)` or
`createRealtimeClient(...)` — there is nothing to do: it already carries
`onConnectionChange`. If it is an object you assembled, add the fourth member:

```ts
onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void
```

It is required because the client recovers through it: on a drop it publishes
`unavailable` to subscribers and forgets what was opened, and on a fresh
connection it re-opens every key that still has a listener. Without it a watch
stays "open" on the client after a server restart while the hub remembers
nothing, and the face stops updating without saying so.

## Released migration: 0.75.0

Two mechanical renames and one option that has to move. Nothing about a passing
request changes.

### 1. A route group's `onRequest`

```bash
rg -n "hooks:\s*\{[^}]*onRequest" --glob '*.ts'
```

Any match **inside a `groups: [...]` entry** must move. The hook was accepted and
never dispatched, so the behaviour you have today is "no hook"; the fix is to
decide which one you meant:

```ts
// refuse before dispatch, for the whole server
createServer({ groups, hooks: { onRequest: gate } });

// gate this group once the endpoint is known
groups: [{ pathPrefix: '/admin', services, hooks: { authorize: gate } }]
```

A group that still declares `onRequest` fails at startup with that message.

### 2. The SQLite boundary type

```bash
rg -l "AgentRuntimeSqlite(Database|Statement|Value)" | xargs sed -i \
  -e 's/AgentRuntimeSqliteDatabase/SqliteDatabase/g' \
  -e 's/AgentRuntimeSqliteStatement/SqliteStatement/g' \
  -e 's/AgentRuntimeSqliteValue/SqliteValue/g'
```

Type-only: the same three methods, the same structural compatibility with
`bun:sqlite` and a `node:sqlite` wrapper, imported from the same entrypoints.
`initializeAgentRuntimeSqlite` keeps its name — it really is the agent runtime's
schema.

### 3. Nothing else

`stitchkit/live`, the watch hub, the keyspace and the trust fence are all
additive. Adopt them when you want them; the guide is
[Live data](./live.md).

## Released migration: 0.74.0

One change, and it only reaches you if you catch a refusal the **client** raised — one it made while
planning the request, before anything was sent. A server refusal is unchanged.

### If you match on the text of a client-side refusal

A missing path param, a missing scoped prefix key, a non-flat field in a `GET` input, a missing or
invalid multipart file: each used to arrive as a plain `Error` carrying only a sentence. They now
arrive as an `ApiError` in the same shape a server validation failure uses.

```ts
// before
catch (e) {
  if (/Missing path param/.test(e.message)) …
}

// after
catch (e) {
  if (e.code === 'VALIDATION_ERROR' && e.status === 0) …   // refused here, nothing was sent
}
// e.details.issues[0].path === 'id'
```

`status` is what separates the two worlds, and it is not new — `0` has always meant *this never
reached the server*, as `REQUEST_ABORTED` and `REQUEST_TIMEOUT` already used it:

| | `code` | `status` |
|---|---|---|
| the client refused your arguments | `VALIDATION_ERROR` | `0` |
| the server refused your arguments | `VALIDATION_ERROR` | `400` |

`details.issues` is the same `{ path, code, message }` array on both, so one rendering serves both —
and `zodIssues` / `ZodIssueSummary` are now importable from `stitchkit` itself, not only from
`stitchkit/server`.

### If you are on `createHttpClient` and your call site relied on a synchronous throw

This is the sharp one, because it is invisible in a diff. Those refusals used to be thrown
**synchronously** on the Ky-backed client — before the call returned a promise — so
`api.upload({}).catch(handler)` never reached the handler, while the same mistake on the bare-fetch
client rejected normally. They now reject on both.

```ts
// before, on createHttpClient only
try {
  api.upload({})            // threw here
} catch (e) { … }

// after, on both transports
await api.upload({}).catch(handler)
```

A `try/catch` around an `await`ed call keeps working. A `try/catch` around an un-awaited call no
longer catches anything — which was already true on the other transport.

Not a migration, but worth knowing: a missing multipart file used to be reported as
`UNKNOWN_ERROR`, the code that means *this client cannot tell you what happened*, on the one refusal
where it is certain nothing was sent. → ADR 0148 carries the reasoning, including why argument
validation stays on the server.

## Released migration: 0.73.0

Two breaking changes. Nothing you send to a server changed, and only one of these
can reach a call site the compiler already checks.

### If you call `withOptions` from a call site that lost its types

`withOptions` takes one argument on an endpoint with no contract input, two when
there is one. Passing two to a no-input endpoint used to succeed and silently
drop the options: the request went out **uncancelled**, the caller still received
`REQUEST_ABORTED` — cancellation is decided from the signal it was handed, not
from what the transport did — and the server ran the operation to its own
deadline. Every symptom then points at the transport, and the investigation goes
there. It now throws a `TypeError` naming the endpoint and the correct shape.

```ts
// before — the options were dropped and the request was never cancelled
api.ping.withOptions({}, { signal })

// after
api.ping.withOptions({ signal })
```

A typed call site already refused the wrong arity, so this reaches only code that
does not have the types: a `Record<string, …>` view of the client, a hand-written
double, a dynamic dispatch. The guard counts arguments and never reads them, so a
method handed to a callback API behaves exactly as before.

### If you match on `ApiError.message`

An `ApiError` that nothing explained used to carry `API Error: ${code}` — a
string that reads like an explanation while only restating the code, so a caller
could not tell an origin that explained a failure from one that said nothing. It
now says which it is.

```ts
// before
err.message === 'API Error: INVALID_INPUT'

// after
err.message === 'INVALID_INPUT (no message supplied)'   // better: match err.code
```

Match `err.code` instead: it is the contract, and it did not change. An error
carrying a real message is untouched. An empty message now counts as no message,
for the same reason — an empty string is not an explanation either.

### If a diagnostic journal lock file is already on disk

One operator step, and only on a host that has been **renamed** since its lock was written.

A lock written before this version carries no machine identity, so there is nothing to compare and
the host name is all that is left. If the name still matches, the lock reclaims exactly as it always
did and there is nothing to do. If the name has changed, the lock is `unattributable` and is refused
— the same refusal this release exists to end, except that this particular file predates the fix and
cannot be repaired from the inside. Delete it once:

```sh
rm <journal path>.lock   # only when the host was renamed since the file was written
```

Locks written from this version on carry the machine identity, so the situation cannot recur. To see
which case you are in without guessing, read the refusal instead of the file:
`readDiagnosticJournalLockDiagnosis(err)` returns `attribution: 'unattributable'` for exactly this
one, and `'another-machine'` for a lock that genuinely belongs elsewhere and must **not** be deleted.

Two related fixes need no migration, but change what you will see. An error the
transport raised through `createHttpClient` now carries the transport's own text
in `message` and the original error as `cause`, where before it carried neither
and filed the text under `details.message` alone; if you followed the retry rule
in [the client guide](./client.md) — inspect the adapter's `cause`, retry only
when it proves dispatch did not happen — that rule was not executable on this
transport and now is. And the client guide now states which direction validation
runs: responses are checked against `output`, arguments are **not** checked
before being sent.

## Released migration: 0.72.0

Nothing you *pass* changed. Both items are about types you read or build, and
both stop the compiler rather than surprising you at runtime.

### If you read `perKey` off `BoundedAdmissionPolicy`

`perKey` is now a union: the flat ceiling it always was, or `{ maxKeys, limits }`
where the ceiling is resolved from the key. Declaring one is unchanged; reading
one needs a narrowing.

```ts
// before
const ceiling = policy.perKey?.maxConcurrent

// after
const ceiling =
  policy.perKey && !('limits' in policy.perKey) ? policy.perKey.maxConcurrent : undefined
```

A shape carrying members of both branches — `{ maxKeys, maxConcurrent, limits }` —
is refused. **In 0.72.0 and 0.72.1 that refusal came only from
`createBoundedAdmission`**, not from `tsc`: an excess-property check against a
union admits any property some member declares, so the mixed shape typechecked
and threw when the admission was built. From **0.72.2** each branch declares the
other's members as `never`, so it is a compile error. Nothing about the runtime
changed — both branches always refused it — but on a path your tests do not
construct, the earlier versions would have told you in production.

### If you build a snapshot or a status by hand

`CreditWindowSnapshot` gained `waiting` (producers parked in the new waiting
`acquire`) and `DiagnosticJournalStatus` gained `lock`. Both are produced by the
framework, so reading them is unaffected — but a test double stops compiling:

```ts
// before
const snapshot: CreditWindowSnapshot = { state: 'open', capacityBytes: 100, /* … */ }

// after
const snapshot: CreditWindowSnapshot = { state: 'open', capacityBytes: 100, /* … */ waiting: 0 }
```

## Released migration: 0.71.0

The Agent coding tools. Two of the three changes are visible to the compiler;
the third is the one to read carefully, because nothing will point at it.

### If you implement `authorize`

The operation union gained `edit`, `list` and `glob` and lost `patch`. An
exhaustive matcher stops compiling and the compiler shows you every arm. **A
matcher with a default branch does not**, and that is the dangerous case:

```ts
// before — and after this upgrade, silently wrong in both directions
if (request.operation === 'patch') return reviewPatch(request)
return true            // now also authorizes edit, list and glob
// …or: return false   // now also kills edit_file
```

```ts
// after
switch (request.operation) {
  case 'edit':   return reviewEdit(request)   // the old `patch` payload, unchanged
  case 'list':
  case 'glob':   return true                  // or your own policy
  // …existing read / write / search / shell / artifact-read arms
}
```

`write` gained `createsDirectories` — the workspace-relative directories the
call would create, outermost first, reported **before** anything is created. A
host that wants to refuse implicit directory creation now can.

### If you call `apply_patch`

It is `edit_file`, and it is one call:

```ts
// before
const read = await readFile({ path })
await applyPatch({ path, baseSha256: read.sha256, oldText, newText, dryRun: true })
await applyPatch({ path, baseSha256: read.sha256, oldText, newText, dryRun: false })

// after
await editFile({ path, oldText, newText })
```

`expectedSha256` is optional and still refuses a stale base with `CONFLICT` when
you pass it; `edit_file` returns the resulting `sha256`, so a chain of edits
never needs to re-read. If you key an approval policy or a UI label on the string
`apply_patch`, update the key — nothing will fail loudly.

### If you match on `INTERNAL_SERVER_ERROR` from a coding tool

Ordinary outcomes no longer arrive that way. A missing file is `NOT_FOUND`, an
existing file without `overwrite` is `CONFLICT`, an ambiguous snippet is
`CONFLICT` with the occurrence count, a path outside the root is `FORBIDDEN`.
Code that treated any coding-tool failure as an internal fault will now see
codes it did not before; code that showed the model an empty error now has a
sentence and a `hint` to show it. Host-level causes are unchanged and still
scrubbed.

### If you write files into new directories

Nothing to change: `write_file` creates missing parents inside the root. Read
`createdDirectories` in the result if you want to notice a typo — a path that
was a failure before is now a successful write into a new tree.

### If you want a step to know its context budget

Opt in by reading it; nothing is injected for you:

```ts
loop: {
  prepareStep: ({ contextUsage }) => {
    const used = contextUsage?.usedTokens
    if (used?.provenance === 'unavailable') return {}      // no step has landed yet
    const fraction = (used?.value ?? 0) / (contextUsage?.contextWindow ?? 1)
    // …render it wherever you put it
    return {}
  },
}
```

Put it at the **tail** of the conversation rather than in the system
instructions unless you have a reason: changing the system prompt on every step
invalidates the provider's prefix cache for the whole conversation, and on a long
run that is a multiple of the input cost.

## Released migration: 0.70.0

### Descriptor-backed Agent filesystem containment

Built-in coding file/search tools and `createAgentHarnessFileResources` now require a runtime
that can address an opened directory descriptor: Linux `/proc/self/fd`, or the packaged macOS
Node-API backend added in 0.70.1. This is what keeps a mutable parent rename or outside-symlink replacement from changing
the authorized target between validation and the actual effect.

No call-site change is needed on those platforms. The 0.70.0 notes incorrectly inferred macOS and
FreeBSD support from `/dev/fd`; macOS is restored by 0.70.1 and FreeBSD remains unsupported. On
Windows or another platform without that
boundary, move the built-in filesystem operations to a supported worker or replace them with
application-owned tools backed by an equivalent native handle API. They fail closed rather than
falling back to path spelling. `run_command` remains separately available under its explicit
executable alias and authorization policy; this change does not claim an executable sandbox.

## Released migration: 0.69.0

### Direct coding-tool operation names

`createAgentCodingTools` no longer prefixes durable operation identity with `coding_`, and the
unguarded exact-string edit tool is gone. Update approval maps, presenters and tests together:

```ts
// before
{ coding_read_file: 'approved', coding_search: 'approved', coding_patch_file: 'user-approval' }

// after
{ read_file: 'approved', search_files: 'approved', apply_patch: 'user-approval' }
```

The full mapping is `coding_read_file → read_file`, `coding_write_file → write_file`,
`coding_search → search_files`, `coding_patch_file → apply_patch`, `coding_shell → run_command`,
`coding_read_artifact → read_output` and `harness_read_resource → read_resource`. Replace
`coding_edit_file` with `read_file` followed by guarded `apply_patch`; `read_file` now returns the
required SHA-256. If the host declares no executable aliases, expect `run_command` to be absent.

### Durable Agent approval message variants

If a renderer, store adapter or export pipeline exhaustively switches over
`AgentMessage.role`, add the `tool` branch. If it switches over
`AgentMessagePart.type`, add `tool-approval-request` and `tool-approval-response`.
They are durable provider-continuation evidence: preserve them in storage and provider history;
a UI may render them as approval state or intentionally omit their visual row.

```ts
// before
const unreachable: never = message.role

// after
if (message.role === 'tool') renderToolContinuation(message.parts)
else renderExistingRole(message)
```

No data migration is needed. The schema still accepts all earlier records, and applications that
do not exhaustively branch over these unions compile unchanged.

## Before you bump, if you implement an agent store

One step, and it is mechanical. If your project has an `AgentRuntimeStore` — a
Prisma adapter, an in-memory one, anything — run the conformance kit against it
**on the version you are leaving**, then again after the bump:

```ts
import { runAgentStoreConformance } from 'stitchkit/testing'

await runAgentStoreConformance({ createStore: () => yourStore })
```

The kit picks the conversation identities itself and hands them over **before**
the first mutation, so a store whose runtime rows hang off an application-owned
conversation row can provision the parents — and take them away again:

```ts
await runAgentStoreConformance({
  createStore: (context) => {
    for (const conversationId of context.conversationIds) createConversationRow(conversationId)
    return yourStore
  },
  cleanup: (context) => {
    for (const conversationId of context.conversationIds) deleteConversationRow(conversationId)
  },
})
```

`cleanup` runs exactly once, after the scenario, whether it passed or failed —
and a failure in it never replaces the scenario's own.

Green before and red after tells you the contract grew and where, in one run,
instead of one failure at a time in production. Green both times means the
upgrade owes you nothing on that surface — which is the usual answer if you
implement `AgentRuntimeStoreDriver` and compose the aggregate with
`createAgentRuntimeStore(driver)`, the supported shape (→ ADR 0111).

## Flow (agent or human)

1. **Find the current version.** In the consumer: the resolved `stitchkit` in
   `bun.lock` (authoritative), or `node_modules/stitchkit/package.json`. The range
   in `package.json` (`^0.6.0`) is intent, not the installed truth.
   > A `file:` link (`"stitchkit": "file:…"`) means the consumer tracks a **local
   > checkout**, not a published version — its effective version is whatever that
   > checkout's `package.json` says, and a plain `install` will not relink it after
   > the local version moves (`bun install --force` does). Prefer a real
   > `^x.y.z` range for reproducibility.

2. **Pick the target.** Latest published (`bun pm view stitchkit version`) or a
   specific `x.y.z`.

3. **Read the breaking sections in range.** In stitchkit's
   [`CHANGELOG.md`](../../CHANGELOG.md), for every version `> current` and
   `<= target`, read its `### ⚠️ Breaking changes`. Versions without that section
   are additive — skip them. (Fast scan: `grep -n "Breaking changes" CHANGELOG.md`.)

4. **Apply each migration** — the before → after snippet tells you exactly what to
   change at each call site. There are no deprecation shims to lean on; the old
   shape is gone, so every site must move.

   Then read this file's **`## Released migration: X.Y.Z`** section for each of
   those versions. That is the half the changelog does not carry: what else
   stops working because of the change, and what changes *silently* rather than
   at compile time — projected history returning fewer messages, a dashboard
   field going blank. `bun run check` in step 6 cannot see either.

5. **Bump and install.** `bun add stitchkit@<target>` (or update the range), then
   `bun install`. Note the caret: `^0.7.0` is `< 0.8.0`, so crossing a breaking
   minor is always an explicit version bump, never automatic.

6. **Verify.** `bun run check` (or per-package typecheck) — TypeScript catches the
   removed/renamed/retyped surfaces. Then a **runtime smoke** (typecheck ≠
   runtime): bootstrap the server, one HTTP request, and any feature you rely on
   (Socket.IO connect, an MCP tool call, a multipart upload, …).

## Released migration: 0.68.0

### Make Unix transport selection explicit outside Bun

The legacy `unix` option remains a Bun convenience, but on Node or another
runtime it now fails before dispatch. Replace it with the owned adapter and close
that adapter with the application:

```ts
// before — unsafe outside Bun: an unsupported fetch could dial baseUrl over TCP
const http = createHttpClient({ baseUrl, unix: '/run/service.sock' })

// after — Bun and Node; every dispatch and redirect stays on the socket
import { createUnixClientTransport } from 'stitchkit/server' // or stitchkit/node
const transport = createUnixClientTransport({ socketPath: '/run/service.sock' })
const http = createHttpClient({ baseUrl, fetch: transport.fetch })
// during shutdown
await transport.close()
```

Do not automatically replay `possibly-dispatched`: a timeout or connection loss
after bytes left the process does not prove that a write did not happen.

### Choose tolerant stream parsing explicitly

`parseNDJSON` and `parseSSE` now throw on malformed JSON, invalid UTF-8 and an
over-limit line. The default line ceiling is 1 MiB. If a feed deliberately skips
bad records, retain that policy explicitly:

```ts
// before — malformed input disappeared implicitly
parseNDJSON(response)

// after — ordinary fail-closed path
parseNDJSON(response, { maxLineBytes: 256 * 1024 })

// after — deliberately tolerant path
parseNDJSON(response, { onParseError: (raw, error) => report(raw, error) })
```

### Extend exhaustive framework-error handling

If a switch makes `StitchErrorCode` exhaustive, add
`STREAM_ITEM_INVALID`, `STREAM_FRAME_TOO_LARGE`,
`STREAM_TERMINAL_MISSING` and `STREAM_LIFETIME_EXCEEDED`. A partial application
status map needs no change (ADR 0105).

The admission/channel APIs and endpoint `stream` descriptor are additive; raw
responses and raw `streamingRoute` remain supported.

## Released migration: 0.67.0

Three application-kernel changes. Two of them fix silent failures, so the most
important part of this migration is not what the compiler points at — it is the
two things that change with no compile error at all: **when your server is
created**, and **which shutdown budget a signal spends**.

### If you gave `managedServerResource` a thunk

It is now called during `start`, after the resource's dependencies are ready —
the reading the type always suggested. Before, it was called on the way *down*,
so `app.start()` resolved, the snapshot said `healthy` and `ready`, and nothing
was bound to the port.

If your application looked like this, it was never listening:

```ts
// before — resolves clean, listens on nothing
managedServerResource({ id: 'http', dependsOn: ['database'], server: () => createServer(config) })
```

Nothing to change: the same code now binds the port. Check your startup logs for
a healthy report you never actually verified with a request.

If you used the spread workaround — this resource's phases over your own
`start` — it keeps working, and you can now delete it:

```ts
// before
let handle: ManagedServerHandle<T> | null = null
const shutdown = managedServerResource({ id: 'http', server: () => handle! })
const http = defineManagedResource({
  ...shutdown,
  dependsOn: ['database', 'socket-io'],
  start: () => { handle = createServer(config) },
})

// after
const http = managedServerResource({
  id: 'http',
  dependsOn: [database, socketIo],
  server: () => createServer(config),
})
```

An already-created handle is adopted exactly as before.

### If you passed `shutdown` to `bindProcessSignals`

`bindProcessSignals` used to fill in the schema's defaults for every budget you
omitted, which made `createApplication({ shutdown })` unreachable on the signal
path — the one path production stops through. An application declaring five
seconds took thirty-five.

Declare the budget once, on the application, and delete the repetition:

```ts
// before — the same two numbers in two places, and only one of them applied
const app = createApplication({ id: 'svc', resources, shutdown: SHUTDOWN_BUDGET })
bindProcessSignals(app, { shutdown: SHUTDOWN_BUDGET })

// after
const app = createApplication({ id: 'svc', resources, shutdown: SHUTDOWN_BUDGET })
bindProcessSignals(app)
```

**Check this even if you change nothing.** If you declared a budget on the
application and did not repeat it on the binding, your process has been stopping
on 30 s / 5 s and will now stop on what you declared. Compare it against the
supervisor timeout that watches it — `kill_timeout`, `TimeoutStopSec` — because
that number was probably calculated from the declaration.

Passing `shutdown` to the binding still works and still wins, key by key: one
key overrides that key alone and leaves the other at the declaration.

### If you read `resource.dependsOn`

Its type widened from `readonly string[]` to `readonly ManagedResourceDependency[]`
— `string | ManagedResource` — so a dependency can be declared as the resource
itself. Declaring stays compatible; reading needs one call:

```ts
// before
const ids: readonly string[] = resource.dependsOn ?? []

// after
import { managedResourceDependencyId } from 'stitchkit/application'
const ids = (resource.dependsOn ?? []).map(managedResourceDependencyId)
```

### If you thread a handle through a module-local

This is the pattern the change exists to remove, and it is opt-in — nothing
breaks if you keep yours:

```ts
// before
let socket: SocketHandle | null = null
const socketIo = defineManagedResource({
  id: 'socket-io',
  start: async () => { socket = await createSocketServer(config) },
})
const http = defineManagedResource({
  id: 'http',
  dependsOn: ['socket-io'],
  start: () => {
    if (!socket) throw new Error('socket is not initialized')   // unreachable
    server = createServer({ socket })
  },
})

// after
const socketIo = defineManagedResource({
  id: 'socket-io',
  start: async () => ({ value: await createSocketServer(config) }),
})
const http = defineManagedResource({
  id: 'http',
  dependsOn: [socketIo],
  start: (context) => {
    server = createServer({ socket: context.use(socketIo) })   // SocketHandle
  },
})
```

Declare the dependency with the **resource** when you intend to read from it —
that is the form `use` can type. `use` refuses a resource missing from
`dependsOn`, and refuses one that published no value; the second refusal is a
compile error too.

## Released migration: 0.66.0

Three changes, and only one of them is a feature. The other two are shapes that
would have had to break later: a vocabulary that described one fact with two
words, and a store whose only read was the whole conversation.

The compiler points at most of it. Two things change with no compile error —
what a **total** says about its own provenance, and the fact that token counts
are now validated where they were not.

### An input that joins a run in flight

#### If you matched exhaustively on `AgentTerminalReason`

`'absorbed'` is new. A run ends this way when a run already in flight took its
input on and answered it; its state is `'superseded'`, and `absorbedIntoRunId`
names the run that has the answer.

```ts
// after
switch (run.terminalReason) {
  // …
  case 'absorbed':
    // no assistant message of its own — follow run.absorbedIntoRunId
    break
}
```

A run record with `terminalReason: 'absorbed'` and no `absorbedIntoRunId` is
refused at parse time, and so is `absorbedIntoRunId` on any other reason.

#### If you render or export runs

An absorbed run has **no assistant message**. Anything that assumes "every
terminal run has one" needs the `absorbed` case — the answer is on the run
`absorbedIntoRunId` names, and `store.loadRun` resolves it.

#### If you want the policy

```ts
// after
runs: { inputPolicy: 'inject' }
```

It was withdrawn in 0.65.0 and is back with the ordering corrected: the
absorption commits with the terminal record, not at the step boundary. Read
*An input that joins a run in flight* in the agent-runtime guide before turning
it on — in particular what happens when the absorbing run does not complete, and
how it composes with `coalescePending`.

#### If you implement a store driver

Nothing to do, but know what changed underneath: one terminal commit can now
save **two** run records, and they must land in the same transaction. A driver
that persists one of the pair fails `runAgentStoreConformance`.

### A run read without its conversation

#### If you implement `AgentRuntimeStore` by hand

Two members to add. **If your adapter is an `AgentRuntimeStoreDriver` passed to
`createAgentRuntimeStore`, there is nothing to do** — the driver already had
everything both need.

```ts
// after
loadRun(input: { conversationId: string; runId: string }): Promise<AgentRunView | undefined>
listActiveRuns(conversationId: string): Promise<readonly AgentRun[]>
```

`AgentRunView` is `{ snapshotVersion, run, assistant? }`. `assistant` is the
retained terminal answer, so it is present exactly when the run has ended and
absent while it is live — a store that returns a live run's draft here lets the
terminal path resolve a run that has not finished. `listActiveRuns` orders by
`createdAt` then `id`, and must not report a run that has ended.
`runAgentStoreConformance` covers both, including the boundary cases.

#### If you have a store **double** in your tests

The runtime now reads `loadRun` where it used to read `loadSnapshot`. A double
that simulates a condition — a run drifting to another owner, a stale fencing
token — must apply it to both reads, or the code under test will not see it.
This is not hypothetical: it turned one of this repository's own fixtures into
an infinite retry loop, which is how the bounded retry below was found.

#### Nothing else changes

`loadSnapshot` behaves exactly as before, and still returns the whole
conversation — as does every mutation result. What it costs, and what bounds it,
is now written down in *Reading a conversation* in the agent-runtime guide.

### One provenance vocabulary, and integral tokens

#### If you match on `'measured'`

A **total** now says `computed`, because it is a sum this code performed rather
than a count it took — the same rule `AgentUsage` has always applied to a run's
spend. Two values change with no compile error:

```ts
// before
if (result.totalTokens.provenance === 'measured') { /* exact */ }
// after
if (result.totalTokens.provenance === 'computed') { /* exact, and derived */ }
```

It affects `AgentHistoryBudgetResult.totalTokens` and
`ComposedAgentPrompt.instructionTokens`. A per-message or per-section count is
still `measured` — only the totals moved. When any part was estimated the total
is still `estimated`: an estimate survives arithmetic, and that is the weaker
claim, so it wins.

#### If you produce token counts

They are validated now, in the places they were not. A fractional count throws
where it used to flow into the context-window arithmetic:

```ts
// refused from this release on
estimateTokens: (text) => ({ value: text.length / 4, provenance: 'estimated' })
// after
estimateTokens: (text) => ({ value: Math.ceil(text.length / 4), provenance: 'estimated' })
```

The same applies to `ComposeAgentPromptOptions.estimateFallback` and
`.historyTokens`, to `AgentPromptBudget.toolSchemas` / `.attachments` /
`.providerOverhead`, and to `AgentPromptBudget.contextWindow` /
`.reservedOutput`, which must now be non-negative safe integers.

`AgentUsageValue.value` is `z.int()` too, which matters if you build usage
records by hand or in a store double. A figure arriving from a **provider** is
not thrown — `normalizeSdkUsage` and the OpenRouter adapter turn a non-integer
into `{ provenance: 'unavailable' }`, so a run that already answered is not
failed over its own bookkeeping.

#### The new export

`AgentProvenanceSchema` / `AgentProvenance` is the whole vocabulary:
`provider-reported`, `measured`, `computed`, `estimated`, `unavailable`. Each
surface declares its subset, so nothing widened — `AgentUsageValue` still refuses
`measured` and `AgentTokenCount` still refuses `provider-reported`. Use it when
you want one switch over the question instead of two.

## Released migration: 0.65.0

The largest migration of the pre-1.0 line, and most of it is the compiler
pointing at things. One item is a feature withdrawal and two change behaviour
with no compile error at all.

### A projection a provider accepts, and a policy withdrawn

### If you compact, or use `system-note`, you were broken and now are not

No code change to adopt the fix — but **check your own code if you call
`projectAgentHistory` yourself.** System and summary records no longer appear in
`messages`; they come back in `system` and belong in the provider's instructions
channel, which is the only place `ai` accepts them:

```ts
// before — the provider refuses this outright
const messages = await projectAgentHistory(snapshot.messages)
streamText({ model, messages })

// after
const { messages, system } = await projectAgentHistoryDetailed(snapshot.messages)
streamText({
  model,
  instructions: system.map((content) => ({ role: 'system', content })),
  messages,
})
```

If you use `createAgentRuntime`, this is handled for you.

### `inputPolicy: 'inject'` is withdrawn

```ts
// before
runs: { inputPolicy: 'inject' }
// after
runs: { inputPolicy: 'queue' }
```

`'absorbed'`, `AgentRun.absorbedIntoRunId` and `AgentRuntimeStore.absorbQueuedRun`
go with it. A driver built on `AgentRuntimeStoreDriver` needs no change.

### Records must agree with themselves

If you construct `AgentRun` values — a store double, a fixture, a migration —
derive the state instead of setting it:

```ts
// after
import { runStateForTerminalReason } from 'stitchkit/agent-runtime'
AgentRunSchema.parse({ …run, terminalReason: reason, state: runStateForTerminalReason(reason) })
```

A terminal state with no reason, a queued run carrying one, and `policy_stop`
without a `terminalPolicyName` are now all refused at parse time.

### Enum and field changes the compiler will point at

- `AgentTerminalReason`: `'tool_failure'` removed (never produced),
  `'context_overflow'` added — this runtime's own refusal when the prompt does
  not fit, which used to report `provider_failure`.
- `AgentRunState`: `'absorbed'` removed.
- `AgentRunMetrics.usage` is required.
- `AgentHistoryBudgetDecision['reason']`: `'superseded'` → `'unspeakable'`.

### Two behaviour changes with no compile error

- **`loop.idleTimeoutMs` now defaults to 60 000.** A run whose provider stream
  goes quiet for a minute ends as `timeout` instead of holding the lane forever.
  Pass `null` for the old behaviour, and think about why you want it.
- **`advanceAgentRuntimeEventCursor` stops returning `gap` for durable events.**
  If you reload a conversation on `gap`, you were reloading after essentially
  every run. Transient events still report it, and there it is real.

## Released migration: 0.64.0

Two changes, and only one of them can break a build. Nothing was removed.

### An event that says which kind it is

### Narrow `AgentRunEvent` on `type`

```ts
// before
for (const event of events) record(event.usage?.cost?.value ?? 0)

// after — and the compiler will point at every site
for (const event of events) {
  if (event.type !== 'run-terminal') continue
  record(event.usage.cost.value ?? null)   // `usage` is present; unknown says so
}
```

`step` is now required on `step-finished`, `terminalReason` on `run-terminal`,
and `usage` on both. `queueWaitMs` exists only on `run-started`. Nothing was
removed — the fields that were optional because a *different* kind of event
lacked them are now simply on the kinds that have them.

Import `AgentRunTerminalEventSchema` (or the sibling schemas) if you construct
events in tests.

### If you implement `AgentRuntimeStore` directly, move to the driver

Not urgent and nothing breaks today — but the aggregate is no longer the
supported target, so its future growth will not be announced as breaking
(→ ADR 0111). The supported shape is one line:

```ts
const driver: AgentRuntimeStoreDriver<TransactionClient> = { /* six primitives */ }
export const store = createAgentRuntimeStore(driver)
```

Run `runAgentStoreConformance` against your adapter before and after any bump —
see *Before you bump, if you implement an agent store* above.

## Released migration: 0.63.0

Four changes to what a running system reports and how an input reaches a run
in flight. Nothing moves an export except one added store member, and only an
application implementing `AgentRuntimeStore` directly has to touch code.

### A spend figure that survives, and an input that joins

### `AgentRuntimeStore` has a ninth member

Only if you implement the aggregate interface directly — an adapter built on
`AgentRuntimeStoreDriver` needs no change, and the public conformance kit covers
the new operation.

```ts
// after
absorbQueuedRun(input: AbsorbQueuedRun): Promise<AgentStoreMutationResult>
```

It moves a queued successor's inputs into the run already answering, in one
mutation, and marks the successor `absorbed`. Two run records change in one
transaction — if your driver persists them one at a time, persist both.

### A provider failure says so

```ts
// before — an upstream error arrived as a policy stop with no policy
if (terminal.reason === 'policy_stop') retryLater()

// after
if (terminal.reason === 'provider_failure') retryLater()
if (terminal.reason === 'provider_stop') { /* a length cap or content filter */ }
```

`policy_stop` now always carries the `policyName` that caused it. If you switch
exhaustively on `AgentTerminalReason` or `AgentRunState`, add `'provider_stop'`
and `'absorbed'`.

### `partial` changed meaning

It used to tell you which event kind you were holding. It now tells you whether
the figure beside it is a confirmed total:

```ts
// after — true when the provider never reported the run finished
if (metrics.partial) treatAsFloor(metrics.usage)
```

Terminal events for runs that were superseded, interrupted, timed out or failed
before the provider finished now report `partial: true` where they reported
`false`.

### Checkpoint metrics are a running total

```ts
// wrong, and now wrong by more than it used to be
const spent = checkpoints.reduce((total, c) => total + (c.metrics.usage?.cost?.value ?? 0), 0)
// right
const spent = checkpoints.at(-1)?.metrics.usage?.cost?.value
```

### You can read a run's spend back from the store

`AgentRun.usage` is written at every checkpoint and with the terminal record, so
a dropped observability event no longer loses the number, and a process that dies
mid-stream leaves behind what it had already spent.

## Released migration: 0.62.0

Two groups of behaviour changes. Nothing moves an export — the surface is
strictly additive — and every item changes what a running system reports or
sends, which is what this heading is for. One of them changes a number you may
already be billing against.

### A run reports what it spent

Three changes to what the runtime says about cost and tokens. Nothing moves an
export; all three change numbers a running system reports, and one of them
changes a number you may already be billing against.

#### Multi-step cost was under-reported and is now summed

No code change is needed to get the fix — but check any predicate that reads
`provenance`:

```ts
// before — accepted a number that was one step's cost, not the run's
if (usage.cost?.provenance === 'provider-reported') bill(usage.cost.value)

// after — a sum stitchkit performed says so
if (usage.cost && usage.cost.provenance !== 'unavailable') bill(usage.cost.value)
```

`'computed'` means stitchkit added up provider-reported parts. It is not a guess
— `'estimated'` is the word for that — but it is deliberately not
`'provider-reported'`, because that label is what a caller filters on when it
wants a figure it can bill against unchanged, and a sum is not one.

Token totals moved with it. The AI SDK's `totalUsage` is a sum *it* performed
over per-step provider figures — not a run total any provider handed over — so
labelling it `provider-reported` was the same overstatement. **A run total on a
terminal event is always `computed`.** If you want a figure with the provider's
own word on it, read `step-finished`: each step carries what that call reported.

#### `usage` is always present on a terminal event

```ts
// before — absent when the run ended before the provider's `finish`
const spent = event.usage?.cost?.value ?? 0        // silently 0 for a real spend

// after — present, and it says what it does not know
event.usage?.cost?.provenance === 'unavailable'    // we spent, and cannot say how much
```

Keep the optional chaining: one `AgentRunEvent` shape covers `run-started`,
`step-finished` and `run-terminal`, so `usage` stays optional on the type. The
guarantee is about terminal events, and a schema shared with `run-started`
cannot express it.

**Do not read `unavailable` as zero.** A run aborted mid-stream has spent real
money that nobody has counted; a run that never reached the provider has not.
Both used to look the same and now do not.

#### A losing executor reports its own spend

An execution that loses the terminal compare-and-swap now emits an operator
`run-terminal` event, because it ran and it spent. If a sink treated those events
as "runs this process committed", that is no longer true — `AgentRuntimeResult.metrics`
is still `undefined` for a losing executor and remains the way to tell.

The *delivery* `terminal` event is unchanged and still fires only for the winner,
so nothing delivers a turn twice.

### An interrupted answer stops passing as a finished one

Two behaviour changes, one shared cause: a run ended by a newer input used to
leave its half-written answer in the conversation with no sign that it was cut
off, and the next request to the provider carried it as an ordinary assistant
turn.

#### The projection marks an interrupted turn

Nothing to change to adopt the fix — the default is the fixed behaviour. What to
check is whether the marker is the *right* form for your surface, and the
question that decides it is not "was the run interrupted" but **"did anyone see
what it produced"**.

```ts
// after — pick the form; the default is 'assistant-marked'
createAgentRuntime({ history: { interruptedAssistant: 'system-note' } })
```

- **The user pressed stop and the text was on their screen** — keep
  `'assistant-marked'`. The assistant turn is the truthful record of what the
  human read, and the model should stay consistent with it.
- **The partial never reached anyone** — a surface that sends nothing until the
  run is done — prefer `'system-note'`. An assistant turn in provider history is
  a commitment the model stays consistent with; a system line is context.

If you pass `history.project` you own the projection outright and none of this
applies — but the same question does.

#### A run ended by a newer input can now say so

```ts
// before
runs: { inputPolicy: 'interrupt' }   // ends the run, keeps its partial answer

// after — for a surface where a follow-up message invalidates the answer
// in flight rather than merely stopping it
runs: { inputPolicy: 'supersede' }   // ends the run, discards its partial answer
```

`inputPolicy` also accepts `(input) => policy`, which is how one application
gives two conversation surfaces different rules without the runtime learning
which is which.

A superseded run terminates with `terminalReason: 'superseded'`, state
`'superseded'` and an assistant message of status `'superseded'`. **If you switch
exhaustively on any of those enums, add the arm** — that is the part of this
release that can break a build rather than a behaviour. The record itself is
kept: it is excluded from the projection, not deleted, so an operator can still
see what was thrown away.

## Released migration: 0.61.0

Three behaviour changes between versions. None moves an export — the surface is
strictly additive — and all three change what a running system does, which is
what this heading is for.

### A failed `start()` now drains before it rejects

The rollback of a failed startup used to close every resource with a zero
budget: it returned almost at once, by severing requests the server had already
accepted. It now spends the application's shutdown budget, so a request already
in flight is answered rather than killed.

**What to check.** Nothing, if a failed startup has nothing in flight — the
rollback still returns immediately. The case to think about is a request that
never finishes: a hung upstream, a client ignoring a close frame, a streaming
subscription. Under the default 30s grace and 5s force, a `start()` that used to
reject in milliseconds can now take 35 seconds to reject.

If a fast failure matters more than draining — a supervisor waiting to restart,
a boot check in CI — declare a smaller budget. The same field is the default for
`shutdown()` with no options, so this is one decision, not two:

```ts
// before
createApplication({ id: 'app', resources })

// after
createApplication({
  id: 'app',
  resources,
  shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 },
})
```

The budget is a real bound: a `close` that never returns is abandoned when it
runs out and reported as a `close` failure, and the startup error remains the
`cause` of the `AggregateError` `start()` rejects with. → ADR 0107

### A refused realtime frame now answers its sender

A frame that fails the receiver's `args` schema used to be dropped where it
landed. If the event carries an acknowledgement, the receiver now answers it
with a reserved envelope and the sender's `request()` rejects at once with
`RealtimeRequestRejectedError`. → ADR 0106

**What to check before you upgrade one half of a distributed pair.** Look at the
`ack` schemas on the OLDER peer:

```ts
// safe: a contract-first acknowledgement refuses the envelope, so the older
// peer raises RealtimeRequestInvalidAcknowledgementError at once instead of
// waiting out its deadline. Different error, still an error, and sooner.
ack: z.object({ stored: z.boolean() })

// NOT safe: a schema that validates nothing accepts the refusal AS A VALUE.
// The older peer reads a refusal as a successful acknowledgement — silently.
ack: z.unknown()
ack: z.looseObject({})
```

If any acknowledgement on the older side is permissive, tighten it before the
rollout, or upgrade both halves together.

Also: the receiver now invokes the peer's raw acknowledgement callback for a
refused frame, including when the peer is a plain Socket.IO client. That
callback previously could not run on a refused frame and now can.

`RealtimeRejectedEvent['reason']` gained `'rejected-by-peer'`. If you `switch`
over it exhaustively with an `assertNever` default, that stops compiling — add
the case.

### Two smaller behaviour changes, easy to miss

**`streamSSE`'s `cancel` no longer awaits the generator.** Teardown is now
unordered relative to request completion. If your generator releases a resource
in `return()`/`finally` — a temp file, a pooled connection — and anything
downstream assumed that had finished by the time the response settled, it no
longer has. Release in the generator's own `finally` and do not depend on the
ordering.

**A `socket.io-client` peer that cannot load no longer kills the process.** With
`onConnectError` configured, the failure is delivered there with
`terminal: true` instead of crashing. If your handler logs and moves on, you now
have a live process whose client will never connect, where a supervisor used to
restart it. Treat `terminal: true` as fatal if that is what you want.

### `reportHealth` inside `start` is no longer discarded

Becoming ready assigned `healthy` unconditionally, throwing away whatever a
resource reported during `start`. It is now kept, and only a resource that
reported nothing is assumed healthy.

**How to find what this touches:** grep your `start` bodies for **every**
`reportHealth` call, not only the ones reporting `degraded`. The old
unconditional assignment was also a repair — a resource that reported
`'unhealthy'` early in `start` and never corrected itself was quietly fixed up
on the way to ready.

Two cases, and they need opposite fixes.

**1. A resource that is genuinely expected to start degraded** — up, but still
dialling something external. `required` defaults to **`true`**, and readiness
requires every required resource to be healthy, so such a resource now refuses
the whole startup where before its report vanished. That is the invariant
working as intended; what changed is that it can be reached. Say what it is:

```ts
// before: started, and its report was discarded
defineManagedResource({ id: 'dialling', start: ({ reportHealth }) => reportHealth('degraded') })

// after: says what it is, and does not gate the application
defineManagedResource({ id: 'dialling', required: false, start: ({ reportHealth }) => reportHealth('degraded') })
```

**2. A resource that reported `'unhealthy'` early and became healthy later** —
a pessimistic report before a connection settled. Here `required: false` is the
**wrong** fix: it would hide a real failure. Report the recovery instead:

```ts
start: async ({ reportHealth }) => {
  reportHealth('unhealthy')
  await connect()
  reportHealth('healthy')   // ← previously unnecessary; now it is the fix
}
```

**Also check your health endpoint.** An **optional** resource reporting
non-healthy during `start` now moves the application aggregate to `degraded`,
where before it stayed `healthy`. A readiness probe that maps `degraded` to a
non-200 will flip on upgrade — and a supervisor that restarts on that will loop.

The refusals now say which of the two happened: a resource that was never
healthy is told it "is not healthy" and pointed at `required: false`; one that
was healthy and stopped is told it "lost readiness" and pointed at
`onResourceFailure`.

## Released migration: 0.60.0

### close() says what it achieved

`AgentRuntime.close()` returned `Promise<void>` and its contract promised three
things that cannot hold together. It now returns
`{ settled, timedOut, remaining }`.

Nothing breaks if you ignore the value:

```ts
await runtime.close({ gracePeriodMs: 30_000, forceTimeoutMs: 5_000 })
```

What DOES change is any code that relied on the old sentence "`close()` never
returns while a run is still in flight" while naming a `forceTimeoutMs`. That
was never true — the force budget exists precisely to stop waiting — so if your
process exits straight after `close()`, read the result:

```ts
const closed = await runtime.close({ gracePeriodMs: 30_000, forceTimeoutMs: 5_000 })
if (!closed.settled) {
  // `closed.remaining` runs were still in flight. They stay recoverable
  // through `scanRecoverable`; close never marks them terminal on its own.
  logger.warn({ remaining: closed.remaining }, 'exiting with runs in flight')
}
```

If you want the old guarantee, omit `forceTimeoutMs`: that is the one
combination in which `close()` cannot return with a run in flight — and its wait
is unbounded, which is the trade.

A TypeScript consumer that wrote `const done: void = await runtime.close()` is
the only shape that stops compiling.

### one name per concept

`AgentModelDeclaration` was a bare alias of `AgentModelDescriptor`, so the same
type reached consumers under two exported names:

```ts
// before
defineModelRegistry<Record<string, AgentModelDeclaration>>({ … })
// after
defineModelRegistry<Record<string, AgentModelDescriptor>>({ … })
```

A find-and-replace covers it; there is no behavioural change. Kept name is
`AgentModelDescriptor`, the one paired with `AgentModelDescriptorSchema` and
returned by `registry.descriptor()`.

Two names that look like the same case and are **not** being merged:
`SocketEventMap` aliases Socket.IO's `EventsMap` so a vendor's name stays out of
our signatures, and `AgentRun.ownerId` holds the same value a runtime publishes
as `runtimeEpoch` on its events. The latter is one identity in two roles — "who
owns this run" and "which runtime emitted this event" — and both declarations
now say so. Renaming either would make the fencing comparison read worse.

### a reachable public surface

Three exports that the public API required and did not provide, plus one option
it accepted and ignored.

```ts
// before — identified by string, because the class was exported nowhere
if (error instanceof Error && error.name === 'AgentRuntimeConflictError') …
// after
import { AgentRuntimeConflictError } from 'stitchkit/agent-runtime'
if (error instanceof AgentRuntimeConflictError) …
```

`ActivityTokenBrand` is exported, so `ActivityProjection` can be implemented by
a test double. `STITCH_ERROR_STATUS` gained `APPLICATION_NOT_ACCEPTING` (503) —
only an exhaustive `satisfies Record<StitchErrorCode, …>` map stops compiling,
and the fix is one line. (`GRAMMY_WEBHOOK_NOT_ACCEPTING` joined it in 0.60.1,
under the same rule — see ADR 0105. This section briefly said the opposite: that
an adapter's code stays out of the registry. It does not, and leaving it out was
the worse of the two, because `isStitchErrorCode` then answered `false` and the
code reached the wire spelled stitchkit's way, past both `codeMap` and
`unmappedCode`.)

`application.shutdown()` no longer accepts `retryAfterSeconds`. Delete it from
the call — the kernel never read it. If you meant the HTTP `Retry-After` a
draining server sends, that lives on `managedServerResource({ retryAfterSeconds })`,
where it always did the work.

### one shutdown vocabulary

```ts
// before
await runtime.close({ drainTimeoutMs: 30_000, forceTimeoutMs: 5_000 })
// after
await runtime.close({ gracePeriodMs: 30_000, forceTimeoutMs: 5_000 })
```

The rename is mechanical. The behaviour change under it is not, and it is the
reason the rename waited: two combinations were traps.
`close({ drainTimeoutMs })` with no force budget aborted the runs and returned
**without waiting for them to settle** — so naming a budget gave a weaker
guarantee than naming none — and `close({ forceTimeoutMs })` with no drain
budget never read the force budget, leaving an unbounded wait. Both now behave
as their names say.

> **Superseded.** This section once ended "and `close()` never returns while a
> run is in flight". That was never true with a force budget — the budget exists
> to stop waiting — and `close()` now returns `{ settled, timedOut, remaining }`
> instead of promising it. See *Released migration: 0.60.0 → close() says what
> it achieved*, above.

If your shutdown path measured how long `close()` took, expect it to take
longer in exactly the case where it used to return early — that is the fix, not
a regression. Defaults stay per-surface: `ShutdownOptions.gracePeriodMs`
defaults to 30 seconds, and the runtime's omitted budget still means "abort
immediately", the behaviour `close()` has always had.

### unresolved attachments are omitted

`history.unresolvedFile` defaulted to `text`, and the placeholder it produced
carried the storage reference:

```ts
// before — the provider received your object key
// "[attachment: s3://bucket/tenants/42/invoice.pdf]"
history: {}
// after — omitted entirely by default; ask for a placeholder explicitly
history: { unresolvedFile: 'text' }   // "[attachment: invoice.pdf]"
```

Two things to check. If a prompt relied on the model seeing *something* where an
unresolved file was, set `unresolvedFile: 'text'` — behaviour otherwise changes
silently, since an omitted part produces no error. And if any stored transcript
or provider log contains the old placeholder, it contains your storage layout;
treat those as disclosed. The `error` policy still names the reference, because
it is thrown into your process rather than sent upstream.

### one bounded recoverable scan

`AgentRuntimeStore` had two scans: a mandatory unbounded one and an optional
paged one. The runtime only ever called the optional one, so implementing the
interface as written produced a store that threw on its first `recover()`:

```ts
// before — the mandatory member was dead, the needed one was optional
{
  scanRecoverable: () => loadEveryRecoverableSnapshot(),
  scanRecoverablePage: ({ cursor, limit }) => page(cursor, limit),
}
// after — one member, the bounded signature the driver already used
{ scanRecoverable: ({ cursor, limit }) => page(cursor, limit) }
```

Delete the unbounded implementation rather than porting it: loading every
recoverable conversation to start is the shape 0.59.0 and ADR 0101 moved away
from, and nothing calls it now. If you built on `createAgentRuntimeStore()` you
have nothing to do **if you only pass it to the runtime** — it implements the
bounded page for you from the same driver member. If you CALL it yourself, the
member changed shape: `scanRecoverable()` took no argument and returned
snapshots; it now takes `{ cursor?, limit }` — `limit` is required — and returns
one page of descriptors.
```ts
// before: const stale = await store.scanRecoverable()
// after:  const { items, nextCursor } = await store.scanRecoverable({ limit: 100 })
```

### published application status

`createApplicationHealthHandler` and `createApplicationOperationalHandlers` no
longer serialise the whole `ApplicationSnapshot`. They publish
`ApplicationStatusProjection` — the verdict plus resource counts:

```ts
// before — the response named every resource and its dependency edges
const { resources } = await fetch('/status').then((r) => r.json())
resources[0].dependsOn
// after — the topology is read in-process, where it always belonged
app.getSnapshot().resources[0].dependsOn
```

The consequence to check is not compilation — it is whatever already consumes
these routes. A dashboard that drew the dependency graph from `/status`, or an
alert keyed on `admission.pending`, goes blank rather than red: the fields are
absent, not zero. Both are available from `getSnapshot()`, so the fix is to read
them in the process that owns the application and publish them on a channel you
control. If a route was reachable from outside your network, treat the previous
payload as disclosed and rotate nothing but assume the topology is known.

## Released migration: 0.59.0

### Normalized agent runtime persistence

`AgentRuntimeStoreDriver` no longer reads and rewrites a lifetime `AgentStoredState` JSON
aggregate. Migrate that row and its recoverable/archive projections once:

1. Copy `conversationId` and `version` into the bounded runtime head.
2. Write every `AgentStoredState.runs[]` entry as one normalized run record.
3. Write every `AgentStoredState.admissions[]` entry as one admission receipt and copy its
   canonical input into that receipt.
4. For terminal runs, retain the canonical assistant on the run record before deleting any old
   history/archive rows.
5. Replace the recoverable projection with an index over normalized run `state`.
6. Cut the adapter over atomically; there is no compatibility driver or dual-write mode.

```ts
// before
createAgentRuntimeStore({
  state: { load, compareAndSwap },
  history: { load, loadById, apply },
  scanRecoverable,
})

// after
createAgentRuntimeStore({
  head: { load, compareAndSwap },
  runs: { load, loadByAssistantMessageId, loadMany, listActive, save },
  admissions: { load, loadByInputMessageId, create },
  history: { load, apply },
  scanRecoverable,
})
```

`AgentRuntimeHeadSchema`, `AgentStoredRunSchema` and `AgentAdmissionReceiptSchema` replace
`AgentStoredStateSchema` and `AgentAdmissionIdentitySchema`. Run
`runAgentStoreConformance()` against the migrated adapter before switching production traffic.
If an application implements `AgentRuntimeStore` directly, its duplicate result must also include
the canonical `run` and the retained `assistant` for a terminal run.

## Released migration: 0.58.0

### The default history projection rejects invalid chronology

`projectAgentHistory` no longer forwards records a provider contract cannot
accept. A completed assistant record before the first user message, and an
assistant record whose tool calls have no matching results, are omitted with an
inspectable decision instead of being sent upstream:

```ts
// before — a leading assistant record was forwarded as-is
projectAgentHistory(messages)
// after — opt in explicitly, and only where the provider contract permits it
projectAgentHistory(messages, { leadingAssistant: 'allow' })
```

Two consequences the changelog does not spell out. First, the projection can now
return **fewer** messages than the history holds, so any assertion or metric
that compared projected length against stored length will move; read the
detailed projection instead — it reports what was omitted and why, which is the
supported way to see the difference. Second, the omission is silent to the
provider but not to you: if a conversation suddenly loses its leading context,
the decision record is where that shows up, not the transcript.

### Operator events redact `internalCause` by default

Raw provider and tool failures no longer travel in operator events unless the
sink asks for them:

```ts
// before — internalCause was present
createAgentObservability({ write })
// after — an explicit operator-only opt-in
createAgentObservability({ write, includeInternalCause: true })
```

The consequence to check before upgrading: any dashboard, alert or log
processor keyed on `internalCause` goes blind the moment you upgrade, and it
goes blind quietly — the field is absent, not empty. Set the flag on the
operator sink you own. Product delivery stays redacted regardless of the flag;
this option cannot widen what reaches a user.

## Released migration: 0.57.0

### Duplicate admission results carry the complete identity

Custom `AgentRuntimeStore` adapters must persist and return the input and
assistant identities associated with an idempotency key:

```ts
// before
return { outcome: 'duplicate', runId, snapshot }

// after
return { outcome: 'duplicate', input, inputMessageId, runId, assistantMessageId, snapshot }
```

Prefer replacing the custom aggregate reducer with `createAgentRuntimeStore()`;
its admission record and transaction driver implement this contract
automatically. Historical note: 0.59.0 reshaped this driver again, so an adapter
crossing both versions should read that section first and migrate once.

### `AgentRuntimeEvent` adds a post-commit `admission` variant

Add it to any exhaustive publisher switch. Its `assistant` is either the pending
placeholder for a new assignment or the canonical persisted assistant for a
duplicate:

```ts
case 'admission':
  await persistProductProjection(event.input, event.run, event.assistant)
  break
```

The consequence for an exhaustive switch written without a `default` branch is a
compile error, which is the point. The consequence for a switch that *has* a
`default` is worse and silent: post-commit admissions fall into it and are
projected as an unknown event. Grep for publisher switches before upgrading.

## Released migration: 0.56.0

### Surface manifests are version 2

`operation.tools` could not describe a role-selected MCP surface, a different
Agent or CLI selection, or an advertised `extend` schema, so projections moved
out of the canonical operation:

```ts
// before
manifest.operations[0].tools.MCP
// after
manifest.toolSurfaces.find((s) => s.transport === 'MCP' && s.surface === null)?.tools

// before
buildSurfaceManifest({ mcpSurfaces: { admin: { services, extend } } })
// after
buildSurfaceManifest({ mcpSurfaces: { admin: { services } }, mcpPreparation: { extend } })
```

A committed snapshot is regenerated once, deliberately: `manifestVersion` is
`2`, and `ConformanceTransport` gained `REALTIME`, so any exhaustive
`Record<ConformanceTransport, …>` must handle it.

### `FILE_*` codes joined the error registry

`StitchErrorCode` gained `FILE_INVALID_PATH`, `FILE_OUTSIDE_ROOT`,
`FILE_NOT_FOUND`, `FILE_NOT_REGULAR`, `FILE_INSPECTION_REJECTED`,
`FILE_TOO_LARGE` and `FILE_EXISTS`. Only exhaustive maps break:

```ts
// before — compiled while the registry had no file codes
const copy: Record<StitchErrorCode, string> = { …, RATE_LIMITED: '…' }
// after — add the seven managed-file codes (or use Partial<Record<…>>)
```

Unexpected IO stays scrubbed as `INTERNAL_SERVER_ERROR`: the new codes are the
caller-safe ones only.

### `ScopedAuthHook` is nominal

A hand-written function shaped like an auth hook is no longer assignable —
identity now comes from the factory, so scope ownership and the inferred
context cannot drift apart:

```ts
// before — a structural stand-in
const auth: ScopedAuthHook<Scopes> = async (ctx, endpoint) => { … }
// after — create it, then compose domains
const auth = createAuthHook({ resolve, rules })
const composed = composeAuthHooks({ hooks: [auth, billingAuth], defaultScope: 'public' })
```

### Managed-file inspectors also run on reads

An inspector is no longer write-only, and it has a finite default deadline
(15 s). Make it read-aware and idempotent — a read carries no
`declaredMediaType`:

```ts
// before
inspect: ({ declaredMediaType }) => inspectDeclaredType(declaredMediaType!)
// after
inspect: ({ prefix, declaredMediaType, signal }) =>
  inspectBytes(prefix, { declaredMediaType, signal })
```

Set `inspectionTimeoutMs` explicitly when 15 seconds is the wrong budget.

### Direct async-operation binding needs a wire-stable ID

A direct binding reuses the start output as the follow-up wire input, so the ID
schema must parse to itself (`z.input` equals `z.output`, no transform,
coercion, default or overwrite). Anything else is parsed twice:

```ts
// before — a transform silently ran on start and again on every follow-up
defineAsyncOperationContract({ binding: 'direct', id: z.string().transform(Number) })
// after — keep the wire shape, adapt explicitly
defineAsyncOperationContract({
  binding: 'adapted',
  id,
  adapters: { idFromStart, inputFor },
})
```

## Released migration: 0.55.0

### Peer-free `implementRemote`

`implementRemote` now has one canonical, optional-peer-free owner. This keeps
MCP SDK and AI SDK modules out of CLI bundles that only proxy HTTP calls:

```ts
// before
import { implementRemote } from 'stitchkit/tools'
// after
import { implementRemote } from 'stitchkit/remote'
```

### Managed file boundary and strict auth returns

Create one boundary during application bootstrap and pass the capability, never
a per-call directory or host path:

```ts
import { createManagedFileBoundary } from 'stitchkit/files'

const files = await createManagedFileBoundary({ root: '/srv/app-files' })

// before
defineDownloadTool({ defaultDir: '/srv/app-files', resolveUrl, ...common })
defineUploadTool({ upload: (path) => provider.uploadFile(path), ...common })
defineViewFileTool({ baseDir: '/srv/app-files', ...common })

// after
defineDownloadTool({ files, resolveUrl, ...common })
defineUploadTool({ files, upload: ({ bytes }) => provider.upload(bytes), ...common })
defineViewFileTool({ files, ...common })
```

Downloaded `path` is now relative to the boundary and MIME metadata is named
`mediaType`. Update raw `mountDownload`/`mountUpload`/`mountViewFile` configs the
same way. Auth predicates must explicitly return `true`, `false`, or a plain
object of context fields; replace accidental `undefined` fallthroughs with the
intended boolean.

## Released migration: 0.53.0

### Realtime `emit` returns `boolean` instead of `void`

Every **call site** compiles and behaves exactly as before — the return value
is new information (`true` = accepted by the transport, `false` = dropped
while the browser client was disconnected), not a behavior change. What breaks
is **implementing** the interfaces: a test mock or app-side adapter of
`SocketIOClient` / `RealtimeClient` / `ValidatedRealtimeSocket` /
`RealtimeServer` whose `emit` returns `void` no longer typechecks.

```ts
// before — a void mock satisfied the interface
const mock: Pick<RealtimeClient<S, C>, 'emit'> = { emit: () => {} }
// after — report acceptance (true is what a live server-side emit reports)
const mock: Pick<RealtimeClient<S, C>, 'emit'> = { emit: () => true }
```

While migrating, consider replacing hand-rolled `if (client.connected)` guards
with the new honest surface: check `client.emit(...) === false`, or observe
drops centrally with `onDroppedEmit`.

## Released migration: 0.50.0

### The factory's scope union now covers per-endpoint overrides

`createContractFactory<Scope>()` already required a typed `scope` on the
contract. It now holds a per-endpoint `scope` override to the same union. Nothing
to migrate unless an override is outside the union — which was always a bug: the
scope reached no auth rule, and `createAuthHook` threw
`[stitchkit] auth: no rule for scope "…"` on the first request to it.

```ts
const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>()

defineContract({ prefix: 'posts', scope: 'user' }, {
  // before: compiled; failed at request time
  // after:  compile error naming the scope (TypeScript even suggests 'admin')
  purge: { method: 'DELETE', path: '/all', desc: 'Purge', scope: 'admn', output },
})
```

Fix the typo, or widen the factory union if the scope is real. Contracts built
with plain `defineContract` are unaffected.

### A declared `defineErrors` message is now used

`ErrorDefinition` accepts `message`. Nothing to migrate unless a registry already
wrote that key: it type-checked before (excess-property checking does not fire
through a `const` generic) and was ignored, so the code itself went on the wire.

```ts
const { errors } = defineErrors({ GONE: { status: 410, message: 'Long gone' } })
// before: errors.GONE().message === 'GONE'
// after:  errors.GONE().message === 'Long gone'
```

If a registry carried `message` as a note to the reader rather than as
user-facing text, either fix the text or drop the key. A code with no `details`
schema also shows that text to a model (its tool `details` is `{ message }`).

### Optional: adopt `createScopedImplement`

If the app declares one superset handler context because different scopes inject
different fields, replace it with a scope map. This is additive — `createImplement`
still works.

```ts
// before — one context for every scope; `ctx.userId` is typed even in a
// `public` handler, where the runtime never injects it
interface AppContext extends RuntimeContext { userId: string; isAdmin: boolean }
export const implement = createImplement<AppContext>()

// after — each handler typed by its endpoint's effective scope
export const implementFor = createScopedImplement<{
  public: object
  user: { userId: string }
  admin: { userId: string; isAdmin: boolean }
}>()
```

`'public'` must be a key (a contract with no `scope` is `'public'`). Write
endpoints inline in the contract literal: an endpoint hoisted into a variable
widens its `scope` to `string` and is reported as undeclared.

## Released migration: 0.49.0

### The server handle became managed

`createServer()` and `serveNode()` return a handle that owns admission, HTTP
drain, realtime closure and one deadline-bounded runtime stop:

```ts
// before
server.stop()
await socket.io.close()
// after
await server.shutdown({ gracePeriodMs: 30_000 })
```

The runtime-specific instance stays reachable at `.runtime`, so an escape hatch
you already rely on does not disappear — but code that closed transports itself,
in its own order, is now racing the handle. Delete the manual closes rather than
keeping both; the handle's result tells you what it drained and what it forced.

### Socket.IO mounts through the whole handle

```ts
// before
createServer({ websocket: socket.websocket, rawRoutes: [socket.route] })
// after
createServer({ socket })
```

One owner for the route, the WebSocket attachment and the closure. For a raw Bun
lane, keep the composed `websocket` handler and pass `socket` beside it.

### Bun native `routes` are gone

Native routes run before the Fetch handler, so they bypassed managed admission —
which means they also bypassed shutdown, logging and observability, and that is
why they had to go rather than be wired up:

```ts
// before
createServer({ routes: { '/health': () => Response.json({ ok: true }) } })
// after
createServer({ rawRoutes: [{ method: 'GET', path: '/health', handler: () => Response.json({ ok: true }) }] })
```

### The handshake policy takes a Web `Request`

```ts
// before
createSocketIOServer({ serverOptions: { allowRequest: (req, done) => done(null, allowed(req)) } })
// after
createSocketIOServer({ allowRequest: (request) => allowed(request) })
```

The Node-shaped callback is gone, and the policy is now composed with shutdown
admission on both runtimes: a handshake arriving during drain is refused for
you.

## Released migration: 0.48.0

### Typed-client request options move to `.withOptions`

Generated endpoint methods reserve their ordinary call signature for contract
variables. This keeps them directly assignable to callback APIs whose runtime
supplies its own second context argument, including `react-query-kit` and
TanStack Query. Move imperative cancellation to the callable's explicit method:

```ts
// before — endpoint with arguments
await api.create({ name: 'Max' }, { signal })

// after
await api.create.withOptions({ name: 'Max' }, { signal })

// before — endpoint without arguments
await api.health({ signal })

// after
await api.health.withOptions({ signal })
```

Direct query and mutation composition remains unchanged:

```ts
createMutation({ mutationFn: api.create })
createQuery({ queryKey: ['search'], fetcher: api.search })
```

There is no positional-options alias. Ordinary generated methods ignore extra
runtime callback arguments; only `.withOptions` reads `ClientRequestOptions`.

## Released migration: 0.47.0

### HTTP auth moves to the pre-body `authorize` phase

Move the HTTP wiring of `createAuthHook` from `beforeHandle` to `authorize`.
This lets Stitchkit reject an unauthorized JSON or multipart request after path
parameter validation but before reading a body chunk. Keep application
preconditions that depend on validated input in `beforeHandle`.

```ts
const auth = createAuthHook({ authenticate, authorize })

// before
createServer({ services, hooks: { beforeHandle: auth } })

// after
createServer({ services, hooks: { authorize: auth } })
```

Tool transports already receive parsed input, so their wiring does not move:

```ts
createMcpHandler({ services, lifecycle: { beforeHandle: auth } })
```

If a custom HTTP authorization hook read `ctx.input`, `ctx.files` or raw body
state, split it: identity/scope checks belong in `authorize`; validated payload
preconditions belong in `beforeHandle` or the domain service.

### Multipart uses a typed descriptor and `ctx.files`

Replace every string multipart declaration, top-level `maxUploadBytes` and
`ctx.file`. The descriptor is now the only source of request, per-file,
cardinality and declared media-type policy.

```ts
// before
upload: {
  method: 'POST',
  path: '/',
  multipart: 'file',
  maxUploadBytes: 25 * 1024 * 1024,
}
upload: ({ file, input }) => store(file, input)

// after
upload: {
  method: 'POST',
  path: '/',
  multipart: {
    maxRequestBytes: 25 * 1024 * 1024,
    files: {
      file: {
        maxBytes: 20 * 1024 * 1024,
        contentTypes: ['image/*', 'application/pdf'],
      },
    },
  },
}
upload: ({ files, input }) => store(files.file, input)
```

Multiple files are repeated under one multipart field name and arrive in the
same order:

```ts
files: {
  attachments: { multiple: true, maxFiles: 8 },
}

await api.upload({ attachments: [firstFile, secondFile] })
// handler: files.attachments is File[]
```

For direct-to-storage delivery, set `delivery: 'stream'` and implement the
endpoint with `defineMultipartStream`. A receiver must consume its Web Stream
and return `{ value, cleanup }`; the final handler sees only receiver values.
There is no deprecated overload or buffered compatibility path under the old
contract shape.

## Worked example — frozen on 0.3, jumping to 0.7

1. `bun.lock` → consumer resolves `stitchkit@0.3.x`.
2. Target: `0.7.0`.
3. Scan CHANGELOG `### ⚠️ Breaking changes` for 0.4.0 … 0.7.0 → **none** (every
   release was additive — new exports, an extra hook argument, opt-in fields).
4. Nothing to migrate.
5. `bun add stitchkit@^0.7.0`, `bun install`.
6. `bun run check` green → runtime smoke → done. New surfaces
   (`STITCH_ERROR_STATUS`, `serveFile`, `scopePrefixes`, `afterToolCall`'s
   `MethodDef`, `maxUploadBytes`) are available to adopt, not required.

## Released migration: 0.46.0

### `REALTIME_CONTRACT_VIOLATION` joined the error registry

Realtime contract failures use the framework error model instead of a bare
`ZodError`, so an exhaustive map stops compiling until the code is added:

```ts
// before
{ …, INTERNAL_SERVER_ERROR: 'internal' } satisfies Record<StitchErrorCode, string>
// after
{ …, INTERNAL_SERVER_ERROR: 'internal', REALTIME_CONTRACT_VIOLATION: 'internal' } satisfies Record<StitchErrorCode, string>
```

Only an exhaustive map breaks. Since 0.56.1 `codeMap` itself is partial, so a
map without the `satisfies` keeps compiling and lets the code travel as itself.

### `RealtimeRejectedEvent.error` is an `AppError`

```ts
// before
onRejected: ({ error }) => error.issues
// after
onRejected: ({ error }) => error.details?.issues   // the ZodError moves to error.cause
```

The envelope gained `reason` and `fault`. The consequence worth checking: code
reading `.issues` directly does not fail to compile if the handler is loosely
typed — it silently reads `undefined`. Grep for `.issues` on rejection handlers.

### CLI construction refuses reserved names

A contract field or tool named `json`, `wait`, `quiet`, `dry-run`, `help`,
`version`, `wait-timeout` or `output-dir` now **throws while the CLI is built**,
instead of being silently shadowed:

```ts
// before: app schedule_job --wait 2h  → {"path":"2h"}, exit 0
// after:  building a CLI over a contract with a "wait" field throws
```

This one fires at startup, not at call time, so an application shipping such a
field crashes on boot after the upgrade. That is deliberate — the old behaviour
corrupted arguments silently — but it means the upgrade is not safe to deploy
without building the CLI once locally.

### `createToolLogger` writes to stderr

stdout is the JSON-RPC channel of a stdio MCP server, and the previous
`console.info` default corrupted it. Pass `log` to redirect if your process
collected tool logs from stdout.

## Released migration: 0.44.0

### MCP TypeScript SDK v2 and protocol `2026-07-28`

This is a hard cut: there is one Stitchkit API and no v1 aliases. Applications
that expose MCP install the split server package; applications that implement an
MCP host or run client E2E install the split client package.

```bash
bun remove @modelcontextprotocol/sdk
bun add @modelcontextprotocol/server@^2 ai@^7
# MCP hosts and client-side E2E only:
bun add -d @modelcontextprotocol/client@^2
```

Direct SDK imports move to the split packages too:

```ts
// before
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// after
import { McpServer } from '@modelcontextprotocol/server'
```

MCP Apps additionally install `@modelcontextprotocol/ext-apps`. That adapter may
carry its own isolated v1-era transitive/peer relationship while the ecosystem
finishes its cutover; it does not permit application code to import the removed
monolithic SDK. Application-owned MCP server and client code uses the v2 split
packages exclusively.

```ts
// before
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpHandler } from 'stitchkit/tools'

const handleMcp = createMcpHandler({
  serverInfo,
  auth,
  services,
  sessionMode: 'stateless',
})
rawRoutes: [{ method: 'ALL', path: '/mcp', handler: handleMcp }]

// after
import { Client } from '@modelcontextprotocol/client'
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools'

const mcp = createMcpHandler({
  serverInfo,
  auth,
  services,
  legacy: 'serve',
})
rawRoutes: [createMcpHttpRoute({ path: '/mcp', handler: mcp })]
// graceful shutdown: await mcp.close()
```

Keep the owned handle and close it from the same shutdown path as the HTTP
server. A minimal runtime smoke should list tools before shutdown and prove the
closed handler no longer serves requests:

```ts
const mcp = createMcpHandler(config)
const route = createMcpHttpRoute({ path: '/mcp', handler: mcp })

const beforeClose = await route.handler(listToolsRequest)
if (!beforeClose.ok) throw new Error('MCP list-tools smoke failed')

await mcp.close()
```

Remove `@modelcontextprotocol/sdk`, `sessionMode`, `McpSessionMode`, session
stores and all `Mcp-Session-Id` handling. HTTP is always request-isolated and
stateless. `legacy: 'serve'` (default) lets the official SDK negotiate supported
pre-2026 stateless clients on the same endpoint; `legacy: 'reject'` makes it
modern-only. This is not a stateful compatibility transport.

#### Output shape depends on the negotiated protocol era

Stitchkit always validates the handler result against the declared output
schema. The negotiated MCP era determines only its wire representation:

| Negotiated era | Non-object `structuredContent` |
|---|---|
| MCP `2026-07-28` | the exact schema-valid JSON root: array, scalar or `null` |
| supported legacy era | the official SDK codec adapts it to `{ result: value }` |

Object roots keep their object shape in both eras. Do not change every consumer
expectation to the modern shape while `legacy: 'serve'` remains enabled. Pin
both protocol versions in the consumer's transport E2E and assert the boundary
explicitly:

```ts
await expectToolOutputForProtocol('2026-07-28', ['a', 'b'])
await expectToolOutputForProtocol('2025-11-25', { result: ['a', 'b'] })

async function expectToolOutputForProtocol(
  protocolVersion: '2026-07-28' | '2025-11-25',
  expected: unknown,
) {
  const client = await connectConsumerMcpClient({ protocolVersion })
  const result = await client.callTool({ name: 'list_notes', arguments: {} })
  expect(result.structuredContent).toEqual(expected)
  await client.close()
}
```

`connectConsumerMcpClient` represents the consumer's real HTTP or stdio setup;
configure its official client with `versionNegotiation.mode.pin` so the test
cannot silently negotiate a different era.

The stdio helper now returns an owned lifecycle handle:

```ts
// before
await createStdioMcpServer(config)

// after
const stdio = await createStdioMcpServer({ ...config, legacy: 'serve' })
await stdio.close()
```

OAuth client registration is now one explicit policy object. CIMD is secure and
enabled by default; DCR is disabled unless supplied:

```ts
// before
mountOAuthProvider({ ...oauth, clients, codes, refreshTokens })

// after
mountOAuthProvider({
  ...oauth,
  clientRegistration: {
    preRegistered: { get: clients.get },
    // optional: dcr: { register: clients.register, get: clients.get }
  },
  codes,
  refreshTokens,
})
```

A URL client id must be HTTPS and serve a document whose `client_id` exactly
matches that URL, with explicit `redirect_uris` and
`token_endpoint_auth_method: 'none'`. Do not keep a consumer-side metadata
fetcher or DCR fallback; Stitchkit owns SSRF-safe resolution and caching.

Multi-round input is opt-in on the operation and does not change Agent, CLI or
ordinary HTTP handlers:

```ts
const ConfirmationSchema = z.object({ confirmed: z.boolean() })

mcp: {
  inputRequired: [{
    key: 'confirmation',
    message: 'Confirm this action',
    schema: ConfirmationSchema,
  }],
}
```

Configure `multiRound.state` on the MCP server with a key of at least 32 bytes
and a stable authenticated `principal`. Read accepted typed content from
`ctx.mcpInput.confirmation`. Multiple declarations run in array order, the
aggregate remains exactly typed by key, keys must be unique, and declarations
must fit `multiRound.serving.maxRounds` (default `10`). Do not execute a
destructive side effect before the complete aggregate is accepted. A modern
request missing the declared elicitation capability receives JSON-RPC error
code `-32021`. The official per-request legacy HTTP bridge cannot issue
server-to-client elicitation, so it returns a deterministic failed tool result;
multi-round input is never silently treated as complete.

#### Compatibility matrix

| Host / transport | Tools and Apps | Multi-round input | Continuity |
|---|---|---|---|
| `2026-07-28` HTTP | yes | yes | request-isolated |
| supported legacy stateless HTTP | yes | unsupported result | request-isolated |
| `2026-07-28` stdio | yes | yes | one process connection |
| supported legacy stdio | yes | official SDK bridge | one process connection |
| Agent / CLI / ordinary HTTP | unchanged | not exposed | unchanged |

Subscriptions, cross-request progress and resumable stateful SSE are not
implemented or advertised.

#### Consumer checklist

1. Replace the monolithic SDK with `@modelcontextprotocol/server@^2` and, only
   for hosts/tests, `@modelcontextprotocol/client@^2`.
2. Replace raw MCP route wiring with `createMcpHttpRoute`; retain and close the
   returned handler/stdio handle during shutdown.
3. Delete all session mode, event-store and session-id code.
4. Move OAuth client policy under `clientRegistration`; publish CIMD or enable
   DCR explicitly.
5. Make `authorizeUser` return the exact consented scope subset. The framework
   validates that it is a subset of the request before saving the authorization
   code:

   ```ts
   // before
   authorizeUser: async () => ({ userId })

   // after
   authorizeUser: async (_req, request) => ({
     userId,
     approvedScopes: request.scope?.split(' ') ?? [],
   })
   ```

6. Snapshot `listToolNames`, run one contract tool, one runtime tool, any raw
   multimodal tool and every MCP App resource you use.
7. Exercise modern HTTP and stdio with protocol `2026-07-28`; exercise legacy
   only if `legacy: 'serve'` is part of your support policy.
8. Run the consumer's typecheck and runtime gates. A browser/HTTP-only consumer
   must continue to work without either MCP package.

## Historical breaking migrations through 0.44.0

HTTP observability now completes inside the framework handler instead of a
nested fetch wrapper. Configure request and tool sinks explicitly:

```ts
// before
const audit = createAuditHook({ write })
createServer({
  services,
  wrapFetch: (handler) => wrapInRequestContext(audit.http(handler)),
})
mountAgent(services, { hooks: audit.toolCall })

// after
const observability = createObservability({
  request: { write, includePayload: true },
  tools: { write },
})
createServer({ services, observability: observability.request })
mountAgent(services, { hooks: observability.toolCall })
```

Body capture changed from always-on for body methods to opt-in. Set
`includePayload: true` only when the request sink needs the sanitized JSON body.
There is no `createAuditHook` or `audit.http` compatibility path;
`wrapInRequestContext` remains only for custom fetch pipelines.

Tool introspection now accepts one object-shaped contract/runtime surface. Stop
calling the internal contract collector or merging a locally converted runtime
manifest:

```ts
// before
buildToolManifest(services.flatMap((service) => collectTools(service, 'AGENT')))
listToolNames(services)
summarizeTransports(services)

// after
const surface = { services, runtimeTools }
buildToolManifest({ ...surface, transport: 'AGENT' })
listToolNames(surface)
summarizeTransports(surface)
```

`ToolNameEntry` adds `kind: 'contract' | 'runtime'`. `TransportSummary` is now
`{ contractServices, runtimeTools, totals, sources }`; replace `services` and
`perService` reads with the explicit counts and mixed-source breakdown. There
is no positional overload and no `buildRuntimeToolManifest`: Stitchkit owns the
combined order, transport filtering, canonical presentation schema and
cross-origin collision checks.

`defineErrors` now uses one Zod-first definition object and returns constructors
instead of positional throwers. Add explicit `throw`, move message/details/hint
into one options object, and declare a details schema when that code carries
structured context:

```ts
// before
const { errors } = defineErrors({ QUOTA_EXCEEDED: 429 })
errors.QUOTA_EXCEEDED('Try later', { retryAfterSeconds: 30 }, 'Wait')

// after
const { errors, definitions } = defineErrors({
  QUOTA_EXCEEDED: {
    status: 429,
    details: z.object({ retryAfterSeconds: z.number().positive() }),
  },
})
throw errors.QUOTA_EXCEEDED({
  message: 'Try later',
  details: { retryAfterSeconds: 30 },
  hint: 'Wait',
})
```

There is no positional overload. A code without `details` forbids them; use an
optional object schema when the details object itself is optional. Read status
and schemas from the frozen `definitions` registry instead of maintaining a
parallel map.

Managed MCP runtime tools are now declared as immutable data. Move protected
registrar calls to `runtimeTools`; rename deliberate raw SDK registration to
`rawTools`. There is no registrar alias:

```ts
// before — protected
createMcpHandler({
  services,
  nativeTools: ({ registerTool }) => registerTool(preview),
})

// after — protected and prepared with the rest of the surface
createMcpHandler({ services, runtimeTools: [preview] })

// before — deliberate raw SDK opt-out
nativeTools: ({ rawServer }, auth) => mountRaw(rawServer, auth)

// after — still a deliberate raw SDK opt-out
rawTools: (server, auth) => mountRaw(server, auth)
```

When identity selects from a bounded set, replace a repeatedly prepared
`services(auth)` factory with a finite registry:

```ts
createMcpHandler({
  surfaces: {
    admin: { services: allServices, runtimeTools: [preview] },
    member: { services: memberServices, runtimeTools: [preview] },
  },
  selectSurface: (auth) => auth.isAdmin ? 'admin' : 'member',
})
```

Keep direct `services(auth)` / `runtimeTools(auth)` only for genuinely
unbounded definitions; Stitchkit intentionally does not cache arbitrary auth
values.

Contract success bodies are now determined by the presence of `output`, not by
the handler's runtime value. A nullable output returns JSON `null` with status
`200`; `undefined` with a declared output and non-null data without an output
schema are contract violations:

```ts
// nullable JSON data: 200 with body `null`
session: {
  method: 'GET', path: '/session', desc: 'Current session',
  output: SessionSchema.nullable(),
}

// bodyless operation: 204 with no body
logout: {
  method: 'POST', path: '/logout', desc: 'End the session',
}
```

Add an output schema to every handler that returns data. Omit `output` and
return nothing for bodyless operations; runtime tools follow the same rule and
type no-output handlers as `void`.

`createToolInvoker` now separates immutable registry preparation from per-call
runtime state. Move source/context/lifecycle/hooks/output-strip reporting from
the factory config to the third invocation argument. Use `invokeOrThrow` when a
nested operation should preserve the normalized `AppError` instead of returning
a model-facing failure envelope:

```ts
// before
const invoker = createToolInvoker(services, {
  transport: 'AGENT', context: { identity }, lifecycle, hooks,
})
const result = await invoker.invoke(name, args)

// after
const invoker = createToolInvoker(services, { transport: 'AGENT' })
const result = await invoker.invoke(name, args, {
  context: { identity }, lifecycle, hooks,
})
const data = await invoker.invokeOrThrow(name, args, {
  context: { identity }, lifecycle, hooks,
})
```

There is no static runtime-config overload: request identity must not be retained
by a reusable compiled registry.

Entity cache handlers now require the cached list shape and CRUD policies. Move
`listKey` under `list`, make detail keys event-aware, and state the list-item
identity/projection explicitly:

```ts
// before
createEntityCacheHandlers<Entity>({
  getId,
  listKey: ['entities'],
  detailKey: (id) => ['entities', id],
})

// after
createEntityCacheHandlers<Entity, EntityListItem>({
  getId,
  getListItemId: (item) => item.id,
  toListItem: (entity) => ({ id: entity.id, name: entity.name }),
  list: {
    key: ['entities'],
    shape: 'paginated',
    createAt: 'start',
    updateMissing: 'skip',
  },
  detailKey: (event) => ['entities', event.id],
})
```

Choose `array`, `paginated`, `infinite-array` or `infinite-paginated` to match
the actual cached data. A dynamic `list.key` / `detailKey` receives a
discriminated event and can derive scoped keys from the created/updated entity
or deleted payload. Add `compare` only when the backend has a canonical order;
the framework does not guess it or mutate pagination metadata.

Protected native MCP operations now use the transport-neutral runtime tool
definition. Return the schema-owned value from the handler and move MCP content
or metadata into `present.mcp`; `structuredContent` and `isError` are
framework-owned:

```ts
// before
registerTool({ input, output, handler: async () => ({
  content: [{ type: 'image', data, mimeType: 'image/png' }],
  structuredContent: { assetId },
}) })

// after
const preview = defineRuntimeTool({
  name: 'render_preview', description, identity, input, output,
  handler: async () => ({ assetId, data }),
  present: {
    mcp: (result) => ({
      content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
    }),
  },
})
runtimeTools: [preview]
```

The removed `NativeMcp*` types have no aliases. Use `RuntimeToolDefinition`,
`RuntimeToolIdentity`, `RuntimeToolHandlerContext` and
`RuntimeMcpPresentation`. The same definition can now be passed to
`mountAgent(services, { runtimeTools: [preview] })`; add `present.agent` only
when the model needs rich text/file content instead of the neutral JSON result.

Trailing wildcards must be named consistently across the path and params schema:

```ts
// before
path: '/app/:slug/*'
params: z.object({ slug: z.string(), '*': z.string() })
ctx.params['*']
api.app({ slug: 'foo', '*': 'a/b' })

// after
path: '/app/:slug/*filePath'
params: z.object({ slug: z.string(), filePath: z.string() })
ctx.params.filePath
api.app({ slug: 'foo', filePath: 'a/b' })
```

Bare wildcards have no compatibility alias; raw routes use the same named form.

### Expected-401 matchers

`HttpClientConfig.authEndpoints` is removed. Replace manual path prefixes with
the operations whose 401 response is expected:

```ts
// before
createHttpClient({ baseUrl, authEndpoints: ['/api/auth/'] })

// after
createHttpClient({
  baseUrl,
  suppressUnauthorizedFor: contractEndpointMatchers(authContract, ['login', 'verify']),
})
```

There is no implicit `/auth/` suppression. Omit `suppressUnauthorizedFor` when
every 401 should emit the global `unauthorized` event.

## The 0.37 migration

Tool presentation is no longer an executable Zod parser. Replace the removed
flatten helpers with the JSON Schema compiler, and choose the explicit
`MountableTool` surface when using the advanced collection API:

```ts
// before
const flat = flattenUnionsDeep(zodSchema)
mountable.schema

// after
const flat = flattenToolJsonSchema(
  z.toJSONSchema(zodSchema, { target: 'draft-07', io: 'input' }),
)
mountable.presentationSchema // model/MCP/manifest JSON Schema
mountable.argumentSchema     // executable CLI argument adapter only
```

Contract and native handlers keep their original Zod schemas; MCP and agent SDK
adapters now forward raw arguments so defaults, coercions, refinements and
transforms execute exactly once inside Stitchkit. There are no compatibility
exports for `flattenDiscriminatedUnion`, `flattenUnionsDeep` or
`MountableTool.schema`. → ADR 0050

Tool-call hooks now take one options object. Migrate all three callbacks; there
are no positional overloads:

```ts
// before
beforeToolCall: (toolName, args, context, endpoint) => {}
afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => {}
onToolError: (toolName, error, context, endpoint) => {}

// after
beforeToolCall: ({ toolName, args, context, endpoint }) => {}
afterToolCall: ({ toolName, args, result, durationMs, context, endpoint, error }) => {}
onToolError: ({ toolName, error, context, endpoint }) => {}
```

### MCP schema validation

The standalone validator now takes one object and live MCP configs carry the
same rules under `schemaValidation`. Migrate every positional call and every
`onIncompatibleSchema` field; there is no old-shape overload:

```ts
// before
validateMcpSchemas(services, 'throw', logger, { requireTypedProperties: true })
createMcpHandler({ services, onIncompatibleSchema: 'throw' })

// after
validateMcpSchemas({ services, policy: 'throw', logger, requireTypedProperties: true })
createMcpHandler({ services, schemaValidation: { policy: 'throw' } })
```

Put `extend` and `flattenUnionInput` beside `services`, not inside
`schemaValidation`. The handler applies the profile to the exact prepared schema
it advertises. Add `requirePortableFormats: true` when every custom JSON Schema
format must be rejected before a client sees it.

Native MCP registration also changed shape in 0.37. Move protected tools to the
framework registrar; keep an SDK-raw tool only by naming the opt-out:

```ts
// before
nativeTools: (server, auth) => server.registerTool(name, config, handler)

// after — lifecycle, hooks and schema policy apply
nativeTools: ({ registerTool }, auth) => registerTool({
  name, description, identity, input, output, handler,
})

// after — intentionally raw
nativeTools: ({ rawServer }, auth) => rawServer.registerTool(name, config, handler)
```

If a tool hook annotated `endpoint` as `MethodDef`, remove that annotation or
use `OperationIdentity`: native operations have service/action/scope/method but
no HTTP path.

### Node-facing server types

`stitchkit/server` remains Bun-concrete: an explicitly annotated `RawRoute`
still receives `BunServer`. `stitchkit/node` no longer drags Bun declarations
into a Node project. Its raw routes default the host server to `unknown`, and
its Socket.IO handle exposes only Node capabilities:

```ts
// before — Node entry still leaked Bun-only fields and ambient types
const route: RawRoute = { handler: (_req, ctx) => ctx.server?.upgrade(...) }
const socket = await createSocketIOServer(config)
socket.websocket

// after — name a custom embedding host only when one exists
const route: RawRoute<MyHostServer> = {
  handler: (_req, ctx) => useHost(ctx.server),
}
const socket = await createSocketIOServer(config)
socket.io
socket.attach(nodeHttpServer)
```

Node consumers can remove `@types/bun` unless another dependency independently
requires it.

### Managed server shutdown

`createServer()` and `serveNode()` now return the same structural managed
lifecycle. Replace every direct runtime stop and parallel Socket.IO close:

```ts
// before — split ownership
const socket = await createSocketIOServer(config)
const server = createServer({
  services,
  websocket: socket.websocket,
  rawRoutes: [socket.route],
})
server.stop()
await socket.io.close()

// after — one owner and one total deadline
const socket = await createSocketIOServer(config)
const server = createServer({ services, socket })
const result = await server.shutdown({ gracePeriodMs: 30_000 })
```

On Node, keep the same `socket` field and replace `handle.close()` with
`handle.shutdown()`. Runtime-specific diagnostics move under `handle.runtime`;
do not use it as a second shutdown path. Standalone CLI/tools that create a
Socket.IO handle without an HTTP server call `await socket.close()`.

If Bun Socket.IO shares the port with a raw lane, keep the explicit composition
but let the server mount the Socket.IO route:

```ts
createServer({
  services,
  socket,
  websocket: composeWebSocketHandlers([
    webSocketLane({ match: isRaw, handlers: rawHandlers }),
    socketIoLane(socket.websocket),
  ]),
  rawRoutes: [rawUpgradeRoute],
})
```

Move native Bun `routes` entries to `rawRoutes`. Native routes run before the
Fetch handler and therefore cannot participate in admission or drain. Wire
`SIGTERM`/`SIGINT` in the application; the first signal starts `shutdown()`, and
a later signal may abort the same controller. Close MCP, databases and queues
after the server result—those resources remain application-owned.

Move a handshake policy from the Node-only callback shape inside
`serverOptions` to the runtime-neutral top-level policy. It receives a Web
`Request`, may be async, and returns whether to admit the handshake:

```ts
// before
serverOptions: { allowRequest: (request, done) => done(null, allowed(request)) }

// after
allowRequest: (request) => allowed(request)
```

## Your handlers may be returning more than the contract declares

stitchkit validates every handler's return value against the endpoint's `output`
schema and **passes on the parsed result** — so any field the schema does not
declare is silently removed. That is deliberate (the contract is the published
shape of the response), but when you are moving a *live* API onto stitchkit it is
invisible: TypeScript does not reject excess properties, nothing logs it, and the
client just receives fewer fields.

While migrating, turn the diagnostic on:

```ts
createServer({ services, warnOnOutputStrip: true })   // off by default
```

Every removed key is logged as a dot-path with the endpoint that produced it
(`notes.get: secret, nested.alsoSecret`). Tool transports strip identically —
`mountMcp` / `mountAgent` take `onOutputStrip: (toolName, paths) => …`. Read the
list, then either widen the contract or stop returning the field, and turn the
flag back off: it is for the migration window, not for production.

## Tool names may shift between versions

Derived tool names are part of your public surface — an MCP client config or an
agent prompt refers to them by string. Before and after any upgrade that touches
name derivation, diff them mechanically:

```ts
import { listToolNames } from 'stitchkit/tools'
console.log(JSON.stringify(listToolNames({ services, runtimeTools }), null, 2))
```

`listToolNames` never throws on an illegal name — that is deliberate, so it can
show you the offending row when a mount would refuse it. Pin it in a snapshot
test and a shift fails your build instead of your clients.

## When you author a breaking change in stitchkit

You are on the other side of this flow — see
[`AGENTS.md` → Breaking changes & migration](../../AGENTS.md). In short: it is
allowed; write the `### ⚠️ Breaking changes` block with a before → after snippet,
bump the minor (pre-1.0), and migrate the controlled consumers in the same pass.

### Where the migration section goes while the version has no number

Write it here, immediately under the flow above, as
**`## Unreleased migration: <short slug>`**. The slug matters: several unreleased
migrations may sit side by side, and each one belongs to whoever wrote it. Do
**not** reuse an existing `Unreleased migration` heading for a different change —
that is how the 0.57.0 migration was lost, overwritten by the next author before
anyone promoted it.

At release, the release commit promotes every `Unreleased migration` heading into
one `## Released migration: X.Y.Z`, each former heading becoming a `###`
subsection under it. This is the same move the changelog makes when `[Unreleased]`
becomes `## [X.Y.Z]`, and it happens in the same commit.

A release carrying `### ⚠️ Breaking changes` and no matching
`## Released migration: X.Y.Z` is refused by `bun scripts/release-plan.ts` — in
`pre-push` and again in the publishing workflow. The check starts at `0.44.0`;
breaking versions older than that are covered by the summary sections near the
end of this file.
