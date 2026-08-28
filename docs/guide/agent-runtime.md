---
title: "Agent application runtime"
description: Configure Stitchkit's optional durable history, stream loop, run coordination and managed-tool fencing.
type: architecture
status: active
created: 2026-08-22
updated: 2026-08-22
---

# Agent application runtime

> **Maturity: evolving.** This surface is still finding its shape and may be
> redefined in any minor release — always with a `### ⚠️ Breaking changes` entry
> and a migration section, never silently. If your application already owns the
> conversation loop, `mountAgent` from `stitchkit/tools` is the stable path.

`stitchkit/agent-runtime` is the server-only, opinionated layer above
`mountAgent`. Use it when the application wants Stitchkit to own conversation
mechanics: durable acceptance, history projection, the AI SDK stream loop,
checkpoints, keyed interruption, terminal commit and stable application events.

If the application already owns that loop, continue importing `mountAgent` from
`stitchkit/tools`. `stitchkit/tools` does not depend on this entrypoint at all;
this entrypoint uses the tool executor from it, but pulls no MCP peer, so
choosing `mountAgent` alone costs you nothing from here.

UI and shared DTO code must import canonical records and delivery validation from
`stitchkit/agent-runtime/browser`, not from the server runtime barrel:

```ts
import {
  AgentRunSchema,
  AgentRuntimeEventSchema,
  advanceAgentRuntimeEventCursor,
} from 'stitchkit/agent-runtime/browser'
```

This browser-safe entrypoint re-exports the same schemas and inferred types used
by the runtime. It intentionally excludes model construction, execution,
persistence, event sinks and every Node context dependency.

## Install

```sh
bun add stitchkit ai zod
```

`mountAgent` from `stitchkit/tools` — used in the composition below — additionally
needs the MCP peer, which that entrypoint imports statically:

```sh
bun add @modelcontextprotocol/server
```

OpenRouter is isolated so other runtime users do not resolve its package:

```sh
bun add @openrouter/ai-sdk-provider
```

## Minimal composition

```ts
import { z } from 'zod'
import {
  AgentContextOverflowError,
  composeAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  defineModelRegistry,
} from 'stitchkit/agent-runtime'
import { openRouterProvider } from 'stitchkit/agent-runtime/openrouter'
import { composeToolLifecycle, mountAgent } from 'stitchkit/tools'

const protocol = defineAgentProtocol({
  context: z.object({ userId: z.string() }),
  inputMetadata: z.object({}),
})

const models = defineModelRegistry({
  providers: {
    openrouter: openRouterProvider({ apiKey: env.OPENROUTER_API_KEY }),
  },
  models: {
    fast: {
      provider: 'openrouter',
      modelId: 'provider/model',
      contextWindow: 128_000,
      capabilities: ['tools'],
    },
  },
})

const prompt = composeAgentPrompt<{ userId: string }>([
  {
    name: 'product',
    stability: 'stable',
    render: ({ context }) => `Help user ${context.userId}.`,
  },
])

const runtime = createAgentRuntime({
  protocol,
  store: createMemoryAgentRuntimeStore(),
  models: {
    preflight: () => models.preflight('fast', ['tools']),
    resolve: () => models.resolve('fast', ['tools']),
  },
  prompt: ({ context, signal, model }) =>
    prompt({
      context,
      signal,
      budget: {
        contextWindow: model.descriptor.contextWindow,
        reservedOutput: 8_000,
        toolSchemas: { provenance: 'unavailable' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { provenance: 'unavailable' },
      },
    }),
  tools: ({ context, toolFenceLifecycle }) =>
    mountAgent(service, {
      context,
      lifecycle: composeToolLifecycle(authLifecycle, toolFenceLifecycle),
    }),
  runs: { inputPolicy: 'interrupt', coalescePending: true },
  loop: {
    idleTimeoutMs: 60_000,
    prepareStep: ({ context, steps }) => ({
      activeTools: steps.some((step) => step.toolCalls.length > 0)
        ? ['lookup']
        : ['lookup', 'discover'],
      instructions: `Current account: ${context.userId}`,
    }),
    stopPolicies: [
      {
        name: 'repeated-tool-error',
        when: ({ steps }) => hasRepeatedToolError(steps),
      },
    ],
  },
})

const ticket = runtime.submit({
  conversationId: 'conversation-id',
  idempotencyKey: 'request-id',
  context: { userId: 'user-id' },
  parts: [{ type: 'text', text: 'Hello' }],
  recordIds: {
    inputMessageId: 'user-message-id',
    runId: 'run-id',
    assistantMessageId: 'assistant-message-id',
  },
})

const admission = await ticket.admission
await ticket.accepted
const terminal = await ticket.result
```

`recordIds` is optional. Supply stable application record IDs when an accepted-response transport must
return durable placeholders before the run finishes. `ticket.admission` resolves after the store
acceptance CAS and reports the canonical committed `input`, assigned `run`, a typed `pending`
assistant projection, compatibility IDs and snapshot version.
Those assigned IDs can differ from the proposal when an input coalesces into an existing queued
successor. Reuse the same `inputMessageId` for retries carrying the same idempotency key; input
identity is caller-stable, while the receipt reports the run/assistant identities that assignment
may change. Await `admission` first on the immediate accepted-response path. `ticket.accepted`
remains the signal-only compatibility surface and additionally waits for admission publication.

The in-memory store is a reference adapter and has process-local durability
only. Production applications normally call `createAgentRuntimeStore()` and
provide one database transaction driver:

```ts
const store = createAgentRuntimeStore({
  transaction: work => db.transaction(tx => work(tx)),
  head: {
    load: (tx, conversationId) => loadRuntimeHead(tx, conversationId),
    compareAndSwap: (tx, operation) => casRuntimeHead(tx, operation),
  },
  runs: {
    load: (tx, identity) => loadRun(tx, identity),
    loadByAssistantMessageId: (tx, identity) => loadRunByAssistant(tx, identity),
    loadMany: (tx, identities) => loadRuns(tx, identities),
    listActive: (tx, conversationId) => listActiveRuns(tx, conversationId),
    save: (tx, record) => saveRun(tx, record),
  },
  admissions: {
    load: (tx, identity) => loadAdmission(tx, identity),
    loadByInputMessageId: (tx, identity) => loadAdmissionByInput(tx, identity),
    create: (tx, receipt) => createAdmission(tx, receipt),
  },
  history: {
    load: (tx, conversationId) => loadCanonicalMessages(tx, conversationId),
    apply: (tx, mutation) => applyCanonicalHistoryMutation(tx, mutation),
  },
  scanRecoverable: page => scanRecoverableRuns(page),
})
```

Prompt budgeting keeps reservation deficits signed. If instructions,
`reservedOutput`, tool schemas, attachments and provider overhead already exceed
`contextWindow`, `composeAgentPrompt` returns `contextDecision: 'oversized'`
and a negative `availableHistoryTokens` even when history is empty. A `compact`
policy is returned only when removing history could actually make the prompt
fit. Exact equality (including a zero window with zero reservations/history)
fits; any unavailable component keeps the decision `unavailable`.

The same opaque `tx` reaches head, run, admission and history callbacks. The adapter maps rows
and supplies atomicity; Stitchkit owns transition validation and revision
arithmetic. The executable reference is
[`examples/agent-store-prisma/adapter.ts`](../../examples/agent-store-prisma/adapter.ts).
`compareAndSwap` returns either `{ outcome: 'applied' }` or
`{ outcome: 'conflict', actualVersion }`. The head contains only schema version,
conversation identity and monotonic version. Runs and admission receipts are normalized records;
recovery queries active run states directly instead of maintaining a second projection.
An admission receipt retains its canonical input, and a terminal run retains its canonical
assistant, so physical product-history compaction cannot break idempotent retries.

## Durable order

`acceptInputAndAssignRun` is one atomic operation. It is followed by ownership
acquisition, revision-checked assistant checkpoints and one terminal CAS. The
process-local coordinator releases its lane only after terminal commit.

A queued admission is durable immediately, even if its predecessor is still awaiting ownership
or its first checkpoint. Snapshots expose causal turn order rather than physical append order:
the predecessor's assigned input(s) and assistant come before the successor input(s). Execution
uses the same run boundary, so neither `prompt({ snapshot })` nor default/custom history
projection can see inputs assigned to a later run. `inject` remains the explicit path that moves
a successor input into the run already in flight.

```text
input + queued run → running → execution settled → terminal CAS → successor
```

## What happens to a run when new input arrives

`runs.inputPolicy` decides. It takes five values, or a function returning one:

| policy | the run in flight | what it already produced |
|--------|-------------------|--------------------------|
| `queue` (default) | finishes first | kept |
| `inject` | continues, and answers the new input too | kept, and built on |
| `interrupt` | ends | kept, and marked as cut off |
| `interrupt-next` | ends; this input runs before ordinary queued work | kept, and marked as cut off |
| `supersede` | ends | discarded from the prompt, kept in the record |

`interrupt-next` is the explicit priority path for an urgent input. If A is
running, ordinary B is queued, and urgent C arrives, the coordinator aborts A,
waits for A to settle and then runs C before B. B keeps its durable identity and
eventually runs. Urgent inputs remain FIFO among themselves. They do not
coalesce into an ordinary pending run: that would erase the priority boundary.

`interrupt` and `supersede` differ in exactly one thing, and the question that
picks between them is **not** "was the run interrupted" but **"did anyone see
what it produced"**:

- The user pressed **stop**. The partial answer was streamed to their screen and
  they read it. It belongs in the conversation — dropping it makes the history
  lie to the model about what the human has seen. That is `interrupt`.
- A newer message **superseded** the run. Whether the partial reached anyone
  depends on the delivery surface: a token stream shows it as it is produced, a
  surface that sends nothing until the run is done never showed it at all. When
  it reached nobody, it is not part of the conversation. That is `supersede`.

**Stitchkit cannot answer that question for you** — delivery belongs to the
transport, and the runtime sees an abort, not a screen. Hence a declared policy
(→ ADR 0108), and hence `inputPolicy` accepting a function, so one application
can hold two surfaces with different rules without the core learning which is
which:

```ts
runs: {
  inputPolicy: (input) =>
    protocol.parseContext(input.context).surface === 'operator' ? 'queue' : 'supersede',
}
```

`input.context` is the **raw** context here — admission runs before the runtime
parses it, so the callback narrows it itself with the protocol it already has.

A superseded run ends with `terminalReason: 'superseded'`, run state
`'superseded'` and an assistant message of status `'superseded'`. **The record
is kept** — excluded from the projection, not deleted — so an operator can see
what was thrown away, and run identity, admission receipts and the terminal CAS
keep the row they depend on. Compaction leaves it alone for the same reason: a
turn whose answer is never spoken is not a turn that may be summarised into one,
because that would both feed the discarded text to the summariser and drop the
record in `replacedMessageIds`.

It is also outside the token budget. `selectAgentHistory` removes it with reason
`'superseded'` and does not count it, so an abandoned fragment cannot push a
real turn out of a context it never occupies.

### How an interrupted turn reaches the model

An interrupted turn is projected, and says so:

```text
{ role: 'assistant', content: [
    { type: 'text', text: 'We are the team, where would you like' },
    { type: 'text', text: '[interrupted: this turn was cut off before it finished]' },
]}
```

`history.interruptedAssistant` chooses the form, and the difference between the
first two is structural rather than cosmetic. **An assistant turn in provider
history is a commitment**: the model reads its own previous turn as something it
said and stays consistent with it. A system line is context.

| value | form | right when |
|-------|------|-----------|
| `assistant-marked` (default) | assistant turn plus a marker | the human read the text |
| `system-note` | `[interrupted] partial response: …` as a system line | the fragment reached nobody |
| `omit` | not projected at all | you want it gone from the request |

There is deliberately no value that reproduces what the projection used to do,
which was to send the partial as an ordinary assistant turn and drop its
`control` marker on the way. That was the defect, not a behaviour to stay
compatible with.

`projectAgentHistoryDetailed` reports what reached the provider, including part
types that no projected content stands for:

```ts
const { decisions } = await projectAgentHistoryDetailed(snapshot.messages)
// → { messageId: 'assistant-2', action: 'projected', reason: 'projected',
//      omittedParts: ['source', 'provider'] }
// → { messageId: 'assistant-1', action: 'omitted', reason: 'superseded' }
```

`runtime.stop(key, 'supersede')` is the same decision taken by hand: the
process-local escape hatch chooses the reason, so a caller that knows the answer
was never delivered can discard it without a newer input arriving.

### An input that joins a run in flight

`inject` is right when the new input **refines** rather than redirects, and the
steps already taken are still worth something: *"summarise this thread… actually,
in bullet points"* should not throw away the reading the first message paid for.

What happens:

1. The input is admitted exactly like any other — a committed user message and a
   **queued run**, durable before anything else happens.
2. At the running loop's next step boundary, that input joins its prompt. Only
   that input: an unrelated queued submission is never carried in.
3. When the run finishes, its terminal commit — **one transaction** — records
   the input as one the run answered and settles the queued successor with
   `terminalReason: 'absorbed'` and `absorbedIntoRunId` naming the run that
   answered it. Every ticket for that successor resolves to the same answer.

Nothing durable happens between 1 and 3, and that is the design (→ ADR 0113).
A run that crashes, is closed, or is interrupted after taking an input on
commits no absorption at all, so what is left behind is an ordinary queued
successor — the state every other policy already produces and recovery already
handles. **There is no ordering in which an accepted input becomes
unanswerable.** Only a run that *completes* may absorb; an interrupted one took
the input into its prompt and then stopped, and does not get to say it answered
it.

An absorbed run has **no assistant message of its own** — it produced none, and
writing an empty one would be a record claiming otherwise. Its answer is
reachable through `absorbedIntoRunId`, and the store follows that pointer itself
when a submission arrives on the absorbed run's idempotency key, so a retry
after a restart returns the answer rather than an empty terminal record.

It does publish one more `run-state` event, carrying `'superseded'`. It never
enters the run executor, so that event is the only thing that tells a delivery
surface following its `runId` that it is no longer queued.

With `coalescePending`, one successor can carry several inputs, and an
absorption covers a successor **whole or not at all** — a partial one would
leave a terminal run with inputs nobody answered. Inputs that coalesce before
the absorbing run's last step boundary join the same absorption. One that
arrives after it cancels the absorption: the successor then answers all of its
inputs itself, and the absorbing run has answered one of them too. A duplicate
answer, never a missing one.

(0.63.0 shipped a version of this that committed the absorption at the step
boundary, before the answer existed, and it was withdrawn in 0.65.0. ADR 0113
records what that ordering broke.)

With `runs.coalescePending: true`, an active lane has at most one queued
successor. Every later accepted input is atomically appended to that successor;
its `AgentRun.inputMessageIds` records the whole batch and every input ticket
resolves to the same terminal run. Coalescing never mutates the active run.

`AbortSignal.aborted` is only a cooperation request. A successor does not begin
while the predecessor still owns managed callbacks. A hung predecessor blocks
the lane in the first version.

Shutdown is two-phase, and both budgets carry the names they carry everywhere
else in Stitchkit:

```ts
const closed = await runtime.close({ gracePeriodMs: 30_000, forceTimeoutMs: 5_000 })
if (!closed.settled) {
  console.warn(`exiting with ${closed.remaining} run(s) still in flight`)
}
```

`close` first rejects new process-local admissions and gives active runs
`gracePeriodMs` to finish on their own. Only after that budget expires does it
abort them with reason `shutdown`; `forceTimeoutMs` then bounds the settlement
wait for a non-cooperative model or tool, measured from the abort — the two
budgets add up rather than overlapping.

**`close()` reports what it achieved rather than promising an outcome it cannot
reach.** The result is `{ settled, timedOut, remaining }`: `settled` when every
in-flight run finished, `timedOut` with a `remaining` count when the force
budget expired first. There is no combination of budgets that is both bounded
and guaranteed to leave nothing in flight — that is the trade the budgets exist
to make, and the result is where you read which side of it you got:

| budgets | behaviour | can return with a run in flight |
|---------|-----------|---------------------------------|
| neither | aborts immediately, waits for settlement | no — unbounded wait |
| `gracePeriodMs` only | waits, aborts, then waits for settlement | no — unbounded wait |
| `forceTimeoutMs` only | aborts immediately, waits at most that long | **yes** — `timedOut` |
| both | waits, aborts, waits at most that long | **yes** — `timedOut` |

A caller that wants the old shape still writes `await runtime.close(…)` and
ignores the result. A caller deciding whether to exit the process reads it.
Durably queued records rejected from the local queue remain recoverable through
`scanRecoverable`; close never marks them terminal on its own.

Use `await runtime.interrupt({ conversationId, runId })` when the interruption
must be durable: it first commits `interrupt_requested`, then aborts the local
coordinator signal. If provider completion races that revision change, the terminal path reloads
the canonical snapshot. An already-terminal winner settles the ticket directly; a still-owned
`interrupt_requested` run is committed as `interrupted`, and unrelated aggregate-head conflicts
remain retriable while the run is active with the same owner and fencing token. A stale owner or
fencing token remains a conflict. Only the execution that applies the terminal mutation publishes the
**delivery** `terminal` event — a loser settles from canonical state without republishing the turn,
and its `AgentRuntimeResult.metrics` is `undefined`. The **operator** `run-terminal` event is not
gated that way: a losing execution still ran, and still spent whatever it spent, so it reports its
own usage. The two channels answer to different readers — delivering a turn twice is a user's
problem, and omitting a run's cost is an operator's.
`runtime.stop(key)` is the process-local signal-only escape hatch.

## Store operations

`AgentRuntimeStore` remains the runtime-facing aggregate. Application adapters
implement the smaller `AgentRuntimeStoreDriver` rather than these eleven members:

- `acceptInputAndAssignRun`
- `acquireRun`
- `checkpointRunAssistant`
- `requestRunInterrupt`
- `recoverRun`
- `commitRunTerminal`
- `replaceCompactedRange`
- `loadSnapshot` — the whole conversation; see **Reading a conversation** below
- `loadRun` — one run by id, with the answer it produced if it has ended
- `listActiveRuns` — the runs of one conversation that have not ended
- `scanRecoverable` — one **bounded page** of recoverable runs; `recover()`
  calls this and nothing else, so an adapter that implements the interface has
  everything recovery needs

### Reading a conversation

Two shapes of read, and the difference matters as a conversation grows.

**Bounded.** `loadRun` and `listActiveRuns` read run records and the
conversation head. Neither touches history, so neither grows with the length of
the conversation. `loadRun` is how you resolve the `runId` that
`submit().admission` hands back — it returns the run, the version it was read
at, and, once the run is terminal, the answer it produced.

**Unbounded.** `loadSnapshot` returns every message and every run, and so does
every mutation result: the store's reducer validates its invariants against the
whole conversation, and the runtime builds the next prompt from the snapshot the
mutation returns. Ask for it when you need the conversation — composing a
prompt, or compacting — and not to look one run up.

So the cost of a run scales with the length of its conversation, not with the
length of the turn. **Configure compaction** (see below) for anything
long-running: it is the only thing in the framework that makes a conversation
smaller, and without it a year-old assistant thread is read in full on every
turn. This is a known limit, held deliberately rather than by omission — paged
history would have to change what a snapshot *is*, and the store's invariants
with it, and that is a decision on its own (→ ADR 0112).

Every mutation carries an expected run revision or snapshot version. Input
assignment additionally carries an idempotency identity. A conflict is a
control outcome; stale data is never silently overwritten.

Acquisition increments an optional monotonic `fencingToken`. The managed runtime carries it through
checkpoint/terminal CAS and tool context, so a distributed adapter can reject an old owner even if
an owner label is reused. Lease expiry and renewal remain application-owned.

On startup, `runtime.recover({ resolveContext })` consumes bounded lightweight
pages, then restores each conversation's durable execution order before any run
acquires. Persisted `executionSequence` orders work that started; queued
`interrupt-next` work precedes ordinary queued work with FIFO preserved inside
each class. Scan identifiers, equal timestamps and page boundaries therefore
never become queue order. Its safe default resumes queued runs and reports acquired or
`interrupt_requested` runs as skipped. A policy may requeue acquired work only
with explicit replay-safe evidence, or abandon it only with stale-owner
evidence. Each attempted run returns its own outcome/error; a `resumed` or
`requeued` outcome also exposes the terminal `result` promise. The outcome is
reported only after durable acquisition, so a lost acquisition is `failed`
rather than a successful-looking handoff. `pageSize`, `maxRuns`, and `signal`
bound the pass. `runtime.resume(...)` remains available for one known queued
record; its `accepted` promise likewise means that the recovered run acquired
durable ownership, while `result` carries terminal completion.

Canonical records currently write `schemaVersion: 1`. A durable adapter owns
read-time migration of older rows: migrate to the current shape at its storage
boundary, validate with the exported schema, and write only the current
version. Core deliberately does not guess an application's database migration
or silently accept an unknown future version.

## Events and reconnect

`publish` receives event classes with different guarantees:

- `admission` follows a successful acceptance CAS and carries the same complete
  projection as `ticket.admission`;

- `assistant-delta` is transient and ordered by
  `(runId, runtimeEpoch, sequence)`;
- `reasoning-start`, `reasoning-delta` and `reasoning-end` are transient and
  ordered by the same identity; delta carries only the current text fragment,
  while provider metadata stays inside a validated canonical envelope;
- `assistant-checkpoint` follows a successful checkpoint CAS;
- `run-state` follows durable queue/acquire/interrupt transitions;
- `tool-status` is transient lifecycle presentation with JSON-safe input on
  start and output on completion; internal tool failures remain generic;
- `terminal` follows the winning terminal CAS.

These are post-commit notifications, not a transactional outbox: a process can
crash between the database commit and `publish`. Reconnect should load canonical
state. Exactly-once external delivery remains an application-owned outbox.

Durable event IDs are derived from run, event type and snapshot version. Use
`advanceAgentRuntimeEventCursor` to classify delivery.

**`gap` is reported for transient events only**, where `sequence` is a per-run
counter the runtime really does increment once per event. Durable events carry
the *conversation's* version, which advances on every mutation including the many
that publish nothing — checkpoints, compaction, an acceptance that has not
started — so two consecutive durable events are routinely several versions apart
and adjacency says nothing. A durable loss is not detectable from the cursor;
reload on reconnect, which is what a bounded fire-and-forget sink asks of you
anyway. `createAgentRuntimeEventSink` adds a bounded failure-isolated lifecycle and typed
projection/redaction hook. `onPublishError` records direct publisher failures without changing the
already committed run.

A named custom stop condition terminalizes with `policy_stop`; its `policyName`
is persisted on the run and included in the terminal event/result. `max-steps`
is the reserved built-in policy name. `loop.prepareStep` is the controlled AI
SDK step boundary for changing active tools, model, instructions or messages.
It cannot replace the managed tool set or bypass its lifecycle fence.

Context can grow between steps as tool results and deferred schemas enter the
provider prompt. When application budgeting can prove that the next assembled
step exceeds the selected model window, refuse it by type before that provider
call:

```ts
prepareStep: (step) => {
  if (wouldExceedSelectedModelWindow(step)) {
    throw new AgentContextOverflowError('Prepared step exceeds the selected model window')
  }
  return chooseProductStepOptions(step)
}
```

That deliberate refusal ends the run as `context_overflow` on the durable
record, delivery terminal and operator event. Stitchkit does not inspect error
messages: every other `prepareStep` or provider error remains
`provider_failure`, and operator-only observability retains its original cause.

Completion validity belongs to the protocol and is checked before the terminal
CAS. Protocols that require a visible answer opt in explicitly:

```ts
const protocol = defineAgentProtocol({
  context: ContextSchema,
  inputMetadata: InputMetadataSchema,
  terminalAcceptance: 'require-output',
})
```

The built-in rule accepts non-blank text, generated files, structured provider
parts, and a named tool-only `policy_stop`. The default is `allow-empty` for
protocols where an empty acknowledgement is meaningful. Pass a callback when
the product has a narrower definition; it receives the candidate message,
terminal reason and optional policy name, and runs before persistence. A false
result fails the candidate instead of rewriting an already committed success.

`loop.idleTimeoutMs` is inactivity, not total duration: the deadline resets on
every model stream event. A stalled call aborts with durable reason `timeout`;
user interruption and shutdown remain distinct.

Reconnect loads the durable snapshot. Missing transient deltas do not mean the
canonical result was lost. Exactly-once external delivery requires the
application's transactional outbox or stable-ID deduplication.

## Managed tools

Always compose `toolFenceLifecycle` into `mountAgent`. It checks ownership
before a managed side effect and again before accepting its result. Fence loss
uses an internal control signal: it stops the old loop and is not sent to the
model as a tool error.

The framework cannot undo an already-started non-cooperative external effect.
Pass the stable call/run idempotency identity into business mutations when the
effect must be replay-safe.

## History, provider metadata and files

`projectAgentHistory` converts canonical engine records into provider-valid AI
SDK messages and pairs tool calls/results in persisted causal order. Adjacent
parallel calls stay in one assistant round and their adjacent results stay in
one tool round; a dependent call after those results starts a new assistant
round, and trailing final text remains after the last tool result. Provider-required metadata is kept
in a versioned opaque envelope and omitted from product delivery by default.
`projectAgentHistoryDetailed` additionally returns one inspectable decision per canonical record;
leading assistant records, crash drafts and unmatched tool chronology are never silently passed to
the provider.

`selectAgentHistory` is the non-destructive context-window selector. It removes only whole oldest
complete turns, protects system/summary, incomplete and configured recent turns, and reports every
keep/remove reason with measured/estimated/unavailable token provenance. An oversized protected turn
returns `oversized`; unavailable accounting returns `unavailable` without invented arithmetic.

`ComposedAgentPrompt.instructions` accepts the AI SDK `Instructions` contract.
Use `adaptInstructions` when a provider needs metadata on the system message:

```ts
prompt({
  context,
  signal,
  adaptInstructions: (content) => ({
    role: 'system',
    content,
    providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
  }),
})
```

Attachments and generated files remain application-owned. The runtime only
stores a reference returned by `persistGeneratedFile`; it never silently puts
base64 blobs into the neutral history store.

To send a stored attachment back to a multimodal model, configure
`history.resolveFile`. It maps the neutral file reference to AI SDK file data
(URL, bytes, provider reference or text). Without a resolver the
`unresolvedFile` policy applies, and it is **`omit`** by default: the file part
simply does not reach the provider. Choose `text` for a describing placeholder —
the filename or media type, never the storage reference, because that string is
an address inside your infrastructure and this content travels upstream — or
`error` to fail loudly. The `error` message does name the reference: it is
thrown into your process, where you are owed the whole story.

## Compaction

`structuredCompaction` summarizes complete provider-valid turn groups outside
the store lock, then calls `replaceCompactedRange` against the exact snapshot
version. A concurrent input produces `conflict`; the stale summary is not
applied. Summary records use the dedicated `summary` role and project to a
provider system message. The consumer supplies the structured summary schema
and prompt. Pass `previousSummary` for a direct call, or configure
`readPreviousSummary` for runtime-managed compaction, to merge and atomically
replace a leading summary on the next compaction.
Set `maxAttempts` to allow bounded conflict recovery. Every retry reloads the snapshot, reselects the
eligible range and recomputes the summary; the stale summary is never retried.

## Observability

`createAgentObservability` emits a separate operator-only `AgentRunEvent`. It
reuses the same bounded sink lifecycle as request/tool observability without
sending new event kinds to existing request sinks. Product events omit provider
causes. Operator `internalCause` is also redacted by default; an operator-only sink must explicitly
set `includeInternalCause` and own its retention policy.

### What a run says it spent

Usage values carry `provider-reported`, `computed`, `estimated` or `unavailable`
provenance, **per field**. Cost additionally carries an ISO currency code;
OpenRouter-reported cost is normalized as USD.

Read the provenance before the number (→ ADR 0109):

- **`provider-reported`** — the provider handed us exactly this. On
  `step-finished`, that is what a step's figures are.
- **`computed`** — a total, added up over steps. **Every figure on a terminal
  event is this**, tokens included: the AI SDK's `totalUsage` is a sum it
  performed, not a number a provider reported for the run. It is not a figure to
  bill against unchanged.
- **`unavailable`** — nobody reported it. Not zero.

Two rules follow from that last one, and they differ by field on purpose:

- **A token total with an unreported step is a floor**, labelled `computed`. A
  token count is a diagnostic, and a floor is a useful one.
- **A cost with an unreported step is `unavailable`, not a floor.** Money is what
  people bill against, and "at least $1.00" reported as `$1.00` is the same class
  of lie this whole section exists to remove. One step that did not report its
  cost makes the run's cost unknown — not smaller. It also stays unknown: later
  steps reporting normally cannot revive it.

**A terminal event always carries `usage`.** A run that ended before the provider
reported anything — superseded, interrupted, timed out, shut down, failed —
carries every field `unavailable`. That is deliberately different from a run that
spent nothing, and an omitted object could not tell you which one you had.

Two costs in different currencies do not add: the sum reports `unavailable`
rather than picking a label. The core records a currency and never converts one.

**A run's figure is durable, and that is where to read it when a channel loses
it.** `AgentRun.usage` is written at every checkpoint and again with the terminal
record, so a crashed process leaves behind what it had already spent and a
dropped event is not a lost number:

```ts
const snapshot = await store.loadSnapshot(conversationId)
const spent = snapshot.runs.find((run) => run.id === runId)?.usage
```

Two gaps are open and are stated rather than left to be discovered:

- **Both event sinks are bounded and drop under load**, by arrival order — the
  event carrying the money is exactly as droppable as the one carrying nothing.
  The run record is the recovery, and this paragraph is the only place that says
  so.
- **`AgentRuntimeResult.metrics` is `undefined` when this executor did not win
  the terminal race.** Read `result.run.usage` — the durable figure — rather than
  `result.metrics`, which is the channel that can go missing.
- **Compaction spend is invisible unless you report it.** `config.history.compact`
  calls a model inside the turn and produces no step and no event of its own.
  Return `usage` from `AgentCompactionResult` and it joins the run's figure;
  omit it and the run under-reports by whatever summarising cost.

What stitchkit does **not** keep is a ledger: one figure, on the run that
produced it, never aggregated and never reconciled against a provider invoice
(→ ADR 0110).

### Reconciling with the provider's own accounting

Whether a provider bills for a call that was aborted mid-flight cannot be known
inside the process: the authoritative number arrives later, from the provider's
accounting. **stitchkit does not accept it back** (→ ADR 0110) — a terminal run
is an absorbing state, and a write that reached it through the conversation
aggregate could conflict a concurrent compaction into discarding a summary it had
just paid a model to produce.

The join is yours, and `runId` is the key:

```ts
// when the run terminates — write what the runtime observed
await ledger.record({
  runId: terminal.run.id,
  conversationId: terminal.run.conversationId,
  // The durable figure, not `terminal.metrics` — that one is absent whenever
  // this executor did not win the terminal race.
  costUsd: terminal.run.usage?.cost?.value ?? null,        // null when `unavailable`
  provenance: terminal.run.usage?.cost?.provenance ?? 'unavailable',
})

// later — the provider's accounting names the same generation
await ledger.reconcile({ runId, costUsd: billed, provenance: 'provider-reported' })
```

Record the row even when the figure is `unavailable`: that row is the evidence
that a run happened and cost something nobody has counted yet, and it is what the
provider's later figure attaches to. A run with no row is a run you cannot
reconcile.

The sink deduplicates stable event IDs by default. Cross-crash exactly-once still requires a durable
outbox.

## Deterministic race and adapter proof

`stitchkit/testing` exports `createAgentRaceBarrier`, `createAgentRaceDriver` and
`createAgentRaceTrace`. Barriers have bounded teardown, traces assert exact partial order, and the
helpers are exercised from packed Bun and Node consumers. `runAgentStoreConformance` runs duplicate,
coalescing, collision, stale checkpoint, replay safety, terminal race, absorption, bounded reads,
causal queued-history order, durable interrupt priority, compaction and recovery invariants against
any fresh durable adapter.

It picks its conversation identities itself and passes them to `createStore(context)` **before the
first mutation**, so an adapter whose runtime rows reference an application-owned conversation row
can provision those parents; the optional `cleanup(context)` removes them again, and runs once
whether the scenario passed or failed. A factory that owns no fixture state ignores the argument and
keeps working unchanged.
