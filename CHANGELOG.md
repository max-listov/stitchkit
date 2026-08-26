# Changelog

All notable changes to **stitchkit** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project adheres to [Semantic Versioning](https://semver.org/). Pre-1.0 — the
public API may still change between minor versions.

A release that breaks a public API leads its entry with a **`### ⚠️ Breaking
changes`** section (with before → after migration snippets); a version without
that section is purely additive. To move a project across versions, see
[`docs/guide/upgrading.md`](docs/guide/upgrading.md). **0.1.0–0.7.0 were all
additive**; the first breaking change landed in 0.10.0. Grep the file for
`⚠️ Breaking changes` to find every one.

## [0.66.1] — 2026-08-26

### Added

- **The agent-store conformance kit takes a fixture lifecycle.** It picked its
  conversation identities *after* `createStore()` returned, which locked out
  exactly the adapters it exists to certify: a durable store whose runtime rows
  hang off an application-owned conversation row cannot serve the first
  admission, because nobody ever told it which parent to provision — so such an
  adapter could only be "certified" by running the kit against the memory
  reference store, which proves the reducer rather than the adapter.
  `createStore(context)` now receives an `AgentStoreConformanceContext` naming
  every conversation the scenario will mutate, and an optional
  `cleanup(context)` removes what it provisioned.
  `cleanup` runs **exactly once, after the scenario, whether it passed or
  failed** — a kit that only tears down on success leaks a row per red run — and
  a failure in it never replaces the scenario's own.
  Additive: a zero-argument factory (`createStore: () => yourStore`) stays valid
  with no wrapper.

### Fixed

- **The documented conformance invocation now typechecks.** `docs/guide/upgrading.md`
  showed `runAgentStoreConformance({ store, conversationId })`, a shape the
  released package has never accepted — so the one check the upgrade path tells
  an adapter author to run could not compile against the package documenting it.
  Corrected, and the packed Bun and Node consumer fixtures now compile and run
  the exact documented form, so it cannot drift again quietly.
- **The kit no longer asserts absence against a hardcoded identity.** It probed
  `'no-such-conversation'`; a consumer database may legitimately contain that
  string, and then a conforming adapter failed for a reason unrelated to the
  contract. The absent identity is derived from the run's own generated prefix
  and is deliberately not among `conversationIds`.

## [0.66.0] — 2026-08-26

### ⚠️ Breaking changes

**Who must act:** anyone who implements `AgentRuntimeStore` **by hand** adds two
members — an adapter built on `AgentRuntimeStoreDriver` needs no change at all.
Anyone matching exhaustively on `AgentTerminalReason` adds an `'absorbed'` arm
the compiler will point at.
Anyone reading `provenance` off a prompt budget, or reading
`ComposedAgentPrompt.instructionTokens` / `AgentHistoryBudgetResult.totalTokens`
and matching on `'measured'`. Anyone producing a token count from a callback the
runtime calls — `estimateTokens`, `estimateFallback`, an `AgentPromptBudget`
field — now has it validated.

Migration steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **`inputPolicy: 'inject'` returns, with the ordering that made it wrong
  corrected.** A run in flight takes a newly arrived input into its prompt at a
  step boundary and answers it too — but **nothing durable happens until the run
  settles.** The absorption is a field on `commitRunTerminal` and is applied in
  the same transaction as the terminal record, so a run that crashes, is closed
  or is interrupted after taking an input on leaves an ordinary queued
  successor. There is no ordering in which an accepted input becomes
  unanswerable (→ ADR 0113). The withdrawn 0.63.0 version committed the
  absorption at the boundary, before the answer existed.
  New surface: `AgentTerminalReason` gains `'absorbed'` (state `'superseded'`),
  `AgentRun` gains `absorbedIntoRunId`, and `CommitRunTerminal` gains `absorb`.
  An absorbed run has **no assistant message of its own**; the store follows
  `absorbedIntoRunId` when a submission arrives on its idempotency key, so a
  retry after a restart returns the answer. It publishes one final `run-state`
  event carrying `'superseded'` — it never enters the run executor, so that is
  the only thing telling a delivery surface it is no longer queued.
- **`AgentRuntimeStore` gains `loadRun` and `listActiveRuns`.** `loadSnapshot`
  was its only read, and it returns every message and every run — so the
  runtime loaded whole conversations to answer questions about one record.
  Seven of its eight `loadSnapshot` calls never touched a message, and one of
  them, the fencing check, runs **before every tool call**: twenty tool calls in
  a five-thousand-message conversation read a hundred thousand messages to
  compare two numbers. Both new members read run records and the head only, and
  **neither needs anything new from `AgentRuntimeStoreDriver`** — `runs.load`,
  `runs.listActive` and `head.load` were already there and nothing had asked
  them (→ ADR 0112).
  `loadRun({ conversationId, runId })` also answers what nothing answered
  before: how to resolve the `runId` `submit().admission` hands back.
- **One vocabulary for how a number came to be known.** Two enums in one
  entrypoint described the same kind of fact about the same request in different
  words: `AgentUsageValue` said `provider-reported | computed | estimated |
  unavailable`, `AgentTokenCount` said `measured | estimated | unavailable`, and
  neither accepted the other's terms. The words are now defined once as
  `AgentProvenanceSchema`, and each surface declares the subset it can produce.
  No surface widened — an exhaustive switch still sees exactly what that surface
  emits — but `AgentTokenCount` gains `'computed'`, and a **total is now
  `computed` rather than `measured`**, because it is arithmetic this code
  performed, not a count it took:
  `// before: totalTokens.provenance === 'measured'` →
  `// after: totalTokens.provenance === 'computed'` (unchanged when any part was
  estimated: an estimate survives arithmetic).
  `measured` and `provider-reported` survive as separate words because they are
  separate facts: `measured` is this process counting a string exactly before
  any request; `provider-reported` is the provider stating a figure about a
  request it served. Neither surface can produce the other's.
- **A token count is an integer.** `AgentUsageValue.value` was `z.number()` and
  accepted `3.5`. Both token schemas now use `z.int()`, and the callbacks that
  feed them are validated where they were not: `AgentPromptSection.estimateTokens`,
  `ComposeAgentPromptOptions.estimateFallback` / `.historyTokens`, and the three
  `AgentPromptBudget` counts — plus `contextWindow` and `reservedOutput`, which
  went into the window arithmetic unchecked. `AgentCostValue.value` stays
  fractional, because money is. A **provider** figure that is not a whole number
  normalises to `{ provenance: 'unavailable' }` rather than throwing, so a run
  that already produced its answer is not failed over a number nobody reads
  until the invoice arrives.

### Fixed

- **A terminal commit that can never win no longer spins forever.** The retry
  after a lost compare-and-swap was unbounded, so a store that conflicts while
  still reporting a run this executor may commit became a hot loop that never
  returned and never reported — on the path that persists what a run produced.
  It is bounded at 32 attempts now and refuses with the ordinary terminal-commit
  conflict; every legitimate outcome still ends it in one or two rounds.

### Changed

- **`loadSnapshot`'s cost is written down.** The agent-runtime guide gains a
  *Reading a conversation* section: which reads are bounded, which are not, and
  that compaction is what bounds the one that is not. No behaviour change —
  history is still read whole by `loadSnapshot` and by every mutation, and ADR
  0112 records why paging it is a separate decision.

## [0.65.1] — 2026-08-26

### Fixed

- **`ACTIVE_AGENT_RUN_STATES` is reachable.** 0.65.0 added it and documented it
  as exported "because a driver author needs it" — and left it out of the
  entrypoint, so the one reader it exists for could not import it. Caught by
  probing the published package rather than the source tree, which is the only
  place the difference shows.

## [0.65.0] — 2026-08-26

### ⚠️ Breaking changes

**Who must act:** anyone using `inputPolicy: 'inject'` moves back to `queue` —
it is withdrawn. Anyone reading `AgentRunEvent`/`AgentRunMetrics` fields, or
building `AgentRun` records by hand, adds arms and required fields the compiler
points at. Everyone else re-reads two values and gets a timeout default they did
not have.

Migration steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **A compacted conversation could not run.** `ai` refuses a system-role entry
  inside `messages` — *"System messages are not allowed in the prompt or messages
  fields. Use the instructions option instead."* — and the history projection put
  `system` and `summary` records there. So **every run after a compaction failed
  with `provider_failure`**, and `interruptedAssistant: 'system-note'` did the
  same. Both shipped in 0.62.0 and were live through 0.64.0.

  `AgentHistoryProjectionResult` gains `system: readonly string[]`, and those
  records no longer appear in `messages`. If you pass a projection to a provider
  yourself, pass `system` to the instructions channel:

  ```ts
  // before — rejected by the provider
  streamText({ model, messages: projected.messages })
  // after
  streamText({
    model,
    instructions: projected.system.map((content) => ({ role: 'system', content })),
    messages: projected.messages,
  })
  ```

  The suite was green throughout because the projection tests asserted shape and
  never handed the result to a provider. `agent-runtime-provider-valid.test.ts`
  now does exactly that, including a case pinning the refusal itself.

- **`inputPolicy: 'inject'` is withdrawn**, with `AgentRunState`'s `'absorbed'`,
  `AgentRun.absorbedIntoRunId`, and `AgentRuntimeStore.absorbQueuedRun`. It
  committed the absorption durably before the answer existed, so an accepted
  input could land in a state that was neither active, recoverable nor terminal:
  `close()` reported `settled: true` while leaving it permanently unanswerable,
  and a duplicate submission of the same idempotency key was refused forever.
  Use `queue`; the redesign is tracked in the backlog.

- **`recoverRun` no longer destroys the run's spend and fencing token.** It
  rebuilt the record from a hand-written field list, so the one path that exists
  to recover from a crash deleted `AgentRun.usage` — the figure added in 0.63.0
  to survive exactly that — and reset `fencingToken`, which let a stale owner
  mint the same token again and overwrite a live answer.

- **A run record must agree with itself.** `AgentRunSchema` accepted
  `state: 'completed'` beside `terminalReason: 'interrupted'`, a terminal state
  with no reason, a queued run carrying one, and `policy_stop` with no policy.
  All four are now refused. `runStateForTerminalReason` is exported so a caller
  building a terminal record derives the state instead of guessing it.

- **`AgentRunMetrics.usage` is required**, on the delivery events as it already
  was on the operator one. The invariant was held on one of two channels.

- **`loop.idleTimeoutMs` defaults to 60 000.** There was no default, so a hung
  provider stream held the conversation's lane forever. Pass `null` to disable.

- **`'tool_failure'` is gone and `'context_overflow'` replaces it** in
  `AgentTerminalReason`. `tool_failure` appeared exactly once in the repository —
  its own declaration — and was never produced. `context_overflow` is this
  runtime's own refusal when the prompt does not fit, which used to commit
  `provider_failure` and blame an upstream that was never contacted.

- **`advanceAgentRuntimeEventCursor` no longer reports `gap` for durable
  events.** `snapshotVersion` is the conversation's version and advances on
  mutations that publish nothing, so adjacency reported a gap after essentially
  every run — and the guide says a gap means reload the conversation. `gap` is
  still reported for transient events, where `sequence` is a real per-run
  counter.

- **The token budget stops protecting records the model never hears.** The fix
  shipped in 0.62.0 named `superseded` alone; `interrupted` and `failed` turns
  were still classified as incomplete, which is the one class eviction refuses to
  touch, so every provider failure in a long conversation permanently reserved
  budget. The decision reason `'superseded'` becomes `'unspeakable'`.

- **Compaction may not replace a live run's assistant message.**
  `replaceCompactedRange` allowed it, and the run's next checkpoint then
  re-appended the same message after the summary that claimed to contain it.

### Added

- **`ACTIVE_AGENT_RUN_STATES`** — the run states an active listing and a
  recovery scan consider. Driver authors had to guess and hardcode it; the
  reference adapter repeats the literal three times.
- **The store conformance kit covers what it was certifying blind**: that a
  fencing token round-trips, that a stale token and a foreign owner are both
  refused, that `scanRecoverable` reports a running run, and that a durable
  interrupt neither loses the run's spend nor skips the state change.

### Fixed

- **`scanRecoverable`'s reference cursor no longer restarts at the beginning**
  when the run it names stops being recoverable — which is the normal outcome of
  a recovery pass, since recovering a run is what removes it from the set.
- **A terminal commit racing a durable interrupt keeps the run's spend** and no
  longer carries a `policyName` past the reason change, which had a run ending
  `interrupted` durably naming a stop policy that had not stopped it.

## [0.64.0] — 2026-08-26

### ⚠️ Breaking changes

**Who must act:** an operator sink that reads `AgentRunEvent` fields narrows on
`type` first — a few lines, and the compiler points at every one. An application
that implements `AgentRuntimeStore` directly should move to the driver; nothing
is removed and its tests keep working.

Migration steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **`AgentRunEvent` is a discriminated union by `type`.** It was one flat object
  for `run-started`, `step-finished` and `run-terminal`, with every distinguishing
  field optional — so nothing could say that a step has a step number, that only
  a terminal has a terminal reason, or that a terminal always states what it
  spent. "A terminal event always carries `usage`" was a guarantee the type could
  not express, and the migration snippet published for it did not typecheck.

  ```ts
  // before — every field optional, narrowing impossible
  const spent = event.usage?.cost?.value

  // after — say which kind of event you are holding, and the fields are certain
  if (event.type === 'run-terminal') {
    const spent = event.usage.cost   // present, always; `unavailable` when unknown
  }
  ```

  `AgentRunStartedEventSchema`, `AgentStepFinishedEventSchema` and
  `AgentRunTerminalEventSchema` are exported for narrowing and construction.

- **`AgentRuntimeStore` is no longer a supported implementation target**
  (→ ADR 0111). It stays exported and stays implementable — it is the type of
  `AgentRuntimeConfig.store`, and an in-process double is a fine reason to write
  one. What changes is what its growth means: **adding a member to the aggregate
  is no longer a breaking change.** The supported way to obtain one is
  `createAgentRuntimeStore(driver)`, and the stability promise moves to
  `AgentRuntimeStoreDriver` — six storage primitives rather than nine operations.

  Three members were added in three releases and cost the driver population
  nothing. Announcing them as breaking told adopters they owed three migrations
  when they owed none.

### Added

- **`scripts/surface-cadence.ts`** — derives, from the changelog, how often an
  evolving entrypoint has actually been redefined. The entrypoint table now
  carries that figure beside "evolving", and a test fails when the two drift.
  A permission to redefine is not a plan, and the question a reader is really
  asking is how often it happens.
- **A release gate on breaking notes.** A `### ⚠️ Breaking changes` section must
  open with a `**Who must act:**` line, so a reader planning an upgrade across
  several minors can see which entry costs a day without reading the change.

## [0.63.0] — 2026-08-25

### ⚠️ Breaking changes

**Who must act:** an application that implements `AgentRuntimeStore` **directly**
adds one member; everyone else re-reads three values. An adapter built on
`AgentRuntimeStoreDriver` needs no code change at all.

Migration steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **`AgentRuntimeStore` gained a ninth member, `absorbQueuedRun`.** An
  application that implements the aggregate directly must add it; one built on
  `AgentRuntimeStoreDriver` gets it for free. It moves a queued successor's
  inputs into the run already answering, atomically, and is what
  `inputPolicy: 'inject'` runs on.

  ```ts
  // before: eight members
  // after:  absorbQueuedRun({ conversationId, runningRunId, runningExpectedRevision,
  //                           ownerId, fencingToken?, queuedRunId, queuedExpectedRevision })
  ```

  The store conformance kit covers it, so an adapter that passes the kit is done.

- **A provider failure no longer reports itself as a policy stop.** A stream that
  errors mid-run still delivers a `finish`, and the branch that read it
  overwrote the `provider_failure` just recorded — naming a stop policy that did
  not exist, with no `policyName`, for a provider outage.

  ```ts
  // before
  terminal.reason === 'policy_stop'   // …for an upstream error, with no policyName
  // after
  terminal.reason === 'provider_failure'
  // and a cap the provider hit — length, content filter — is its own reason:
  terminal.reason === 'provider_stop'
  ```

  **`policy_stop` now always arrives with the `policyName` that caused it.**
  `'provider_stop'` and `'absorbed'` join `AgentTerminalReasonSchema` and
  `AgentRunStateSchema` respectively, so an exhaustive switch needs the arms.

- **`AgentRunMetrics.partial` says something about the run.** It used to be a
  constant per event kind — `true` on every checkpoint, `false` on every
  terminal including runs abandoned mid-stream. It now means "the provider never
  reported this run finished, so this figure is not a confirmed total", which
  makes it `true` on terminal events it used to be `false` on.

- **`assistant-checkpoint` metrics always carry `usage`**, and it is a running
  total. **Read the latest checkpoint; never sum them.**

### Added

- **`inputPolicy: 'inject'`** — a fourth admission policy. It ends nothing: a run
  already in flight takes the new input at its next step boundary and keeps
  going. It queues first and is absorbed opportunistically, so a run that
  finishes before the boundary simply answers it next and no input is ever
  recorded as answered by a turn that never saw it.
- **`AgentRun.usage`** — what a run cost, persisted at every checkpoint and with
  the terminal record. The figure used to exist only on two bounded,
  drop-on-overflow event sinks with no durable counterpart, so a dropped event
  was a lost number and a process that died mid-stream lost everything it had
  counted.
- **`AgentRun.absorbedIntoRunId`** — the run that answered this one's inputs.
- **`AgentCompactionResult.usage`** — what summarising cost. Compaction calls a
  model inside the turn and produces no step and no event of its own, so its
  spend was invisible; returned here, it becomes part of the run's.

### Fixed

- **A dropped observability event is no longer a lost spend figure** — it is
  readable back from the run record.

## [0.62.0] — 2026-08-25

### ⚠️ Breaking changes

Migration steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **A multi-step run's reported cost changes, and so does its provenance.** The
  step loop assigned usage instead of accumulating it, and the `finish` branch
  grafted the surviving `cost` onto the SDK's token aggregate — which carries no
  cost of its own. A successful three-step run costing $0.50, $1.00 and $1.50
  reported **$1.50** beside all 6 000 of its input tokens, labelled
  `provider-reported`. It now reports **$3.00**, labelled `computed`.

  ```ts
  // before
  terminal.usage?.cost        // { value: 1.5, provenance: 'provider-reported' }  ← one step
  // after
  terminal.usage?.cost        // { value: 3.0, provenance: 'computed' }           ← the run
  ```

  **If you filter on `provenance === 'provider-reported'` to decide what to bill
  against, that filter now drops every run total — and used to accept a number
  that was wrong.** Accept `'computed'`: it means the figure was added up, not
  that anyone estimated it.

  Token totals moved the same way, for the same reason. The AI SDK's
  `totalUsage` is a sum *it* performed over per-step provider figures, not a
  total a provider handed over, so it no longer wears the provider's word
  either. **A run total on a terminal event is always `computed`; the provider's
  own figure lives on `step-finished`, per step.**

  A token total missing a step is a floor, still labelled `computed`. A **cost**
  missing a step is `unavailable`, not a floor: "at least $1.00" reported as
  `$1.00` is the same defect one level down. Two costs in different currencies —
  or one with no currency at all — also report `unavailable`; the core records a
  currency and never converts one.

  `assistant-checkpoint` metrics changed meaning with this: they used to
  republish the last finished step and now carry a running total. **Read the
  latest checkpoint; never sum them.**

- **A terminal event always carries `usage`.** It used to be omitted entirely
  when a run ended before the provider's `finish`, so a run that spent nothing
  and a run that burned a minute of an expensive model looked identical.

  ```ts
  // before: `usage` absent on an aborted run — indistinguishable from no spend
  if (event.usage) { … }
  // after: present, with every field stated, unreported ones `unavailable`
  if (event.usage?.cost?.provenance !== 'unavailable') { … }
  ```

  The optional chaining stays necessary: one `AgentRunEventSchema` covers
  `run-started`, `step-finished` and `run-terminal`, and `usage` is rightly
  optional for the first. The guarantee is per event kind and the type cannot
  narrow it.

- **An executor that loses the terminal CAS now emits an operator
  `run-terminal` event.** It ran and it spent; only the *delivery* `terminal`
  event stays gated on `committedByCaller`, because that one carries the
  assistant message and would deliver the turn twice. A sink that counted
  operator terminal events as "runs I committed" now counts runs someone else
  committed too — read `AgentRuntimeResult.metrics`, which is still `undefined`
  for a losing executor.

- **An interrupted assistant turn now tells the model it was cut off.** The
  history projection sent a partial answer upstream as an ordinary assistant
  turn and dropped its `control` marker on the way, so the model received a
  confident half-sentence with nothing to mark it as unfinished — and continued
  a thought the user had already redirected. The partial is still projected;
  it now carries a marker, and the form is a choice.

  ```ts
  // before: an interrupted turn reached the provider as
  //   { role: 'assistant', content: [{ type: 'text', text: 'We are the team, where' }] }
  // after:  the same turn, plus
  //   { type: 'text', text: '[interrupted: this turn was cut off before it finished]' }
  // to render it as context instead of a commitment:
  createAgentRuntime({ history: { interruptedAssistant: 'system-note' } })
  // to keep it out of the request entirely:
  createAgentRuntime({ history: { interruptedAssistant: 'omit' } })
  ```

  There is deliberately no setting that restores the previous output. A silent
  drop is the defect, not a behaviour to stay compatible with.

- **`'superseded'` joins three enums.** `AgentTerminalReasonSchema`,
  `AgentRunStateSchema` and `AgentMessageStatusSchema` each gain a member. Code
  that exhaustively switches on any of them, or that persists them through a
  narrower column, must handle it.

  ```ts
  // before: an ended-by-newer-input run was indistinguishable from a stopped one
  if (run.terminalReason === 'interrupted') { … }
  // after: the two are separate outcomes
  if (run.terminalReason === 'interrupted') { … }   // the user pressed stop
  if (run.terminalReason === 'superseded') { … }    // a newer input ended it
  ```

- **Two decision unions widened.** `AgentHistoryProjectionDecision['reason']`
  gained `'interrupted'` and `'superseded'`; `AgentHistoryBudgetDecision['reason']`
  gained `'superseded'`. Both are output-position unions on exported types, so an
  exhaustive switch over either stops compiling — the same reason the three
  schema enums above are listed here.

  ```ts
  // before: five projection reasons, six budget reasons
  // after:  add the arms, or fall through a default
  switch (decision.reason) { case 'superseded': /* never sent to the model */ break }
  ```

### Added

- **`inputPolicy: 'supersede'`** — a third admission policy. Like `interrupt` it
  ends the run in flight; unlike `interrupt` it discards what that run produced,
  so the partial answer never reaches the model again. The durable record
  survives and is inspectable; only the projection excludes it.
- **`history.interruptedAssistant`** — `'assistant-marked'` (default),
  `'system-note'` or `'omit'`.
- **`AgentHistoryProjectionDecision.omittedParts`** — part types on a projected
  record that no content in the projection stands for, so an application can
  assert what actually reached the provider.
- **`AgentStopReason` gained `'supersede'`** — `runtime.stop(key, 'supersede')`
  ends a run and discards its output by hand, without a newer input arriving.

### Fixed

- **A discarded fragment can no longer come back.** Three readers walked history
  asking whether a record may still reach the model, and each answered with its
  own inline list; two were blacklists, so a superseded record was speakable by
  default in both. A durable interrupt landing on the terminal commit rewrote
  `superseded` back to `interrupted` and republished the fragment; compaction
  summarised it into the conversation **and deleted its record**; and the token
  budget read it as an incomplete turn — the one class eviction refuses to
  touch — so it was unevictable and pushed real turns out in its place. The
  question now has one home (`isSpeakableAssistantStatus`) and a test that
  enumerates the status enum.
- **The history projection no longer drops parts in silence.** `source`,
  `provider`, `control` and unresolved `file` parts were removed from a
  projected record with nothing recording it. Each is now named in that
  record's decision.

## [0.61.0] — 2026-08-25

### ⚠️ Breaking changes

The exported surface is strictly additive; these change what a **running**
system does between versions, which is what this heading exists for. Migration
steps: [`docs/guide/upgrading.md`](docs/guide/upgrading.md).

- **A failed `start()` can now take up to the shutdown budget to reject.** The
  rollback of a failed startup used to close every resource with a zero budget,
  so it returned almost at once — by severing requests the server had already
  accepted. It now spends the application's budget, which means a request that
  never finishes delays the rejection instead of being killed: with the default
  30s grace and 5s force, a `start()` that used to reject in milliseconds can
  take 35 seconds. Nothing else about the failure changed, and with nothing in
  flight it is still immediate.
  `// before: createApplication({ id, resources })` →
  `// after: createApplication({ id, resources, shutdown: { gracePeriodMs: 5_000, forceTimeoutMs: 1_000 } })`
  — declare a smaller budget if a fast failure matters more than draining. The
  same field is now also the default for `shutdown()` called with no options.

- **A refused realtime frame now answers its sender.** A frame failing the
  receiver's `args` schema was dropped where it landed; if the event carries an
  acknowledgement, the receiver now answers it and the sender's `request()`
  rejects with `RealtimeRequestRejectedError`. Against an older peer with a
  contract-first acknowledgement this is strictly better — an immediate
  `RealtimeRequestInvalidAcknowledgementError` instead of an expired deadline.
  Against an older peer whose acknowledgement schema validates nothing
  (`z.unknown()`, a loose object) the refusal is read **as a value**, silently.
  That last case is why this is marked rather than shipped as a patch: a caret
  is the only thing that makes upgrading one half of a distributed pair a
  decision instead of an accident.
  `// before: ack: z.unknown()` → `// after: ack: z.object({ … })`

- **`reportHealth` called inside `start` is kept instead of discarded.**
  Becoming ready assigned `healthy` unconditionally, so a resource that reported
  during `start` was silently reported as fine. Grep for **every** `reportHealth`
  in a `start` body, not just the `degraded` ones — the old assignment also
  repaired a pessimistic early `'unhealthy'` that was never corrected.
  `required` defaults to **`true`** and readiness requires every required
  resource to be healthy, so a required resource that starts non-healthy now
  refuses the startup: the invariant working as intended, newly reachable. An
  **optional** one moves the application aggregate to `degraded`, which can flip
  a readiness probe.
  `// before: defineManagedResource({ id, start })` →
  `// after: defineManagedResource({ id, required: false, start })` for a
  resource expected to start degraded; report the recovery instead if it was
  only temporarily unhealthy.

- **`streamSSE`'s `cancel` no longer awaits the generator**, so teardown is
  unordered relative to request completion. Named here rather than under
  *Fixed*: a generator releasing a resource in its `finally` used to be
  guaranteed to have finished before the response settled.

- **`RealtimeRejectedEvent['reason']` gained `'rejected-by-peer'`.** An
  exhaustive `switch` with an `assertNever` default stops compiling.

- **A `socket.io-client` peer that cannot load no longer kills the process** when
  `onConnectError` is configured. A handler that logs and moves on now leaves a
  live process with a client that will never connect, where a supervisor used to
  restart it.

### Added

- **`ApplicationConfig.shutdown` — the budget an application declares once.**
  A rollback happens inside `start()`, so there is no call site to pass options
  to; the budget had to be declared where the application is. It is also the
  default for `shutdown()` called with no options, so "how long may this
  application take to stop" is one number rather than two that can disagree.
  Exported as `ApplicationShutdownBudgetSchema` / `ApplicationShutdownBudget`
  from `stitchkit/application`.

- **`ndjsonRoute` / `sseRoute` / `streamingRoute` — a long-lived subscription
  route.** `RawRoute` + `ctx.server` already gave every capability needed to
  serve a continuing body; the problem was that each such route's author had to
  independently remember three unrelated things, each of which fails quietly: clear the generic HTTP idle timeout (Bun resets an
  idle connection after ten seconds, which for a subscription is a healthy
  connection severed on a schedule), send a heartbeat (proxies do not hold a
  connection carrying no bytes), and flush the headers at open (a runtime sends
  nothing until the body produces a byte, so the consumer's `fetch` never
  returns and "subscribed and silent" becomes indistinguishable from "not
  answering"). The route does all three, frames NDJSON or SSE from one code path,
  and cancels the source when the consumer leaves.

  Cancellation is a signal, not just `iterator.return()`: an async generator
  serialises its requests, so a `return()` issued while a `next()` is in flight
  is queued behind it — and a subscription is in `next()` almost always. The
  source is given `context.signal`, aborted the moment the consumer goes away
  through either route (request abort or stream cancel).

  ```ts
  ndjsonRoute({
    path: '/events/subscribe',
    heartbeatMs: 5_000,
    source: async function* (request, { signal }) {
      for await (const event of subscribe({ signal })) yield event
    },
  })
  ```

- **`parseNDJSON`** on the root entrypoint — the client half, in which **blank
  lines are skipped**. That is the contract rather than a convenience: the
  keep-alive frame for this framing is an empty line, so writing the rule on
  both sides stops it being a verbal agreement between two halves of one
  project.

- **`createSocketIOClient({ peers })` — the client half of peer injection.**
  0.60.0 gave the server a way to put `socket.io` inside a self-contained
  artifact; the client had none, and `socket.io-client` is resolved through a
  variable specifier that no bundler can follow *by construction*. A consumer
  shipping one file that **dials** a socket — a CLI, an agent, a worker — was
  left with the workaround that release closed: patching stitchkit's built
  `dist`. `peers: { client: () => import('socket.io-client') }` puts the literal
  in the consumer's own source. Omitting it changes nothing.

- **`RealtimeRequestRejectedError` — a schema rejection is now visible to the
  sender.** A frame that failed the receiver's contract was dropped where it
  landed: the receiver reported `onRejected` and the sender learned nothing,
  waiting out its deadline and reporting a timeout. A version skew therefore
  presented as *healthy machines, unexplained timeouts*, symmetrically and on
  every plane at once. When the refused event carries an acknowledgement, the
  refusal now travels back on it and `request()` rejects at once with the
  reason and the peer's already-flattened issues (`path: '0.v'`), which replaces
  the documented recipe of inspecting a `ZodError`'s internals. The back-channel
  is the callback that is on the wire, so a **sender-first rollout** — the
  sender's contract has gained an acknowledgement and the receiver's has not —
  is answered rather than timed out. The issue list is capped where the envelope
  is built, and `reason` is a string so a later release's reason still reads as a
  refusal. On a bare `emit(event, …, callback)` a refusal reaches `onRejected`
  and not the callback; `request()` is the path that rejects. → ADR 0106

  **Talking to a peer that predates this**: it parses the envelope with its own
  `ack` schema. A contract-first acknowledgement (a `z.object`) rejects it, so
  the older peer raises `RealtimeRequestInvalidAcknowledgementError` at once
  instead of timing out. An older peer whose acknowledgement schema validates
  nothing (`z.unknown()`, a loose object) would instead read the refusal as a
  value — the one pairing where this is a step sideways, named in ADR 0106.

### Fixed

- **`managedServerResource` could not shut a server down at all**, and
  `retryAfterSeconds` was the same defect one field over.
  `ManagedResourceContext.now()` is `performance.now()`, so every budget the
  adapter derived from it was fractional, and `ShutdownOptionsSchema` declares
  `gracePeriodMs`/`forceTimeoutMs` as integers and validates its input. The
  server therefore refused every call the adapter made, in every phase: the
  application always finished `forced` without once stopping the server
  properly, and the reason was visible only to a consumer who had wired
  `onResourceFailure`. Budgets are now whole milliseconds, rounded down —
  a budget is a promise about time that remains.

- **Rolling back a failed startup is a shutdown, not an abort.** The rollback
  called each resource's `close` with no deadlines at all, so an adapter's
  honest arithmetic produced `{ gracePeriodMs: 0, forceTimeoutMs: 0 }` — an
  immediate hard abort of requests already in flight, on a path nobody chose to
  be on. It cost three things, not one: the request died at the socket rather
  than being answered; the rollback itself then failed, because
  `withTimeout(forceStop(), 0)` cannot succeed; and that failure *replaced the
  diagnosis*, so `start()` rejected with an `AggregateError` reading "startup
  and rollback failed" and the resource that actually broke was one entry down.
  The rollback now spends the application's declared budget, and the startup
  cause is again what `start()` rejects with.

- **A rollback is now bounded, not merely budgeted.** `closeAttempted` awaited
  each `close` with nothing watching the clock, so a resource whose `close`
  never returned — a poller awaiting its own completion, a consumer resource
  with a hung upstream — kept a failed startup from ever reporting why it
  failed. The budget is now enforced: an unfinished `close` is abandoned when it
  runs out and reported as a `close` failure, with the startup error preserved
  as the `AggregateError`'s `cause`.

- **`managedServerResource` no longer reads an absent deadline as a spent one.**
  `ManagedResourceContext` declares `deadlineAt` and `forceDeadlineAt` optional,
  so absence is a legal input — the conformance kit builds such contexts, and so
  may a consumer. The adapter collapsed it into `now`, producing a zero budget;
  it now omits the field and lets `ShutdownOptionsSchema` apply the defaults it
  already carries.

- **The refusal when an application is not ready after startup names the
  resource.** It said "a required resource lost readiness during startup",
  which is a false lead for a resource that never had it.

- **A `socket.io-client` peer that cannot load no longer takes the process
  down.** The load failure was an unhandled rejection, so a missing peer killed
  the process at the first `connect()` — with no way for the caller to catch,
  retry or report it. It is now delivered to `onConnectError` with
  `terminal: true`, and the client resets its connection intent so a later
  `connect()` can start a fresh attempt. With no `onConnectError` the failure is
  still re-thrown, so nothing becomes silent. A load that fails while a
  `disconnect()`/`connect()` races it is now reported once rather than twice.

- **`streamSSE`'s `cancel` no longer waits on the generator it is cancelling.**
  An async generator serialises its requests, so a `return()` issued while a
  `next()` is in flight is queued behind it — awaiting it made cancellation wait
  for the very value the departed consumer was no longer there to receive. The
  generator is still asked to finish; the cancel no longer hangs on the answer.
  A source that *waits* rather than produces belongs in `streamingRoute`, which
  hands it an abort signal. (The ordering consequence is under **Breaking
  changes** above.)

## [0.60.1] — 2026-08-25

### Fixed

- **`close()` waits for the admissions already inside it.** The closed-check
  stopped what had not started, but a submission that had passed it and was
  inside `acceptInputAndAssignRun` owned no coordinator lane yet — so the close
  drained the coordinator, found nothing, answered `settled: true, remaining:
  0`, and the store then committed a queued run for it. Durable work with no
  executor, announced as a clean shutdown. `close()` now waits for every
  in-flight admission to either refuse before the durable write or hand off to
  the coordinator, inside the same budget the caller gave; an admission that
  never hands off is counted in `remaining` rather than lost.
- **An admission refusal reaches the caller as itself.**
  `ApplicationAdmissionError` and `GrammyWebhookUnavailableError` extended plain
  `Error` while carrying a `code` field, and `normalizeError` starts with
  `AppError.is(err)` — so both arrived as `INTERNAL_SERVER_ERROR` / 500, the
  declared 503 never left the process, and `createErrorHook`'s `codeMap` and
  `unmappedCode` never saw the code. Both are branded `AppError`s now, and
  `GRAMMY_WEBHOOK_NOT_ACCEPTING` joins the registry beside
  `APPLICATION_NOT_ACCEPTING` — a decision ADR 0105 now states for adapter codes
  in general, replacing a comment beside the class that claimed the opposite.
- **`recover()` writes nothing after `close()` has answered.** The closed-check
  ran on entry and again per page, and both are before `decide()` — the
  caller's own callback, which is where a close fits. A close arriving inside it
  found no coordinator lane and no in-flight admission, reported a settled
  shutdown, and `recoverRun` then committed. Recovery's mutating slice is inside
  the same admission barrier as `submit()` and `resume()` now: a close stops the
  scan mid-page, and it does not return while an item is still writing.
- **`close()` refuses an impossible budget without closing anything.**
  Validation lived in the coordinator, one await past the point where the
  runtime had already stopped admitting work — so `close({ forceTimeoutMs: NaN
  })` left a caller holding a `TypeError` *and* a closed runtime. The budgets
  are checked first, and what a close spends waiting is measured on a monotonic
  clock instead of the runtime's semantic `now`, which a caller may pin to a
  fixed instant.
- **A run's idle deadline is disposed on every path.** It was disposed after the
  `try/catch`, and the `catch` does its own I/O — a `loadSnapshot` that threw
  there left the timer armed for the life of the process.
- **A conversation snapshot orders its runs by history, not by a coin toss.**
  `runs` was sorted by `createdAt` and, on a tie, by the run identifier — but a
  successor coalescing behind an active run is created inside the same
  millisecond as it, and the identifier is random. Half the time the snapshot
  listed the successor first. Runs that share a timestamp are now separated by
  the position of the earliest message they own, so position carries meaning
  and a reader may rely on it.

## [0.60.0] — 2026-08-25

### ⚠️ Breaking changes

- **`AgentRuntime.close()` returns what it achieved instead of `void`.** Its
  documented contract held three claims that cannot all be true at once —
  "every combination is bounded", "omit `forceTimeoutMs` and it waits for
  settlement", and "`close()` never returns while a run is still in flight".
  Without a force budget the wait is unbounded; with one, returning while a run
  is in flight is exactly what the budget is for. The result now says which side
  of that trade the caller got: `{ settled, timedOut, remaining }`. Code that
  ignores the value is unaffected.
  `// before: await runtime.close({ forceTimeoutMs: 5_000 })  // "never returns while a run is in flight"` →
  `// after:  const { settled, remaining } = await runtime.close({ forceTimeoutMs: 5_000 })`
- **Application status and probe endpoints publish a projection, not the raw
  snapshot.** `createApplicationHealthHandler` and
  `createApplicationOperationalHandlers` returned the full `ApplicationSnapshot`,
  which names every resource, its `dependsOn` edges, the process `epoch` and live
  admission counters — on handlers the guide documents for public mounting. They
  now return `ApplicationStatusProjection`: `lifecycle`, `health`, `ready`,
  `id`, `capturedAt` and resource counts. The full snapshot stays available
  in-process.
  `// before: (await fetch('/status').then((r) => r.json())).resources[0].dependsOn` →
  `// after:  app.getSnapshot().resources[0].dependsOn`
- **`AgentRuntimeStore.scanRecoverable` is one bounded page, and it is the only
  scan.** The interface demanded a mandatory unbounded
  `scanRecoverable(): Promise<AgentSnapshot[]>` the runtime never called, while
  the bounded `scanRecoverablePage?` that `recover()` actually needs was
  optional — so a store written straight from the interface threw
  `'The configured agent store does not support bounded recovery scans'` at
  startup. One member now carries the bounded signature the driver already used.
  `// before: { scanRecoverable: () => allSnapshots(), scanRecoverablePage: (page) => …  }` →
  `// after:  { scanRecoverable: (page) => … }`
- **`unresolvedFile` defaults to `omit`, and `text` no longer sends the storage
  reference.** The default rendered `[attachment: <reference>]` into the message
  sent to the model provider, where `reference` is an address in the
  application's own storage — an object key or a path. The placeholder now
  describes the attachment by filename or media type.
  `// before: history: {} → provider sees "[attachment: s3://bucket/tenant/42/file.pdf]"` →
  `// after:  history: { unresolvedFile: 'text' } → provider sees "[attachment: file.pdf]"`
- **`runtime.close()` uses the shared shutdown vocabulary, and every combination
  of budgets is bounded.** `drainTimeoutMs` is now `gracePeriodMs` — on
  `AgentSessionCloseOptions` as well, so a consumer holding a coordinator
  directly gets the same rename — the name the
  server and the application kernel already use for the same budget. Two
  semantics were also wrong: `close({ drainTimeoutMs })` without a force budget
  aborted and returned *without* awaiting settlement — a weaker guarantee than
  passing nothing — and `close({ forceTimeoutMs })` without a drain budget never
  read the force budget at all. Both now behave as their names say. (**Superseded
  in this release:** the sentence that once stood here — "`close()` now never
  returns while a run is in flight" — was never true with a force budget, which
  exists precisely to stop waiting. `close()` reports what it achieved instead;
  see the breaking entry above.)
  `// before: runtime.close({ drainTimeoutMs: 30_000, forceTimeoutMs: 5_000 })` →
  `// after:  runtime.close({ gracePeriodMs: 30_000, forceTimeoutMs: 5_000 })`
- **`STITCH_ERROR_STATUS` gained `APPLICATION_NOT_ACCEPTING` (503).** The kernel
  emitted this code with no entry in the registry, so `isStitchErrorCode()`
  denied it and the `unmappedCode` resolver could not see it. Only an exhaustive
  `satisfies Record<StitchErrorCode, …>` map breaks.
  `// before: { …, INTERNAL_SERVER_ERROR: 'internal' } satisfies Record<StitchErrorCode, string>` →
  `// after:  { …, APPLICATION_NOT_ACCEPTING: 'unavailable' } satisfies Record<StitchErrorCode, string>`
- **`AgentModelDeclaration` is removed — use `AgentModelDescriptor`.** It was a
  bare alias of the same type, so one concept carried two exported names: the
  registry constraint said `AgentModelDeclaration` while `registry.descriptor()`
  returned `AgentModelDescriptor`.
  `// before: defineModelRegistry<Record<string, AgentModelDeclaration>>({ … })` →
  `// after:  defineModelRegistry<Record<string, AgentModelDescriptor>>({ … })`
- **`application.shutdown()` no longer accepts `retryAfterSeconds`.** It is an
  HTTP response concern owned by the managed server resource; the kernel typed,
  validated and then ignored it.
  `// before: app.shutdown({ gracePeriodMs: 0, retryAfterSeconds: 30 })` →
  `// after:  app.shutdown({ gracePeriodMs: 0 })  // managedServerResource({ retryAfterSeconds })`

### Added

- **`AgentRuntimeConflictError` is exported.** It is thrown from `submit()`,
  `resume()`, `recover()` and terminal commit, and could previously only be
  identified by comparing `error.name` to a string.
- **`ActivityTokenBrand` is exported**, so `ActivityProjection` can be
  implemented outside the module that declares it.
- **Every entrypoint declares its maturity.** The getting-started table now
  carries a `Maturity` column — `stable` or `evolving` — and a check refuses a
  published export that has no row or no level. `declaration`, `agent-runtime` and
  `application` are declared evolving (→ ADR 0103).
- **Agent event deduplication is bounded.** The set of already-emitted event ids
  never forgot, so a runtime executing indefinitely grew for the life of the
  process. It now keeps a fixed window.
- **`createApplication({ onResourceFailure })`.** Every failure of a resource's
  own code reports the value it actually threw — `start`, `ready`, `completion`,
  `admission`, `drain`, `close` including the close that runs while rolling a
  failed startup back, and `force` including a resource whose close was already
  invoked and never settled. Previously the kernel caught and discarded the
  cause on several of those, so an operator saw the phase label and nothing
  else. The kernel interrupting its own startup because a shutdown overtook it
  is deliberately NOT reported: nothing failed there, and reporting it buries
  the failure that did. The observer may be `async` — its return type is
  `void | Promise<void>` and a rejection is isolated, where before an `async`
  observer type-checked against `void` and its rejected promise escaped the
  synchronous `try/catch` around the call. A throwing observer cannot break the
  lifecycle it observes, and neither can a slow one: the kernel does not await
  it.
- **`STITCH_ERROR_STATUS` carries every code the framework throws** (→ ADR 0105).
  Five were missing — `WAIT_TIMEOUT`, `WAIT_FAILED`, `DOWNLOAD_NOT_FOUND`,
  `VIEW_HTTP_ERROR`, `OPERATION_NOT_SUCCEEDED` — so `isStitchErrorCode` answered
  `false` for them and `createErrorHook` skipped both the `codeMap` lookup and
  the `unmappedCode` fallback: the code reached the wire in stitchkit's spelling
  as though the project had thrown it, and a consumer who had mapped "every
  framework code" was silently missing five. Completeness is now held by a check
  over the source rather than by review, which is how the fifth was found. This
  widens `StitchErrorCode`; `codeMap` is `Partial`, so nothing has to move —
  unless you wrote `satisfies Record<StitchErrorCode, …>` yourself, which now
  asks you for five more entries.
- **`createSocketIOServer({ peers })` — ship the Socket.IO peers inside one
  artifact.** They are resolved through a variable so a consumer bundling an
  unrelated `stitchkit/server` export never has to resolve them, and no bundler
  can follow that. There was no way back: a consumer who uses this adapter and
  ships a single self-contained file to a machine with no `node_modules` got
  `needs the optional peer "socket.io"` at START-UP, and the only workaround was
  patching stitchkit's built `dist` — which broke whenever the internal layout
  moved. Passing `peers: { server: () => import('socket.io'), bunEngine: () =>
  import('@socket.io/bun-engine') }` puts the literal in the consumer's own
  source, where their bundler sees it. Omitting it changes nothing. Proved as a
  pair in the consumer lane: the injected artifact starts in a directory with no
  `node_modules` under Node and under Bun with auto-install off, and the same
  program without the loaders must fail there.
- **Declared build inputs — the third kind of thing a build reads.** The
  boundary rule separates code from the values of a place; data read while
  building is neither, and a build that reads it undeclared is a function of
  whichever machine happened to have the database. `build.inputs` names a frozen
  export inside the source and pins its bytes with a `sha256:` digest. Absent
  `inputs` means the build reads no data — an answer, not a gap. The other two
  legitimate answers need no field: render at runtime, or generate the bytes as
  a release step.
- **`stitchkit/declaration` — the project declaration schema** (→ ADR 0104). One
  versioned Zod schema for what a repository says about itself, shipped from the
  framework so the project, the scaffolder and whatever binds an artifact into a
  deployment cannot hold different copies of it. `parseProjectDeclaration` refuses
  an unrecognised `schemaVersion` **before** reading any field, so a reader that
  is too old fails closed instead of interpreting a declaration partially.

  It carries `kind`, `identity`, `roles`, `build`, `requires`, `release` and
  `env`. The boundary rule is held by **structure**: there is nowhere in the
  schema that a port, a host, an absolute URL, a machine path, a routing rule or
  a supervision policy must go. A binding is named by the variable that will
  carry it and never valued; a build artefact is a path inside the source; a
  command is argv, no part of which may be an absolute path or carry an inline
  value, and a listener's variables must exist in `env.variables` with matching
  shapes. Every remaining free string is filtered through `namesAMachine` — that
  half is hygiene for known shapes, not a proof: a secret or a hostname written
  as a plain argument is indistinguishable from any other argument, and this is
  not a secret scanner. A role may declare **no listener at all**
  (a queue consumer, a bot, a scheduler), readiness belongs to a role rather than
  to the application, and `drainFloorMs` states how long the *code* needs to
  drain so a supervisor can be checked against it rather than trusted. Migrations
  are declared as bytes — `engine`, `root`, `lockfile` — not as a command to run,
  leaving the admission decision with the side that can see the deployment.

  A project narrows the schema with `safeExtend`, which keeps those checks in
  force. Unknown keys are **refused**, not stripped: a key one reader does not
  recognise is a disagreement between programs that never meet, and discarding
  it silently is how a partially understood declaration becomes a running,
  wrong deployment. `namesAMachine` is exported so a consumer can apply the same
  test. The entrypoint is **evolving**.
- **`createSocketIOServer({ cors })` is optional.** Omitted, Socket.IO emits no
  CORS headers at all — same-origin only, the safe default and one a repository
  can hold without knowing where it will run. Requiring an allow-list forced
  every project to name a foreign origin, which is a value of the place, not of
  the code. A cross-origin browser still passes `cors` exactly as before.

## [0.59.4] — 2026-08-24

### Added

- **Packed-package optional-peer bundle matrix.** The consumer release lane now classifies every
  public export and mixed-barrel feature by runtime target, installed peers, JavaScript bundle and
  declaration budgets, execution policy and missing-peer proof. A new export or accidental
  runtime/type-only peer edge fails with its exact matrix case and package name.
- **Deterministic managed-resource conformance kit.** `stitchkit/testing` now runs a stable
  black-box lifecycle matrix against consumer-owned `ManagedResource` adapters, covering startup
  rollback, readiness/completion wiring, activation, shutdown races and forced cleanup with
  caller-controlled barriers, required disposal and normalized scenario traces.
- **Pull-only application operations integration.**
  `createApplicationOperationalHandlers` composes always-readable status and
  canonical readiness/liveness handlers. The isolated
  `stitchkit/application/opentelemetry` entrypoint maps current application,
  resource, admission, schedule and activity snapshots to fixed observable
  gauges on an injected Meter, without owning an SDK, exporter, polling loop or
  replay/delta state.
- **Executable managed-application migration recipes.** Database partial-start cleanup, observed
  poller completion, queue admission/drain and latest-value operational publishing now have one
  checked-in source that is typechecked and executed against the packed public package. The paired
  guide makes durable claims, transactions, retry/idempotency and provider policy explicitly
  application-owned.

## [0.59.3] — 2026-08-24

### Fixed

- **Bundling peer-free process signal handling no longer requires unused Socket.IO peers.** The
  optional `socket.io` and `@socket.io/bun-engine` modules remain runtime-lazy and are now opaque to
  consumer bundlers, so importing `bindProcessSignals` from `stitchkit/server` works without
  installing realtime dependencies. Explicit Socket.IO use retains its actionable missing-peer
  diagnostic.

## [0.59.2] — 2026-08-24

### Added

- **Provider-neutral managed application kernel.** The server-only
  `stitchkit/application` entrypoint composes a validated resource graph with
  attempted-start rollback, separate readiness and health, process-local
  admission, two-deadline shutdown, post-ready fixed-rate schedules and
  latest-value operational snapshots. `stitchkit/application/grammy` remains an
  isolated optional-peer adapter for injected polling and webhook bots; durable
  jobs, provider policy and deployment stay application-owned.

### Fixed

- **Node port-zero servers no longer expose a Fetch-blocked ephemeral URL.** When the operating
  system allocates a WHATWG-blocked port such as `4045`, `serveNode({ port: 0 })` closes it and
  rebinds before attaching provider lifecycles or returning the managed handle. Explicit ports
  remain application-owned configuration.

## [0.59.1] — 2026-08-23

### Fixed

- **Concurrent provider completion and durable interrupt no longer strand an active run.** The
  terminal path now reconciles after every losing CAS while ownership and fencing remain current:
  it settles from an already-terminal canonical snapshot, or terminalizes a still-owned
  `interrupt_requested` run as interrupted. Only the execution that applies the terminal mutation
  publishes terminal delivery and metrics; canonical winners settle losing tickets without a
  duplicate event. Coalesced successors therefore start after the predecessor settles instead of
  failing behind a stale revision.

### Added

- **Declarative CLI command presentation policy.** `createCli` now accepts a
  `defaultCommand`, exact command-local one-letter `optionAliases` and explicit
  per-command `positionals`. Routing, parsing and generated help share one
  resolved descriptor across native, contract and runtime commands; omitted
  policy retains the existing CLI grammar.
- **Typed native result presentation and successful exit classification.** A
  `defineCliCommand` with declared output may provide post-validation `present`
  and `exitCode` callbacks with the exact inferred Zod output type. Invalid or
  throwing policy becomes a normalized internal failure with no partial success
  output.

## [0.59.0] — 2026-08-23

### ⚠️ Breaking changes

- **Agent runtime drivers now persist a bounded head plus normalized run and admission records.**
  The lifetime `AgentStoredState` aggregate, `state` driver member, archived-message lookup and
  synchronized recoverable descriptors are removed. This keeps each CAS constant-size and lets a
  terminal run retain its canonical assistant independently of product-history compaction.
  `// before: { state: { load, compareAndSwap }, history: { load, loadById, apply }, scanRecoverable }` →
  `// after: { head: { load, compareAndSwap }, runs: { load, loadByAssistantMessageId, loadMany, listActive, save }, admissions: { load, loadByInputMessageId, create }, history: { load, apply }, scanRecoverable }`.
- **Duplicate store results now include the canonical run and optional terminal assistant.** Custom
  `AgentRuntimeStore` implementations must return the assigned run, and must retain its terminal
  assistant when the run is terminal.
  `// before: { outcome: 'duplicate', input, inputMessageId, runId, assistantMessageId, snapshot }` →
  `// after: { outcome: 'duplicate', input, inputMessageId, runId, assistantMessageId, run, assistant, snapshot }`.

### Fixed

- **Duplicate terminal submissions survive physical history compaction.** Durable receipts now
  return the canonical run and retained terminal assistant, so admission events and ticket results
  never fall back to a pending placeholder or fail because the product history deleted old rows.

## [0.58.0] — 2026-08-22

### ⚠️ Breaking changes

- **Default history projection now rejects invalid chronology.** Completed assistant records before
  the first user message and assistant records with unmatched tool calls/results are omitted with an
  inspectable decision instead of being forwarded to the provider. Opt into the former leading
  behavior only when the provider contract permits it.
  `// before: projectAgentHistory(messages)` →
  `// after: projectAgentHistory(messages, { leadingAssistant: 'allow' })`.
- **Operator events redact `internalCause` by default.** Raw provider/tool failures now require an
  explicit operator-only opt-in; product delivery remains redacted.
  `// before: createAgentObservability({ write })` →
  `// after: createAgentObservability({ write, includeInternalCause: true })`.

### Added

- **Complete context/model mechanics.** `selectAgentHistory()` performs explainable whole-turn
  budgeting; detailed history projection reports omissions; model registries expose availability,
  versioned discovery snapshots and freshness validation; optional runtime model preflight runs
  before durable input admission.
- **Bounded compaction, delivery and race contracts.** Compaction conflicts can recompute from a
  fresh snapshot within `maxAttempts`; durable events have stable IDs and cursor gap detection;
  bounded event sinks isolate transport failure; `stitchkit/testing` exports named bounded barriers
  and exact traces exercised by packed Bun/Node consumers.
- **Distributed fencing refinement.** Run acquisition increments an optional monotonic
  `fencingToken` carried through managed tool context and checkpoint/terminal CAS without moving
  lease ownership into core.

## [0.57.0] — 2026-08-22

### ⚠️ Breaking changes

- **Agent-store duplicate results persist the complete admission identity.** Durable
  `AgentRuntimeStore` implementations must return canonical `input`,
  `inputMessageId` and `assistantMessageId` beside `runId`; this lets duplicate
  and coalesced admission receipts project the actual records even after compaction,
  without rereading adapter internals.
  `// before: { outcome: 'duplicate', runId, snapshot }` →
  `// after: { outcome: 'duplicate', input, inputMessageId, runId, assistantMessageId, snapshot }`.
- **`AgentRuntimeEvent` adds an `admission` variant and its assistant projection may
  be terminal.** Exhaustive publisher switches must handle the post-commit event;
  duplicate submission projects the already persisted assistant message when one
  exists, rather than inventing a pending placeholder.
  `// before: switch (event.type) { case 'run-state': ... }` →
  `// after: switch (event.type) { case 'admission': persistProjection(event); ... }`.

### Added

- **Framework-owned agent persistence reducer.** `createAgentRuntimeStore()` accepts
  one coherent transaction driver for state load/CAS, canonical history mapping and
  paged recovery scan. Run transitions, revisions, collision checks, idempotency,
  coalescing, terminal mapping and compaction stay inside Stitchkit; the memory store
  uses the same reducer. `runAgentStoreConformance()` is available from
  `stitchkit/testing`, with an executable Prisma/PostgreSQL reference fixture outside
  the published package.
- **Projection-complete admission and recovery.** Admission receipts and post-commit
  events carry the canonical input, assigned run and pending assistant projection.
  Checkpoint/terminal events carry provenance-aware partial/final metrics, and
  `runtime.recover()` performs bounded startup scans with queued-resume/acquired-skip
  defaults and per-run outcomes.

- **`createErrorHook` can declaratively map unmapped framework codes.** Set
  `unmappedCode` to one wire-code or a `(code: StitchErrorCode) => wireCode`
  resolver; explicit `codeMap` entries still win, project-owned codes still
  pass through unchanged, and omitting the option preserves the prior behavior.

## [0.56.5] — 2026-08-22

### Added

- **Agent runtime publishers receive ordered live reasoning events.** The managed
  loop now emits transient `reasoning-start`, `reasoning-delta` and
  `reasoning-end` events with runtime epoch/sequence identity and an optional
  validated provider envelope. Applications can preserve live reasoning UI
  without owning a second stream loop; checkpoints remain the durable source.

## [0.56.4] — 2026-08-22

### Fixed

- **Agent runtime close now drains before forcing shutdown.**
  `runtime.close({ drainTimeoutMs, forceTimeoutMs })` first closes process-local
  admission and lets active runs settle naturally for the drain budget. Only an
  expired drain aborts them with reason `shutdown`; the additive force budget
  then bounds settlement of a non-cooperative model or tool. Calling `close()`
  without a drain budget retains immediate abort-and-settle behavior.

## [0.56.3] — 2026-08-22

### Added

- **Agent admission exposes stable application identity.** `runtime.submit({ recordIds })` accepts
  optional caller-provided input/run/assistant record IDs and its ticket adds an `admission` promise
  with the actually assigned run, assistant and snapshot identity. Accepted-response transports can
  return durable placeholders immediately, including the existing successor identity after
  pending-input coalescing, without observing store internals or predicting `generateId()` order.

### Fixed

- **Agent admission rejects canonical identity collisions.** The reference store refuses a new
  assistant ID that could overwrite an existing message or another run's assistant, while
  coalescing ignores the discarded proposal. Runtime ticket deduplication also uses nested identity
  maps, so arbitrary non-empty conversation and idempotency strings cannot alias each other; the
  new optional admission promise is internally observed so existing `accepted`/`result` consumers
  do not gain an unhandled rejection path.

## [0.56.2] — 2026-08-22

### Added

- **Optional server-only agent application runtime.**
  `stitchkit/agent-runtime` composes a Zod-first engine protocol, one aggregate
  CAS store boundary, provider-valid history, prompt budgets, typed model
  registry, stream-first AI SDK loop, strict keyed coordination, managed-tool
  fencing, stable delivery events and agent-run observability. The low-level
  `mountAgent` path remains independent. OpenRouter integration is isolated at
  `stitchkit/agent-runtime/openrouter`, so neutral imports do not resolve its
  optional peer.
- **Mature-consumer parity policies for the agent runtime.** Pending inputs can
  coalesce into one durable successor run; `prepareStep`, named custom stop
  conditions and inactivity timeout are managed by the loop; structured system
  instructions preserve provider cache metadata; history accepts an async
  multimodal file resolver; and stable tool events include JSON-safe input and
  result payloads without exposing internal failures.

## [0.56.1] — 2026-08-21

### Added

- **Opt-in structured HTTP cancellation events.**
  `createObservability({ request: { includeCancelled: true, ... } })` emits a
  `RequestEvent` with `outcome: 'cancelled'`, `ok: false` and status `499` for a
  confirmed client disconnect. The flag defaults to `false`, so existing sinks
  do not receive a new row class after upgrading.

### Fixed

- **A client-closed HTTP request is no longer an internal server error.** When
  the request signal is aborted and the thrown value is its `AbortError` or
  preserves the exact abort reason through a bounded, cycle-safe `cause` chain,
  Bun and Node/srvx now finish the access record as `499` at `info`, without
  `INTERNAL_SERVER_ERROR`, `console.error`, request-error audit fields or project
  `onError`. Framework JSON body reads also interrupt a pending bounded stream
  read on mid-upload disconnect instead of hanging or parsing partial JSON.
  Internal `AbortError` values on an active request remain 500s, and `499`
  remains a transport outcome absent from OpenAPI.
- **`createErrorHook` accepts a partial code map.** `codeMap` was
  `Record<StitchErrorCode, …>`, so every code a release adds broke compilation
  for every project that translates codes at all — 0.56.0's seven `FILE_*`
  codes being the most recent. It is now
  `Partial<Record<StitchErrorCode, …>>` and an unmapped code travels as itself,
  the same way a code the project threw on its own always has. Exhaustive maps
  are unaffected.

## [0.56.0] — 2026-08-21

### ⚠️ Breaking changes

- **Surface manifests are version 2 and model tool projections separately from
  canonical operations.** `operation.tools` could not represent role-selected
  MCP surfaces, different Agent/CLI selections or advertised `extend` schemas.
  `ConformanceTransport` also adds `REALTIME`, so exhaustive transport records
  must handle it. The old generic projection types are replaced by reachable
  transport-specific configuration: one global `SurfaceMcpPreparation`, named
  plain `SurfaceToolDefinition` selections, `SurfaceAgentProjection`, and a
  plain CLI selection. The peer-free `SurfaceRuntimeToolDefinition` remains the
  canonical manifest descriptor.
  `// before: manifest.operations[0].tools.MCP` →
  `// after: manifest.toolSurfaces.find((s) => s.transport === 'MCP' && s.surface === null)?.tools`;
  `// before: mcpSurfaces: { admin: { services, extend } }` →
  `// after: mcpSurfaces: { admin: { services } }, mcpPreparation: { extend }`.
- **The framework error-code registry includes safe managed-file failures.**
  Exhaustive `Record<StitchErrorCode, …>` maps must add `FILE_INVALID_PATH`,
  `FILE_OUTSIDE_ROOT`, `FILE_NOT_FOUND`, `FILE_NOT_REGULAR`,
  `FILE_INSPECTION_REJECTED`, `FILE_TOO_LARGE` and `FILE_EXISTS`. Raw managed
  download/upload failures now include a stable `[CODE]`; unexpected IO remains
  scrubbed as `INTERNAL_SERVER_ERROR`.
- **`ScopedAuthHook` is now a canonical, nominal capability.** Hand-written
  structural functions are no longer assignable; create hooks with
  `createAuthHook`, then combine domains with `composeAuthHooks` so runtime scope
  ownership and inferred context cannot drift.
- **Managed-file inspectors now run on reads and have a finite default
  deadline.** Existing write-only inspectors may now see reads without a
  `declaredMediaType`; make inspection read-aware and idempotent, and set
  `inspectionTimeoutMs` explicitly when 15 seconds is not the right budget.
  `// before: inspect: ({ declaredMediaType }) => inspectDeclaredType(declaredMediaType!)` →
  `// after: inspect: ({ prefix, declaredMediaType, signal }) => inspectBytes(prefix, { declaredMediaType, signal })`.
- **Direct contract-backed async-operation binding requires a wire-stable ID
  schema (`z.input` equals `z.output` and parsing has no transform, coercion,
  default or overwrite).** Even a same-type transform cannot be reused as the
  follow-up wire input because direct adapters would parse it twice. Use adapted
  binding with a canonical parsed `id` and explicit `inputFor` adapters.
  `// before: binding: 'direct' with z.string().transform(Number)` →
  `// after: binding: 'adapted', id, adapters: { idFromStart, inputFor }`.

### Added

- **Existing-transport realtime binding.** `bindRealtimeClient` adds the same
  Zod event/ack validation and typed `request()` API to an existing Stitchkit
  Socket.IO transport without opening or lifecycle-owning another connection.
  `createRealtimeClient` now composes that one binding path.
- **Transport-projected and realtime conformance.** Manifest v2 snapshots
  explicit HTTP/MCP/Agent/CLI topology, finite named MCP surfaces, mounted
  presentation digests and named realtime contracts. `REALTIME` probes carry
  structured rejection fields and share one absolute setup/invoke/teardown
  deadline; fixtures and observed topology remain application-owned.
- **Multiple auth-domain composition.** `composeAuthHooks` routes only to owners
  of the selected scope, stages contributions until every owner succeeds,
  rejects cross-owner field collisions and derives the combined handler context.
- **Managed-file ownership and read inspection.** `createRoot: true` can create
  one final owned root below an existing trusted parent. Bounded inspection now
  applies to reads and writes, receives cancellation plus a finite
  `inspectionTimeoutMs`, and cannot replace measured path/size.
- **Canonical async-operation contracts and adapters.**
  `defineAsyncOperationContract` declares the standard start/status/wait plus
  optional cancel/result/artifacts HTTP vocabulary from one Zod-first config.
  Existing contracts with start snapshots or distinct follow-up envelopes bind
  through typed `idFromStart` and `inputFor` adapters whose outputs are parsed at
  the named capability boundary.

## [0.55.0] — 2026-08-20

### ⚠️ Breaking changes

- **`implementRemote` moved from `stitchkit/tools` to the peer-free
  `stitchkit/remote` entrypoint.** The broad tools barrel eagerly owns MCP and
  Agent surfaces; importing it solely for an HTTP proxy pulled their optional
  SDKs into thin CLI bundles. There is one canonical export and no compatibility
  alias. `// before: import { implementRemote } from 'stitchkit/tools'` →
  `// after: import { implementRemote } from 'stitchkit/remote'`.
- **Managed local-file tools now require one bound `ManagedFileBoundary`; raw
  host roots and paths are gone.** Download results are canonical relative
  `ManagedFileRef` values (`mediaType`, not `mimeType`), upload callbacks receive
  bounded `{ ref, bytes }`, and view-file takes `files` instead of `baseDir`.
  This makes containment, streaming limits and atomic cleanup one framework
  invariant instead of consumer convention.
  `// before: defineDownloadTool({ defaultDir, dirFromInput, ... })` →
  `// after: defineDownloadTool({ files: await createManagedFileBoundary({ root }), pathFromInput, ... })`;
  `// before: defineUploadTool({ upload: (path) => upload(path), ... })` →
  `// after: defineUploadTool({ files, upload: ({ ref, bytes }) => upload(bytes), ... })`;
  `// before: defineViewFileTool({ baseDir, ... })` →
  `// after: defineViewFileTool({ files, ... })`. The same config cut applies to
  raw `mountDownload`, `mountUpload` and `mountViewFile`.
- **Auth predicate returns are now strict.** Only `false`, `true`, or a validated
  plain-object context contribution is accepted; legacy `undefined`, `null`,
  numeric/string falsy values and exotic objects now throw a stable framework
  error instead of being treated as authorization success.
  `// before: rule: async () => undefined // accidentally passed` →
  `// after: rule: async () => true // explicit pass, or false to deny`.
- **The low-level `SocketIOClient` structural contract gained required
  `emitWithAck`.** It is the native acknowledgement capability used by
  `RealtimeClient.request`; structural mocks/adapters that implement the whole
  low-level handle must provide it. Prefer narrow `Pick` mocks when only one
  capability is under test.
  `// before: const socket: SocketIOClient<S, C> = { connect, disconnect, on, emit, onConnectionChange, connected }` →
  `// after: const socket: SocketIOClient<S, C> = { connect, disconnect, on, emit, emitWithAck, onConnectionChange, connected }`.

### Added

- **Typed realtime request-response acknowledgements.** `RealtimeClient.request`
  is available only for events with an `ack` schema, infers the event tuple and
  validated response, uses Socket.IO's native `timeout().emitWithAck()`, rejects
  immediately while disconnected, and distinguishes stable timeout,
  disconnect, and invalid-ack classes. Invalid acks retain the existing
  `acknowledgement` / `onRejected` path. Long jobs and streaming remain separate
  correlated events, not an RPC layer.
- **CLI help now names accepted positional arguments.** Per-command usage and
  argument rows derive required/optional positional forms from the same schema
  order used by argv parsing, for both contract-derived and native commands;
  boolean fields remain flag-only.

- **Async auth context contributions.** Sync/async auth rules may return typed
  fields from their authorization lookup; `AuthScopes` derives required versus
  optional guarantees and one atomic safe merger protects runtime-owned keys.
- **Ordered lifecycle composers.** `composeLifecycleHooks` and
  `composeToolLifecycle` preserve existing short-circuit, fallthrough,
  transformation, error and cancellation semantics without a middleware engine.
- **Transport conformance kit.** `stitchkit/testing` now builds deterministic
  topology/schema manifests, compares real discovery and runs bounded explicit
  HTTP/MCP/Agent/CLI probes without owning application startup or credentials.
- **Managed file boundary.** Peer-free `stitchkit/files` provides opened-handle
  capped reads, abort-aware streaming writes, atomic reject/replace commits,
  bounded content inspection and transport-safe `ManagedFileRefSchema` values.
- **Composable async-operation protocol.** Runtime-only descriptors and
  contract-backed binders link start/status/wait with optional
  cancel/result/artifacts while application storage, queues, transitions and
  resource authorization remain explicit. Wait now uses one monotonic absolute
  deadline; HTTP, MCP and Agent forward cancellation, and CLI accepts an
  explicit caller signal.

### Fixed

- **Async-operation `wait` now honours its own capability identity.** A
  configured `scopes.wait` reaches authorization, and lifecycle/audit action is
  consistently suffixed as `<operation>.wait`, matching status/cancel/result.
- **Contract-backed async-operation keys are schema-compatible at compile
  time.** Follow-up inputs must match the start output type and wait output must
  match status; runtime identity checks remain a defence for untyped calls and
  now name the failing capability plus the shared-instance requirement.
- **Runtime-owned context names cannot be shadowed by route params.** The shared
  reserved set now also filters `files`, `signal` and `mcp`; routes using those
  parameter names must rename them because those fields belong to the transport
  context.

- **CLI `--wait` no longer reports a terminal domain failure as success.** An
  optional `CliWaitConfig.failed(result)` predicate stops polling, emits a
  structured `WAIT_FAILED` error with the terminal payload in `details.result`,
  and returns a non-zero exit. It is checked before `done`, including on the
  initial result; transport errors and `TIMEOUT` keep their existing codes.
- **Unix listener regular-file errors now name the safe next step.** Stitchkit
  still refuses to unlink a non-socket path, but the error explicitly suggests
  manual removal when the file is known debris.
- **`--json` now compacts structured failures as well as successes.** Success
  remains on stdout, failure remains on stderr, and either is one
  newline-terminated JSON record for line-oriented scripts. Default output
  remains pretty-printed; progress and CLI usage diagnostics remain plain text.

## [0.54.0] — 2026-08-20

### Added

- **Typed MCP call metadata on managed application context.** Contract and
  runtime-tool handlers, lifecycle, tool hooks and runtime-tool factories can
  read the same optional `context.mcp: McpCallContext` populated by the real
  HTTP/stdio SDK path. It includes the protocol era/method/tool, validated
  protocol/client information and multi-round fields. MCP `clientInfo` remains
  self-reported attribution — never auth, RBAC or tenant identity.
- **Managed generic native tool definitions.** `defineWaitTool`,
  `defineDownloadTool` and `defineUploadTool` produce ordinary typed
  `runtimeTools` for MCP and Agent, with stable identity, Zod validation,
  lifecycle/hooks, cancellation and unified introspection. Existing
  `mountWait` / `mountDownload` / `mountUpload` remain deliberate raw MCP
  adapters over the same neutral mechanics.
- **Managed multimodal view-file definition.** `defineViewFileTool` gives
  protected MCP and Agent surfaces one Zod-first operation with lifecycle,
  hooks, cancellation and default multimodal presenters. Managed and raw
  `mountViewFile` paths now share one SSRF/path-safe batch core, one total 20 MB
  budget and honest per-item failures; the raw mount keeps its content-only MCP
  envelope.
- **Pathless runtime tools on CLI.** `createCli({ runtimeTools })` executes
  definitions that explicitly include `'CLI'` through the same canonical tool
  runner, context, lifecycle/hooks, validation, collisions and introspection as
  contract commands. The undefined runtime exposure default remains MCP+Agent,
  and a runtime-only CLI needs neither MCP nor AI peers.
- **Typed CLI-only native commands.** `defineCliCommand` composes executable
  management commands with managed commands in one help/router/error boundary
  without inventing tool identity or exposing them to MCP/Agent. The new
  `resolveAuth` and dynamic surface factories keep version, selected native
  commands and static help credential-free and lazily construct managed state.
- **Explicit stdio MCP signal lifecycle.** `bindStdioProcessSignals` owns one
  close-only `SIGINT`/`SIGTERM` chain, listener cleanup, phased error reporting
  and truthful default-disposition escalation on a later signal. It installs
  nothing implicitly, invents no force/grace result and never calls
  `process.exit()`.

## [0.53.2] — 2026-08-19

### Fixed

- **`createCli` reads piped stdin only for a REQUIRED unset field.** It used
  to await stdin for the *first* unset non-boolean field even when that field
  was optional — and in an agent's shell stdin is routinely an open pipe with
  no EOF, so a plain `app cmd --json > file` on a command with optional
  arguments hung forever. Commands whose remaining unset fields are all
  optional now never touch stdin. Reported by a consuming project's CLI
  (reproduced with `< /dev/null` finishing in 0.7 s while the same call hung
  without it).
- **CLI output is written synchronously — no more 64 KB truncation.** The
  default stdout/stderr writers used the async `process.stdout.write`, and
  the `process.exit` right after a print cut anything past the pipe buffer at
  exactly 65536 bytes. The defaults now `writeSync` to the fd (with the async
  writer as a fallback), so a payload of any size survives exit.

## [0.53.1] — 2026-08-18

### Fixed

- **`ApiError.is` is brand-based — the `ApiError → AppError` conversion in
  `implementRemote` works across build chunks.** The published dist carries
  `ApiError` in both the browser and the server chunk; the old `instanceof`
  check never matched an instance from the other chunk, so the conversion
  branch was dead and **every remote failure flattened to
  `INTERNAL_SERVER_ERROR`** with a raw "unhandled error" log — differentiated
  consumer exit codes were unreachable. `ApiError.is` now checks
  `Symbol.for('stitchkit.ApiError')`, exactly as `AppError` has since ADR
  0032 (this also covers mixed-version graphs). Reported and diagnosed by a
  consuming project's CLI.
- **`transformArgs` errors are normalized too** — the hook now runs inside the
  same try as the forwarded call, so an `ApiError` thrown while transforming
  (e.g. an upload through the same client) converts instead of leaking raw.
- **`AppError` carries an optional `traceId`** (additive 6th constructor
  parameter) and the `implementRemote` conversion preserves the `ApiError`'s
  `x-request-id` trace — it no longer vanishes at the boundary. `toJSON()` is
  unchanged: the trace stays metadata, not envelope.

## [0.53.0] — 2026-08-18

### ⚠️ Breaking changes

- **Realtime `emit` reports acceptance: its declared return type is now
  `boolean`, not `void`** — `true` = handed to the transport (not a delivery
  guarantee), `false` = dropped because the browser client was disconnected.
  Every *call site* keeps compiling and behaving identically (a
  boolean-returning function is assignable wherever a void one was expected);
  what breaks is the reverse direction — **code that implements or mocks**
  `SocketIOClient`, `RealtimeClient`, `ValidatedRealtimeSocket` or the
  `RealtimeServer` emit surface with a void-returning `emit`. The previous
  signature let a caller wait out a full response deadline on a message that
  was silently never sent.
  `// before: emit: () => {}` → `// after: emit: () => true`
  Server-side emits always return `true` (an empty room is not a drop).

### Added

- **Unix domain sockets are a first-class transport.**
  `createServer({ unix: '/run/app.sock' })` (or `{ path, mode }` to tighten
  the socket file mode — `0o600` when access to the socket is the credential)
  listens on a socket file instead of TCP; `unix` is mutually exclusive with
  `port`/`hostname`. Stale-socket hygiene is built in: a socket file left by a
  killed process is probed and reclaimed, while a live listener, another
  user's socket, or a plain file at the path fail loudly instead of being
  unlinked. A clean shutdown removes the file. On the client,
  `createHttpClient({ unix })` dials the same door with the full typed client
  (Bun runtime; `baseUrl` stays the path/prefix source). The Socket.IO
  lifecycle cannot mount on a unix listener (socket.io clients dial TCP only),
  and `stitchkit/node` does not offer `unix` (srvx always resolves a numeric
  port — no half-support). New exported type: `UnixListenConfig`. The first
  consumer had to drop to `createHandler` + hand-rolled `Bun.serve({ unix })`
  and raw `fetch` for exactly this.
- **Typed handshake identity gate** —
  `createSocketIOServer({ handshake: { schema, verify? } })` Zod-validates
  `socket.handshake.auth`, runs an optional (async-safe) `verify`, and puts the
  result into `socket.data` typed end-to-end: through the handle,
  `bindRealtimeServer`, and into `connection.raw.data` at `onConnection`. A
  throwing/`null` verify rejects before the connection handler with
  `err.data.code === 'handshake_rejected'` (a thrown error's raw message is
  logged server-side and never crosses to the unauthenticated peer).
  Registered as the first
  middleware, so app `io.use(...)` gates see typed data. New exported type:
  `SocketIOHandshakeConfig`. The consumer that asked had `String(raw.data.x)`
  coercions scattered across five files. (ADR 0079)
- **`onConnectError` on the Socket.IO client** — handshake/connection failures
  (`connect_error`) are now observable, with `terminal: true` marking a
  rejection socket.io will not retry (a handshake-gate rejection is terminal —
  the previous wrapper left the client silently dead with `connect()`
  swallowed by the idempotence guard). On a terminal error the connection
  intent resets, so rotate-the-token → `connect()` recovers and re-reads a
  function-form `auth`.
- **`onDroppedEmit` on the Socket.IO client** — one central observer for every
  emit dropped while disconnected (including the lazy-load window right after
  `connect()`), complementing the new `boolean` return of `emit`.

## [0.52.0] — 2026-08-17

### Added

- **`createScopedImplement(...).declare(contract)(handlers)`** — contextually
  typed handlers WITHOUT binding, for the registry path where binding happens
  once in `createScopedImplementRegistry`. The first registry adopter had to
  hand-write this exact helper to keep its service files typed; a stray or
  missing handler now fails at the declaration, where the author is, not at the
  faraway registry bind.

### Fixed

- **Registries accept the same prefix under different scopes.** The fail-first
  duplicate check keyed on the prefix alone and rejected a legal,
  mounted-in-production shape — two contracts sharing a prefix whose group
  scopes are separated by `scopePrefixes` (an `activity` pair for `project` and
  `admin`). It now keys on (scope, prefix); a same-scope duplicate still fails
  at construction, and the error names the scope. A consumer's six services no
  longer have to live outside the registry in a hand-maintained block.

## [0.51.0] — 2026-08-17

### Added

- **The scope map derives from the auth hook.** A rule may take the form
  `{ rule, inject }` where `inject(identity, ctx)` returns the fields the scope
  contributes; the hook merges them into the context, and
  `createScopedImplement<AuthScopes<typeof hook>>()` consumes the derived map —
  one declaration fills the context and types the handlers, so the map cannot
  drift from the hook. A `'public'` rule's fields come out optional (public
  admits the anonymous caller; it still resolves and injects the logged-in one).
  A rule whose type merely ADMITS `'public'` (a union) also derives optional
  fields, and `inject` must be synchronous — a thenable is a compile error and a
  runtime throw, since merging a Promise would merge nothing. Requires the
  identity generic to be inferred; the hand-written map stays as the fallback.
  → ADR 0078
- **`listContractToolNames(contracts)`** (`stitchkit/tools`) — the tool-name
  baseline straight from contracts. Names, kinds and exposure are deterministic
  contract facts, so a surface snapshot no longer needs stub services — or the
  untyped `createImplement<RuntimeContext>()` escape factory a consumer kept
  around to build them. Entry-for-entry equal to `listToolNames` over the
  implemented services — structurally (both read only the mounted method
  definitions) and pinned by a deep-equality test.
- **Registry results carry their keys.** `implementRegistry`,
  `createImplementRegistry` and `createScopedImplementRegistry` still return the
  mount-ordered `ServiceDef[]`, and the same services now also ride under
  `.byKey`, typed by the registry's literal keys (`KeyedServices`). The property
  is **non-enumerable**, so `Object.keys` / `Object.values` / spread of the
  array are byte-identical to before. Keys are load-bearing where a consumer
  filters its tool surface per caller; dropping them forced a silent
  hand-rebuilt prefix lookup.

### Fixed

- **The deployment guide documents the composite `ShutdownTarget`.**
  `bindProcessSignals` always accepted any `Pick<ManagedServerHandle,
  'shutdown'>`, but the guide never showed a multi-domain shutdown composing its
  parallel drains under the binding's signal machine — the first consumer with
  one read the primitive as transport-only and kept a hand-written machine. The
  guide now shows the composite target, the application-side hard-exit timer
  (`process.exitCode` cannot fire while a stuck resource holds the event loop),
  and an explicit "when NOT to use" list.

## [0.50.0] — 2026-08-17

### ⚠️ Breaking changes

- **`createContractFactory<Scope>()` now holds the per-endpoint `scope` to the
  same union.** The contract-level scope was typed since the factory shipped,
  while a per-endpoint override stayed a free string — exactly where overrides
  are densest. A typo there minted a scope no auth rule matched, surfacing as a
  fail-closed runtime throw on the first request instead of a compile error.
  Plain `defineContract` is unchanged: its endpoint `scope` stays a free string.

  ```ts
  const { defineContract } = createContractFactory<'public' | 'user' | 'admin'>()
  // before: compiled, then threw `no rule for scope "admn"` at request time
  // after:  Type '"admn"' is not assignable to type
  //          '"admin" | "public" | "user" | undefined'. Did you mean '"admin"'?
  defineContract({ prefix: 'posts', scope: 'user' }, {
    purge: { method: 'DELETE', path: '/all', desc: 'Purge', scope: 'admn', output },
  })
  ```

- **A `defineErrors` registry that already declared a `message` now sends it.**
  The key was accepted before (excess-property checking does not fire through a
  `const` generic) and silently ignored, so such a code put its own name on the
  wire; it now puts the declared text there — on HTTP, and on the tool path for a
  code that declares no `details` schema (its model-facing `details` is filled
  with `{ message }`). Registries that declare no `message` are unaffected.

  ```ts
  const { errors } = defineErrors({ GONE: { status: 410, message: 'Long gone' } })
  // before: errors.GONE().message === 'GONE'      — the key was ignored
  // after:  errors.GONE().message === 'Long gone'
  // tool envelope, before: { error: 'GONE', details: { message: 'GONE' } }
  // tool envelope, after:  { error: 'GONE', details: { message: 'Long gone' } }
  ```

### Added

- **`defineErrors` definitions accept a `message`.** Declare a code's text once
  beside its status instead of repeating it at every `throw`; a per-call
  `message` still wins, and a code without one keeps falling back to the code
  itself. `definitions[code].message` is readable by a `code` variable. The text
  reaches HTTP and the typed client; the model-facing tool envelope gains no
  `message` field, but a code with no `details` schema still delivers it as
  `details.message` — the guide tabulates both halves and tests pin them. `hint`
  is intentionally not accepted: it would duplicate against a surface-wide
  `ErrorHintFn`. → ADR 0077
- **`createScopedImplement<Scopes>()`** (`stitchkit/server`) — one scope→context
  map for the application, and every handler is typed by its endpoint's
  **effective** scope (`endpoint.scope ?? contract scope`) instead of one
  superset context that promises a `userId` a `public` handler never receives.
  A contract may mix scopes across its endpoints; a scope outside the map is a
  compile error naming that scope. The map is type-only — there is no runtime
  argument and no cast at the call site. A field of another scope degrades to
  `unknown` rather than erroring on access (`RuntimeContext` keeps its index
  signature), so it can no longer pose as a typed value. → ADR 0075
- **`createScopedImplementRegistry<Scopes>()`** (`stitchkit/server`,
  `stitchkit/node`) — the registry form of the same map, so moving from a hand-written
  service list to one contract registry no longer costs per-scope typing. Missing,
  extra and endpoint-incompatible entries fail exactly as in `implementRegistry`.
- **`bindProcessSignals(handle, options)`** (`stitchkit/server`, `stitchkit/node`) —
  the signal state machine every application was rewriting, as one explicit opt-in
  call. The first signal runs `onShutdown` then one `shutdown()`; a later signal
  forces **that** chain (the only channel a running shutdown has, since its options
  are parsed once), while signals delivered in the same turn as the first are not
  counted so a supervisor sending two at once does not collapse the grace period.
  A signal during asynchronous preparation is no longer lost, and a failing
  preparation no longer cancels the shutdown. Failures are routed by phase through
  `onError('prepare' | 'shutdown' | 'complete', …)`, and nothing escapes into a
  signal handler. The signal after the force re-delivers itself so the default
  disposition applies — best-effort, since another listener in the process would
  swallow it, which is reported through `onEscalationBlocked`. The framework
  registers no listener of its own and never calls `process.exit` — set
  `process.exitCode` in `onComplete`. → ADR 0076
- **`createMultipartStream<Ctx>()`** and **`createScopedImplement(...).stream(scope, …)`**
  (`stitchkit/server`, `stitchkit/node`) — a streaming multipart handler can finally
  read the context its application injects. `defineMultipartStream` pinned the loose
  `RuntimeContext`, so `createImplement<Ctx>()` never reached a streaming handler
  either. The scoped form requires the endpoint to declare its own `scope` and
  accepts only that literal. Plain `defineMultipartStream` is unchanged.

## [0.49.2] — 2026-08-15

### Fixed

- Published guide and generated agent documentation no longer freeze a stale
  test count, and a regression guard rejects removed split-ownership server
  lifecycle snippets from current-facing docs. Historical before/after migration
  examples remain isolated in the upgrading guide.

## [0.49.1] — 2026-08-15

### Added

- Managed shutdown options now include `forceTimeoutMs` (default `5_000`) so a
  runtime that cannot confirm destructive transport closure rejects within an
  explicit bound instead of leaving the shared shutdown Promise pending.

### Fixed

- Forced Bun WebSocket shutdown now retains every tracked socket until Bun's
  server-side `close` callback. The result no longer manufactures a physical
  zero by clearing its tracker, and the stopped listener is verified separately
  from Bun 1.3.14's non-settling post-upgrade `stop(true)` Promise.
- Realtime or graceful-runtime close failures now run forced transport cleanup
  before rejection. If cleanup also fails, both errors remain available instead
  of masking the original phase failure.
- Exact-SHA GitHub CI now runs the real Next.js 16.3 production SSR retry smoke
  before packing release artifacts, and the managed-shutdown subprocess proves
  that a second real OS signal forces the existing lifecycle chain.
- The raw WebSocket composition example and canonical starter now pass the full
  managed Socket.IO handle without manually mounting its route or splitting
  shutdown ownership.

## [0.49.0] — 2026-08-15

### ⚠️ Breaking changes

- **Bun `createServer()` and Node `serveNode()` now return managed handles.**
  The server owns admission, accepted HTTP drain, Socket.IO/raw WebSocket
  closure and one deadline-bounded runtime stop. The runtime-specific instance
  remains under `.runtime`; shutdown uses the shared result-bearing method.
  `// before: server.stop(); await socket.io.close()` →
  `// after:  await server.shutdown({ gracePeriodMs: 30_000 })`
- **Socket.IO is mounted through the full `socket` handle.** This gives the
  server one owner for route, WebSocket/Node attachment and closure. For a raw
  Bun lane, keep the composed `websocket` handler and pass `socket` beside it.
  `// before: createServer({ websocket: socket.websocket, rawRoutes: [socket.route] })` →
  `// after:  createServer({ socket })`
- **Bun native `routes` are removed from `BunServerConfig`.** Native routes run
  before the Fetch handler and bypass managed admission. Move them to explicit
  framework routes.
  `// before: createServer({ routes: { '/health': () => Response.json({ ok: true }) } })` →
  `// after:  createServer({ rawRoutes: [{ method: 'GET', path: '/health', handler: () => Response.json({ ok: true }) }] })`
- **Socket.IO handshake policy moves out of the Node-shaped passthrough.** The
  shared policy now receives a Web `Request` and is composed with shutdown
  admission on both Bun and Node.
  `// before: createSocketIOServer({ serverOptions: { allowRequest: (req, done) => done(null, allowed(req)) }, ... })` →
  `// after:  createSocketIOServer({ allowRequest: (request) => allowed(request), ... })`

### Added

- Added Zod-first shutdown option/status/result schemas, live status counters,
  literal Promise idempotency, shared deadline/AbortSignal semantics and clean
  versus forced evidence for Bun and Node.

### Fixed

- Ky retries inside Next.js 16 SSR now bypass a memoized first-attempt rejection
  only from the second attempt onward. The first attempt keeps Next fetch
  memoization; retry calls preserve Ky's request fields and future `init`
  extensions while materializing URL + init so the current signal survives
  Next 16.3's Request-merge stage and reaches its dedupe boundary.
- Managed Node servers now force the `srvx/node` adapter, disable srvx's hidden
  process-signal lifecycle and destroy tracked upgraded TCP sockets on a forced
  shutdown. Socket.IO remains the sole graceful close owner when attached.

## [0.48.1] — 2026-08-14

### Added

- Added `implementRegistry` / `createImplementRegistry` so one literal contract
  registry type-checks the complete backend implementation registry.
- Added `stitchkit/testing` with in-process generated clients over a real Fetch
  handler, including scoped, multipart, cancellation and error-correlation paths.
- Added immutable observability status counters and a final drain report from
  `close()` for readiness, metrics and shutdown diagnostics.
- Added a one-argument `buildMcpServer(config)` form for no-auth MCP servers.

### Fixed

- Bun `ConnectionRefused` fetch failures now follow the configured safe HTTP
  retry budget for allowed methods; domain errors, HTTP responses,
  cancellation and timeouts retain their existing semantics.
- Raw-route construction now fails first on exact/shape duplicates and fully
  shadowed later routes while preserving legal specific-before-wildcard order.
- Strict MCP schema guidance now distinguishes arbitrary JSON (`z.json()`) from
  a genuinely unrepresentable unknown presentation value.

## [0.48.0] — 2026-08-14

### ⚠️ Breaking changes

- **Generated HTTP request options move to `.withOptions`.** The optional second
  positional parameter conflicted with callback contexts supplied by
  `react-query-kit` and TanStack Query. Ordinary methods now contain only
  contract variables and can again be passed directly as `mutationFn` or
  `fetcher`; imperative cancellation uses the callable's explicit method.
  `// before: api.create(args, { signal }); api.health({ signal })` →
  `// after: api.create.withOptions(args, { signal }); api.health.withOptions({ signal })`

### Fixed

- Restored compile-time and runtime-safe direct composition of plain, batch and
  scoped generated clients with `react-query-kit` query and mutation callbacks.

## [0.47.0] — 2026-08-14

### ⚠️ Breaking changes

- **HTTP authorization has its own pre-body lifecycle phase.** Wire
  `createAuthHook()` to `hooks.authorize`; `beforeHandle` remains the
  post-validation application-precondition phase. Tool transports still use the
  same hook through their `lifecycle.beforeHandle` because their input has
  already crossed the transport boundary.
  `// before: createServer({ hooks: { beforeHandle: auth } })` →
  `// after:  createServer({ hooks: { authorize: auth } })`
- **Multipart contracts use one typed descriptor.** The string field name,
  top-level `maxUploadBytes` and `ctx.file` are removed. Declare every file
  field, cardinality and byte policy under `multipart`, then read the inferred
  `ctx.files` map. The typed client uses the same scalar/array shape.

  ```ts
  // before
  upload: { method: 'POST', path: '/', multipart: 'file', maxUploadBytes: 10_000_000 }
  upload: ({ file }) => save(file)

  // after
  upload: {
    method: 'POST',
    path: '/',
    multipart: {
      maxRequestBytes: 10_000_000,
      files: { file: { maxBytes: 10_000_000 } },
    },
  }
  upload: ({ files }) => save(files.file)
  ```

### Added

- **Fetch-clean streaming multipart receivers.** `delivery: 'stream'` and
  `defineMultipartStream()` route each file part directly into a
  consumer-owned Web Stream receiver. Receiver handles are available only after
  complete text-field validation, and registered cleanups run exactly once in
  reverse order on parse, validation, receiver or handler failure.
- **Per-call typed-client cancellation.** Every generated HTTP method accepts
  `ClientRequestOptions` with an `AbortSignal`; caller cancellation and timeout
  are normalized as `REQUEST_ABORTED` and `REQUEST_TIMEOUT` in both the bare
  Fetch and Ky-backed clients.
- **Managed observability sink lifecycle.** Request and tool sinks support
  bounded `maxPending`, isolated `onSinkError`/`onDrop` diagnostics, generation
  aware `flush()` and idempotent draining `close()` without blocking observed
  business calls.

## [0.46.0] — 2026-08-10

### ⚠️ Breaking changes

- **`STITCH_ERROR_STATUS` gained `REALTIME_CONTRACT_VIOLATION`** — realtime
  contract failures use the framework error model instead of a bare `ZodError`.
  An exhaustive `satisfies Record<StitchErrorCode, …>` code map no longer
  compiles until the new code is added.
  `// before: { …, INTERNAL_SERVER_ERROR: 'internal' } satisfies Record<StitchErrorCode, string>` →
  `// after:  { …, INTERNAL_SERVER_ERROR: 'internal', REALTIME_CONTRACT_VIOLATION: 'internal' } satisfies Record<StitchErrorCode, string>`
- **`RealtimeRejectedEvent.error` is an `AppError`, not a `z.ZodError`** — the
  rejection envelope carries `reason` and `fault`, and the original `ZodError`
  (when one exists) moves to `error.cause`.
  `// before: onRejected: ({ error }) => error.issues` →
  `// after:  onRejected: ({ error }) => error.details?.issues (cause: error.cause)`
- **CLI construction is strict about reserved names.** A contract field or tool
  named `json`, `wait`, `quiet`, `dry-run`, `help`, `version`, `wait-timeout` or
  `output-dir` now **throws while building the CLI** instead of being silently
  shadowed; unknown flags, repeated scalar flags, a plain flag combined with a
  dotted flag over the same root, and `--json=<junk>` all exit non-zero instead
  of corrupting arguments.
  `// before: app schedule_job --wait 2h  → {"path":"2h"}, exit 0` →
  `// after:  building a CLI over a contract with a "wait" field throws`
- **`createToolLogger` writes to `console.error` by default** (stderr). stdout
  is the JSON-RPC channel of a stdio MCP server, and the old `console.info`
  default corrupted it. Pass `log` to redirect.
  `// before: createToolLogger() → stdout` → `// after: createToolLogger() → stderr`
- **An origin-less `cors` config is a construction error, not a wildcard.**
  `createServer({ cors: {} })` and `cors: { origin: undefined }` used to emit
  `Access-Control-Allow-Origin: *`; a missing security setting no longer picks
  the most permissive behaviour. Allowing every origin stays available as an
  explicit opt-in.
  `// before: cors: {}  → Access-Control-Allow-Origin: *` →
  `// after:  cors: { origin: '*' }  (explicit), cors: {} throws`
- **JSON coercion skips unions with any string member.** A tool argument
  declared `z.union([z.string()…, T])` (including constrained strings: `uuid`,
  `email`, `min`) receives the raw string; a double-serialized value is only
  repaired when NO union member accepts a string. Identifiers such as `"123"`
  or `"null"` can no longer silently change type.
  `// before: union[uuid, number] + "123" → 123` →
  `// after:  union[uuid, number] + "123" → validation error on the string`
- **Default audit masking matches whole words.** `sanitizePayload`/`redact`
  mask a key when one of its words is a secret term (`sessionToken`,
  `X-Api-Key`), and keep identifiers that merely contain one (`authorId`,
  `sessionCount`, `tokenizer`) — previously matching was substring-based and
  destroyed audit identifiers. Pass `sensitiveKeys` to restore any custom
  policy.
  `// before: authorId → "[redacted]"` → `// after: authorId survives, sessionToken → "[redacted]"`

### Added

- **Bounded in-memory state.** `createCache({ maxEntries })` and
  `createCacheBridge({ maxFreshKeys })` use deterministic oldest-first eviction;
  cache bridges expose `clearFresh()` and expire markers at the end of their
  freshness window.
- **Directly testable MCP preparation.** Immutable MCP descriptors are prepared
  by a dedicated module while the public `stitchkit/tools` surface remains
  unchanged.
- **Structured realtime contract failures.** Rejections identify event,
  direction, phase and local/peer fault through the registered
  `REALTIME_CONTRACT_VIOLATION` error code and `StitchLogger`.

### Fixed

- **Realtime rooms and reconnect recovery.** Server, connected-socket and
  emit-only room targets now resolve only the capabilities they use; manual
  `connect()` recovers after Socket.IO exhausts its automatic retry budget.
- **Fail-closed endpoint ownership.** MCP Host/Origin checks, implementation
  lookup, auth middleware and object registries reject prototype-chain and
  missing-handler fallthroughs.
- **Model-controlled I/O is bounded.** Guarded fetches enforce one header
  deadline across DNS and every redirect hop plus a separate body deadline
  (`ViewFileOptions.timeoutMs`, `DownloadToolConfig.timeoutMs`,
  `CliConfig.downloadTimeoutMs`); `view_file` caps the number of requested
  targets, charges its byte budget by what was actually read and never
  downloads a `video/*` body.
- **Observability cannot break observed work.** Audit projection, sanitization,
  size measurement and async sinks tolerate bigint, cycles, unreadable getters
  and sink failures; trace sampling flags are preserved exactly.
- **Browser response parity.** Blob failures follow the same `ApiError` and
  `network_error` normalization path as JSON and raw-response requests.
- **CLI parsing is strict.** Reserved-name collisions, misplaced positional
  arguments, unknown flags and unsupported options fail with direct diagnostics;
  stdio defaults never write logs into the JSON-RPC channel.
- **MCP/OAuth policy validation.** MRTR policy is validated while building the
  surface, audit rows carry round/outcome metadata, and CIMD resolution has
  strict HTTP caching plus two-level rate limits
  (`CimdCachePolicy.maxResolutionsPerClient` / `maxResolutions` per
  `resolutionWindowMs`) with separate positive/negative cache pools, so a flood
  cannot evict warmed clients and one client cannot lock out the rest.
- **Contract presentation correctness.** JSON coercion no longer corrupts
  string unions, query dehydration retains successful prefetched data, SSE
  cancellation is quiet while generator failures remain visible, and static
  routes reject symlinks escaping their declared root.

## [0.45.0] — 2026-08-10

### Added

- **Zod-first realtime contracts over Socket.IO.** `defineRealtimeContract`
  describes variadic event tuples and acknowledgements once;
  `bindRealtimeServer` and `createRealtimeClient` infer both event maps and
  validate inbound arguments, outbound payloads and acknowledgement values.
  Handshake auth, rooms and delivery policy remain application-owned, while
  durable subscriptions, retained events and the cache bridge keep their
  existing Socket.IO behavior.

## [0.44.1] — 2026-08-10

### Documentation

- **Clarified dual-era MCP output semantics.** The migration guide and 0.44.0
  release notes now distinguish exact JSON roots on protocol `2026-07-28` from
  the official legacy codec's `{ result: value }` adaptation, with a pinned
  consumer E2E example for both eras.

## [0.44.0] — 2026-08-10

### ⚠️ Breaking changes

- **MCP uses the split TypeScript SDK v2 packages and a closeable stateless
  handler.** Replace `@modelcontextprotocol/sdk` with
  `@modelcontextprotocol/server@^2` for server surfaces and
  `@modelcontextprotocol/client@^2` only for hosts/tests. `createMcpHandler`
  now returns `{ fetch, close }`; mount it through `createMcpHttpRoute` and
  close it during graceful shutdown. HTTP session modes, event stores and
  `Mcp-Session-Id` continuity are removed.

  ```ts
  // before
  const handleMcp = createMcpHandler({ ...config, sessionMode: 'stateless' })
  rawRoutes: [{ method: 'ALL', path: '/mcp', handler: handleMcp }]

  // after
  const mcp = createMcpHandler({ ...config, legacy: 'serve' })
  rawRoutes: [createMcpHttpRoute({ path: '/mcp', handler: mcp })]
  await mcp.close()
  ```

- **Stdio servers return an owned transport handle.** Keep and close the result;
  `legacy: 'serve' | 'reject'` controls official protocol-era negotiation.

  ```ts
  // before
  await createStdioMcpServer(config)

  // after
  const stdio = await createStdioMcpServer({ ...config, legacy: 'serve' })
  await stdio.close()
  ```

- **OAuth client registration is one explicit policy object with CIMD as the
  default.** Move application-owned clients under `clientRegistration`.
  Dynamic Client Registration is disabled unless `dcr` is supplied, and only
  then appears in discovery or mounts `/register`.

  ```ts
  // before
  mountOAuthProvider({ ...config, clients })

  // after
  mountOAuthProvider({
    ...config,
    clientRegistration: {
      preRegistered: { get: clients.get },
      // optional: dcr: { register: clients.register, get: clients.get }
    },
  })
  ```

- **OAuth consent returns the scopes it actually approved.** `authorizeUser`
  must return `approvedScopes`; token issuance no longer assumes that every
  requested scope was approved. Missing or malformed values fail loudly at the
  boundary.

  ```ts
  // before
  authorizeUser: async () => ({ userId })

  // after
  authorizeUser: async (_req, request) => ({
    userId,
    approvedScopes: request.scope?.split(' ') ?? [],
  })
  ```

- **MCP non-object outputs keep their declared JSON shape in the modern
  protocol.** MCP `2026-07-28` permits any JSON root value, so Stitchkit no
  longer adds an artificial `result` property on that wire path. When
  `legacy: 'serve'` negotiates a supported older era, the official SDK codec
  still adapts a non-object value to `{ result: value }`.

  ```ts
  // before: structuredContent === { result: ['a', 'b'] }
  // modern 2026-07-28: structuredContent === ['a', 'b']
  // supported legacy:  structuredContent === { result: ['a', 'b'] }
  ```

### Added

- **MCP `2026-07-28` transport semantics.** HTTP and stdio use official v2
  factories, support deterministic modern discovery, explicit cache hints,
  strict Host/Origin and protocol-header validation, cancellation and one
  optional legacy stateless boundary without a parallel framework transport.
- **Typed multi-round `input_required`.** Contract and runtime tools can declare
  a Zod input gate. Signed continuation state is bound to principal, operation
  and original arguments; accepted content reaches `ctx.mcpInput`, while every
  attempt retains isolated context, lifecycle and tool hooks.
- **Client ID Metadata Documents.** OAuth resolves pre-registered clients, then
  SSRF-safe HTTPS CIMD, then explicitly enabled DCR. Metadata fetching is
  DNS/IP-pinned, size/time/redirect bounded and backed by a bounded HTTP-aware
  cache.
- **Exact MCP JSON output schemas.** Object, array, string, number, boolean and
  nullable contract/runtime outputs are advertised and returned unchanged;
  tools without an output contract emit neither `outputSchema` nor
  `structuredContent`.
- **MCP OpenTelemetry propagation.** Framework-owned contract and runtime tools
  continue SDK v2 request `_meta.traceparent`, retain bounded `tracestate` and
  `baggage` in the isolated request context, and expose one consistent trace to
  handlers, hooks and audit on HTTP and stdio. MCP metadata wins over an
  ambient HTTP trace when present; malformed values start a fresh local trace
  without becoming authentication input.

## [0.43.1] — 2026-08-09

### Fixed

- **Browser `ApiError` preserves backend request correlation.** Both the bare
  contract client and the Ky-backed HTTP client now expose a response's
  `x-request-id` as readonly `error.traceId`, including their unstructured
  non-2xx fallbacks. Network and abort errors without an HTTP response leave
  the optional field undefined; the wire error envelope is unchanged.

## [0.43.0] — 2026-08-08

### ⚠️ Breaking changes

- **HTTP observability is framework-owned and wrapper-free.**
  `createObservability` replaces `createAuditHook`; request and tool sinks are
  configured independently. Pass the request projection directly to the server
  and the tool projection to mounts. HTTP payload capture is now off by default
  and explicit through `includePayload: true`.

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

  There is no `createAuditHook` alias or HTTP audit wrapper. Keep
  `includePayload` false when the request row does not need a body.

### Fixed

- **Flattened divergent tool fields retain every known JSON kind.** When a
  discriminated union reuses a property as different visible kinds, the flat
  MCP/Agent presentation now emits a sound deterministic `type` array instead
  of `{}`. Nested union branches contribute their base kind, nullability is
  preserved, `integer | number` widens to `number`, and genuinely unknowable
  branches remain visible to `requireTypedProperties`. Runtime Zod validation
  and unflattened schemas are unchanged.

- **`createContractFactory` now exposes its guaranteed scope as required.** A
  factory-defined contract's `meta.scope` is the exact concrete literal rather
  than `TScope | undefined`; plain `defineContract` keeps its optional/default
  public model. The new `ScopedContractDef` type names the stronger shape.

### Added

- **Context-validated runtime-tool factories.**
  `createRuntimeToolFactory({ serviceName, scope, context })` binds stable
  identity once and parses the Zod context once per invocation, so each
  definition's handler receives typed context plus parsed input without local
  adapters. The result remains an ordinary `RuntimeToolDefinition` for every
  mount, manifest and invoker.

- **Opt-in explicit contract tool exposure.**
  `createContractFactory<Scope>({ toolExposure: 'explicit' })` materializes a
  missing endpoint `expose` as `['HTTP']`; MCP, Agent and CLI surfaces then
  require an explicit declaration. Plain factories retain the default-on tool
  policy.

## [0.42.0] — 2026-08-08

### ⚠️ Breaking changes

- **Tool introspection now takes one mixed surface object.**
  `buildToolManifest`, `listToolNames` and `summarizeTransports` resolve contract
  services plus pathless runtime definitions through the same canonical
  collector as the mounts. `ToolNameEntry` adds its origin; transport summaries
  expose explicit contract/runtime counts and a mixed `sources` breakdown.

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

- **Managed MCP runtime tools are declarative; `nativeTools` is removed.** A
  protected `defineRuntimeTool` now belongs in the surface's `runtimeTools`
  array, so its schemas and presentation metadata can be prepared once. The
  deliberately unprotected SDK escape hatch is now the explicit `rawTools`
  callback.

  ```ts
  // before — protected registrar
  nativeTools: ({ registerTool }) => registerTool(preview)
  // after — protected immutable definition
  runtimeTools: [preview]

  // before — raw SDK opt-out
  nativeTools: ({ rawServer }, auth) => mountRaw(rawServer, auth)
  // after — raw SDK opt-out
  rawTools: (server, auth) => mountRaw(server, auth)
  ```

- **`defineErrors` now takes object definitions and returns constructors.**
  Each code declares `{ status, details? }`; the optional details schema is the
  runtime and TypeScript source of truth. Generated functions accept one named
  options object and return a literal-code `AppError` for the caller to throw.
  Positional throwers and numeric definitions are removed without aliases.

  ```ts
  // before
  const { errors } = defineErrors({ QUOTA_EXCEEDED: 429 })
  errors.QUOTA_EXCEEDED('Try later', { retryAfterSeconds: 30 }, 'Wait')

  // after
  const { errors } = defineErrors({
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

### Added

- **Unified contract/runtime introspection.** Mixed manifests use the exact
  immutable presentation schema advertised by MCP/Agent, honour transport
  filters, preserve mount order and fail first on cross-origin name collisions;
  name snapshots and boot summaries now include runtime identities too.

- **Async, endpoint-aware `createErrorHook`.** Its observer and renderer may now
  await identity/audit enrichment and receive the matched operation; failures
  before route resolution receive `undefined`. The observer completes before
  rendering, so the response can use the enriched request context.
- **Finite prepared MCP surface registries.** Declare bounded
  `{ services, runtimeTools }` entries under `surfaces` and select one with a
  typed `selectSurface(auth)` key. Every entry is validated and compiled once;
  each request/session still receives a fresh server, auth context, lifecycle
  runner and isolated tool-call context. Direct identity factories remain
  uncached for genuinely arbitrary surfaces.
- **Typed domain error definitions.** `defineErrors` exposes its frozen
  `definitions` registry, preserves literal codes and schema-parsed details on
  constructed `AppError` instances, and derives `codes` / `isCode` from the
  same source.

## [0.41.0] — 2026-08-07

### ⚠️ Breaking changes

- **Contract output presence now comes only from `output`.** A nullable output
  returns JSON `null` with status `200`; `undefined` for a declared output and
  non-null data without an output schema are handler contract violations on
  HTTP and tool transports. Typed clients return `null` for nullable output and
  `undefined` only for endpoints without output.

  ```ts
  // before: null was converted to 204 and then failed against the output
  result: { output: ResultSchema.nullable(), handler: () => null }

  // after: 200 application/json with body `null`
  result: { output: ResultSchema.nullable(), handler: () => null }
  ```

  A handler that intentionally returns data must declare its schema; a handler
  with no result must omit `output` and return `undefined` or `null`. Runtime
  tools without `output` now type their handler as void; add an output schema
  before returning neutral data.

## [0.40.0] — 2026-08-07

### ⚠️ Breaking changes

- **`createToolInvoker` runtime state is now per invocation.** The factory only
  compiles exposure, extension and argument-presentation policy; move
  `source`, `context`, `lifecycle`, `hooks` and `onOutputStrip` to the third
  argument of `invoke`. This prevents a reusable registry from retaining one
  request identity.

  ```ts
  // before
  const invoker = createToolInvoker(services, {
    transport: 'AGENT', context: { identity }, lifecycle, hooks,
  })
  await invoker.invoke(name, args)

  // after
  const invoker = createToolInvoker(services, { transport: 'AGENT' })
  await invoker.invoke(name, args, { context: { identity }, lifecycle, hooks })
  ```

### Added

- **Throwing in-process tool composition.** `invokeOrThrow` returns validated
  data or throws the runner's exact normalized `AppError`, preserving custom
  code/status/message/details/hint while unexpected errors remain scrubbed.
- **Literal-preserving scoped contract factory.** `createContractFactory`
  retains each contract's concrete scope literal while still constraining it to
  the application's allowed scope union, so scope-aware registries infer the
  exact config without a consumer wrapper.
- **Scope-aware URL builder registry.** `createScopedUrlBuilders` selects
  dynamic prefix configuration from each contract's literal scope and composes
  multiple contracts into one typed URL namespace, mirroring
  `createScopedClients` without duplicating the request planner.

## [0.39.0] — 2026-08-07

### ⚠️ Breaking changes

- **Protected native MCP handlers now return neutral output.** The MCP-only
  `NativeMcpToolDefinition`, `NativeMcpOperationIdentity`,
  `NativeMcpHandlerContext` and `NativeMcpResult` types are removed. Define a
  shared runtime operation; move MCP content and metadata into `present.mcp`.
  Stitchkit owns validated `structuredContent` and `isError`.

  ```ts
  // before
  registerTool({ input, output, handler: async () => ({
    content: [{ type: 'image', data, mimeType: 'image/png' }],
    structuredContent: { assetId },
  }) })

  // after
  const preview = defineRuntimeTool({
    input, output,
    handler: async () => ({ assetId, data }),
    present: {
      mcp: (result) => ({
        content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
      }),
    },
  })
  nativeTools: ({ registerTool }) => registerTool(preview)
  mountAgent(services, { runtimeTools: [preview] })
  ```

- **`createEntityCacheHandlers` now declares the real list shape and item
  projection.** The `listKey` shortcut and id-only `detailKey` callback are
  removed. This prevents an untyped helper from guessing cache envelopes,
  missing-update behavior or full-entity → list-item conversion.

  ```ts
  // before
  createEntityCacheHandlers<Entity>({
    getId, listKey: ['entities'], detailKey: (id) => ['entities', id],
  })

  // after
  createEntityCacheHandlers<Entity, EntityListItem>({
    getId,
    getListItemId: (item) => item.id,
    toListItem: projectEntity,
    list: {
      key: ['entities'],
      shape: 'paginated',
      createAt: 'start',
      updateMissing: 'skip',
    },
    detailKey: (event) => ['entities', event.id],
  })
  ```

- **Custom `HttpClient` adapters must implement `head`.** Contract-owned HEAD
  operations need an explicit transport primitive; the built-in
  `createHttpClient` already provides it.

  ```ts
  // before
  const http: HttpClient = { get, post, put, patch, delete, /* lifecycle */ }

  // after
  const http: HttpClient = { get, head, post, put, patch, delete, /* lifecycle */ }
  ```

- **Trailing wildcards are now named.** Bare `/*` and the magic `params['*']`
  key are removed. The name is shared by contract validation, router params,
  typed clients, raw routes and the OpenAPI extension.

  ```ts
  // before
  path: '/app/:slug/*'
  params: z.object({ slug: z.string(), '*': z.string() })
  ctx.params['*']

  // after
  path: '/app/:slug/*filePath'
  params: z.object({ slug: z.string(), filePath: z.string() })
  ctx.params.filePath
  ```

- **`HttpClientConfig.authEndpoints` is replaced by contract-derived expected-401
  matchers.** Broad manual prefix suppression could hide a real session expiry
  from a neighbouring endpoint. There is no default auth-path exception.

  ```ts
  // before
  createHttpClient({ baseUrl, authEndpoints: ['/api/auth/'] })

  // after
  createHttpClient({
    baseUrl,
    suppressUnauthorizedFor: contractEndpointMatchers(authContract, ['login', 'verify']),
  })
  ```

### Added

- **Framework-owned runtime tools for MCP and AI agents.**
  `defineRuntimeTool` describes a pathless operation once; protected MCP
  registration and `mountAgent({ runtimeTools })` share its identity, neutral
  handler, validation, lifecycle, hooks, audit and per-call context. Typed
  `present.mcp` and AI SDK `toModelOutput` adapters preserve multimodal content
  without a second execution engine. → ADR 0055

- **Entity cache adapters for real list shapes.**
  `createEntityCacheHandlers` now covers plain arrays, paginated lists and both
  infinite page forms; event-aware scoped keys, full-entity projection,
  explicit insertion/missing-update policies and backend-owned comparators stay
  type-safe while preserving page/envelope metadata. → ADR 0056

- **In-process contract tool invoker.** `createToolInvoker` compiles one
  exposure-aware name lookup and dispatches nested/parallel calls through the
  canonical tool runner—input/output validation, `ToolExtend`, lifecycle,
  hooks, isolation and output-strip reporting included—without mounting an AI
  SDK or MCP adapter.

- **Explicit contract-owned HEAD endpoints.** `method: 'HEAD'` is an HTTP-only
  `rawResponse` operation with normal routing, params, lifecycle/RBAC, logging,
  typed-client and OpenAPI coverage. GET never gains an implicit HEAD alias,
  and Stitchkit strips any accidental response body while preserving status
  and headers.

- **Scope-aware composed clients.** `createScopedClients` routes each contract by
  its typed `meta.scope`; arrays merge contracts into one namespace with
  fail-first duplicate detection.
- **URLs for every HTTP operation.** `createUrlBuilder` and
  `createUrlBuilders` now include POST, PUT, PATCH, DELETE and multipart
  operations. Body methods accept only scoped-prefix and path params; body/file
  fields are neither required nor silently serialized.
- **Contract-derived expected-401 policy.** `contractEndpointMatchers` compiles
  exact operation paths, including params, dynamic scoped prefixes and trailing
  wildcards, for `HttpClientConfig.suppressUnauthorizedFor`.
- **Named trailing wildcard params.** `/*filePath` captures a decoded,
  slash-joined remainder as `params.filePath`; clients segment-encode the same
  field and OpenAPI publishes its real name.

## [0.38.0] — 2026-08-07

### Added

- **Scoped batch clients and typed prefix callbacks.** `createClients` now
  accepts the same scoped third argument and transport choices as
  `createClient`; every registry entry keeps exact endpoint, multipart,
  raw-response and HTTP-exposure types. Keys in `stripPrefixKeys` also type the
  `pathPrefix` callback, so `({ tenantId }) => ...` needs no cast or coercion.
- **Contract-driven URL builders.** `createUrlBuilder` and `createUrlBuilders`
  synchronously generate absolute or relative links for HTTP-exposed,
  non-multipart GET endpoints. They reuse the exact request planner used by both
  typed-client transports, including scoped prefixes, named/trailing-wildcard
  params and flat query serialization. `createHttpClient` now returns the
  additive `ConfiguredHttpClient` subtype carrying its readonly `baseUrl`.
- **Typed JSON response metadata.** An HTTP-only endpoint may declare
  `responseMeta: { status? }`; its handler receives a fresh
  `ctx.response.headers` collector while still returning schema-validated data.
  Repeated `Set-Cookie` values survive Bun and Node, success metadata is
  discarded on errors, OpenAPI uses the declared 2xx status, and framework-owned
  framing/CORS/request-id headers cannot be replaced.

### Fixed

- **Contract routes now support a trailing `/*` wildcard.**
  `GET /app/:slug/*` matches nested paths, validates
  `{ slug, '*': remainder }` through the endpoint's `params` schema, respects
  specific-route precedence and returns 405 (not 404) for a wrong method. Both
  typed-client transports expand the `'*'` argument segment-by-segment, and the
  shared router decodes each segment back to its semantic handler value. OpenAPI
  marks the non-standard catch-all with
  `x-stitchkit-trailing-wildcard` instead of emitting an invalid path parameter.

## [0.37.0] — 2026-08-07

### ⚠️ Breaking changes

- **Executable flatten helpers are replaced by a presentation-only compiler.**
  `flattenDiscriminatedUnion` and `flattenUnionsDeep` are removed because a
  derived executable Zod parser caused SDK + framework transforms to run twice.

  ```ts
  // before — returns a second executable Zod parser
  flattenUnionsDeep(zodSchema)

  // after — presentation only; the original Zod schema remains the parser
  flattenToolJsonSchema(
    z.toJSONSchema(zodSchema, { target: 'draft-07', io: 'input' }),
  )
  ```

  `MountableTool.schema` is split into `argumentSchema` (CLI adapter) and
  `presentationSchema` (MCP/agent/manifest). → ADR 0050

- **Every `ToolCallHooks` callback now takes one options object.** The three
  callbacks use the same field vocabulary and future observability fields can
  be added without extending positional arity. There are no positional
  overloads or compatibility adapters. → ADR 0046

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

- **MCP schema validation is one object-shaped profile.** The positional
  `validateMcpSchemas` signature is removed, and MCP configs replace
  `onIncompatibleSchema` with `schemaValidation.policy`.

  ```ts
  // before
  validateMcpSchemas(services, 'throw', logger, { requireTypedProperties: true })
  createMcpHandler({ services, onIncompatibleSchema: 'throw' })

  // after
  validateMcpSchemas({ services, policy: 'throw', logger, requireTypedProperties: true })
  createMcpHandler({ services, schemaValidation: { policy: 'throw' } })
  ```

- **`nativeTools` now receives a registrar, not a server.** Protected native
  tools register through `registerTool`; direct SDK registration is still
  available only through the visibly unprotected `rawServer` escape hatch.

  ```ts
  // before — raw; lifecycle and ToolCallHooks never ran
  nativeTools: (server, auth) => server.registerTool(name, config, handler)

  // after — framework-owned validation/lifecycle/hooks
  nativeTools: ({ registerTool }, auth) => registerTool({
    name, description, identity, input, output, handler,
  })

  // after — deliberate raw opt-out
  nativeTools: ({ rawServer }, auth) => rawServer.registerTool(name, config, handler)
  ```

  Tool hook and `ToolLifecycle` endpoints are now the path-free
  `OperationIdentity`; contract values remain full `MethodDef` objects, while a
  native operation does not invent an HTTP `path`. → ADR 0048

- **MCP HTTP now uses `sessionMode` and defaults to stateless.** The boolean
  `stateless` field is removed. Omission now creates a fresh server/transport per
  request with no session store; clients that need server push, cross-request
  progress or resumable SSE must opt into stateful mode.

  ```ts
  // before
  createMcpHandler({ stateless: true,  ...config })
  createMcpHandler({ stateless: false, ...config })
  createMcpHandler({ ...config }) // stateful by omission

  // after
  createMcpHandler({ sessionMode: 'stateless', ...config })
  createMcpHandler({ sessionMode: 'stateful',  ...config })
  createMcpHandler({ ...config }) // stateless by omission
  ```

  There is no boolean alias. → ADR 0049

- **Node raw-route and Socket.IO types are now runtime-neutral.** The Bun
  `stitchkit/server` entry keeps its concrete `BunServer` context. The Node
  entry no longer exposes Bun-only `websocket` / `route` fields on its
  `SocketIOServerHandle`, and an explicitly annotated Node `RawRoute` receives
  `server: unknown` unless the consumer supplies its own runtime generic.

  ```ts
  // before — importing from stitchkit/node still required Bun ambient types
  const route: RawRoute = { handler: (_req, ctx) => ctx.server?.upgrade(...) }
  const socket = await createSocketIOServer(config)
  socket.websocket

  // after — Node capabilities only; no @types/bun required
  const route: RawRoute<MyHostServer> = { handler: (_req, ctx) => use(ctx.server) }
  const socket = await createSocketIOServer(config)
  socket.io
  socket.attach(nodeHttpServer)
  ```

### Changed

- **The optional Node adapter peer now targets `srvx ^0.12.5`.** Projects using
  `serveNode` must install the current 0.12 line; the adapter and Node smoke lane
  are tested against that version.
- **Static MCP services are prepared once per handler.** Collection, schema
  conversion and validation now produce one immutable descriptor set reused by
  fresh servers. Auth-dependent service factories remain uncached, and every
  request/session still owns its server, context, runner and callbacks.
- **The Fetch-clean handler boundary is now structurally enforced.** Bun-owned
  listener types and `Bun.serve` live in a dedicated adapter, `RawRouteContext`
  / `HandlerConfig` / `FetchHandler` are runtime-parameterised, a packed Node
  consumer typechecks without `@types/bun`, and Biome rejects the `Bun` global
  anywhere outside the two explicitly Bun-owned source files.

### Fixed

- **Tool input transforms, defaults, coercions and refinements now execute only
  once.** MCP and AI SDK adapters advertise an immutable JSON Schema through an
  identity carrier and forward raw arguments into Stitchkit's shared runner.
  Protected native MCP inputs no longer parse a third time; `ToolExtend` parses
  its own fields once inside the same hooks/audit path. Strict MCP failures now
  produce Stitchkit's `VALIDATION_ERROR` envelope and remain observable.

- **`logging.enrich` can now supply `errorCode` for a raw error response.** A
  `4xx`/`5xx` returned as `Response` previously lost the only available code
  because the framework's empty field overwrote it. Success responses still
  reject enriched error codes, and a framework-derived code still wins. Any
  discarded framework-owned enrichment key now warns once per handler.

### Added

- **Signed JSON webhook bodies can be retained without dropping validation.**
  Declare `rawBody: true` on a body-bearing HTTP endpoint and its handler gets a
  guaranteed `ctx.rawBody` string alongside validated `ctx.input`. The text is
  retained before JSON/Zod parsing, reaches `onError` on parser failures and is
  never kept for endpoints without the flag. Optional route/server
  `maxJsonBodyBytes` caps the stream before full buffering. → ADR 0051

- **Portable MCP JSON Schema format validation.** Set
  `schemaValidation.requirePortableFormats` to catch client-specific formats
  such as `cuid2`, with the tool, input/output side and nested property path.
  `allowFormats` is explicit; stitchkit never strips or rewrites a schema
  keyword.
- **Framework-owned native MCP tools.** `NativeMcpRegistrar.registerTool`
  preserves multimodal MCP content while applying the canonical schema profile,
  isolated call context, lifecycle/RBAC, output validation and tool hooks. The
  configured service/action/scope/semantic method flows into `RequestEvent`.

### Documentation

- Refreshed VISION and ROADMAP to describe the current Bun/Node, OpenAPI, MCP,
  CLI, observability and packed-consumer surface; removed the volatile source
  line count and completed work that was still presented as future scope.

### Internal

- Updated the development and starter dependency set to current releases.
  TypeScript 7 remains the build/typecheck CLI, while the semantic public-type
  declaration guard uses the official side-by-side TypeScript 6 compiler API
  until that API returns in the TypeScript 7 package. MCP Apps bundle inlining
  is now tested both with the optional peer installed and from a packed consumer
  that deliberately omits it.

## [0.36.1] — 2026-08-06

### Fixed

- **`ToolExtend.resolve` was still outside the per-call context**, so the defect
  0.36.0 fixed survived at one remove: `resolve` runs *before* the executor, and
  it is the documented place a project resolves a tenant for the call. Two
  concurrent calls stamped each other's rows exactly as before. The fork now
  opens in the mount, around `resolve` as well. → ADR 0045

### Changed

- **0.36.0's note on injecting identity is qualified.** `createMcpHandler({
  context })` is resolved **once per server build** — in the default stateful mode
  that is once per *session*, not per request, so it carries the session's opening
  identity. For a per-request value use a stateless mount, or read identity from
  the tool row's own arguments.
- Spelled out, having been understated in 0.36.0: the enclosing `POST /mcp` audit
  row loses tool-written **`userId`** as well as `dimensions`, and the same four
  fields (`userId`, `serviceName`, `action`, `dimensions`) leave that request's
  **access-log line**, which reads the same context.

## [0.36.0] — 2026-08-06

### ⚠️ Breaking changes

- **A tool call runs in its own request context; its writes no longer reach the
  enclosing HTTP request.** `executeToolMethod` opened no scope, so every tool
  call in a request wrote into one `AsyncLocalStorage` store. The AI SDK runs a
  step's calls with `Promise.all`, so the last `setRequestDimensions` won for
  **every** row — call A's audit row could name call B's entity, silently. Found
  in production on rows that looked perfectly ordinary.

  ```ts
  // The documented recipe — a lifecycle that stamps the entity it acted on:
  lifecycle: { beforeHandle: (ctx) => setRequestDimensions({ entityId: ctx.input.id }) }

  // before: the value landed on that call's tool row AND on the enclosing
  //         POST /mcp audit row and its access-log line. Under two concurrent
  //         calls, both rows named one entity — whichever wrote last.
  // after:  it lands on that call's tool row only.
  ```

  Each call now runs in a copy of the ambient context — same `traceId`, same
  client info, inherited identity — with its own `dimensions` and `error`.

  **If you read `dimensions` off the `POST /mcp` row, read the tool row instead**
  (`event.toolName != null`). The value is not lost and the join is one field:
  both rows carry the same `traceId`, and the tool row's `parentSpanId` is the
  request's `spanId`.

  Concretely — "every row belonging to bot B7", where the id now lives on the
  tool rows and you still want the request row with them:

  ```bash
  # before: the id was on the request row, so one filter did it
  jq 'select(.dimensions.botId == "B7")' audit.jsonl

  # after: collect the traces the id appears in, then take every row in them
  jq -s '[.[] | select(.dimensions.botId == "B7") | .traceId] as $t
         | .[] | select(.traceId | IN($t[]))' audit.jsonl
  ```
  ```sql
  -- the same in SQL
  SELECT * FROM audit WHERE trace_id IN (
    SELECT trace_id FROM audit WHERE dimensions->>'botId' = $1
  );
  ```

  **Check your incident recipes, not only your code.** A consuming project
  upgraded with a clean typecheck and no code changes at all, and still had a
  documented `jq` filter over request rows return nothing — the schema compiles,
  a runbook does not. Identity for a tool row is better injected through the
  mount's `context` — `createMcpHandler({ context: (auth) => ({ userId: auth.id }) })`
  — which the row already reads.

  **Sequential calls change too.** Dimensions used to *accumulate* through the
  shared store, so a second call's row carried the first call's keys. Each row is
  now what that call would have produced alone.

  **Two more writes change destination, and both are recommended patterns.**
  `setRequestError` from `onToolError` no longer names the enclosing HTTP row —
  and, less obviously, it no longer *suppresses* the framework's own error
  recording on that row (which only fires when the context carries nothing yet,
  → ADR 0043). `setRequestUser` from a tool `lifecycle.beforeHandle` — the shape
  a `createAuthHook` result takes — now reaches no audit row at all: the tool row
  reads identity from the mount's `context`, never from the request context.
  Inject it there instead.

  The forked context also **describes the call**: `source`, `path`, `serviceName`
  and `action` name the tool rather than the enclosing route. It still carries the
  request's `trace` and `startedAt`, because the audit hook needs them as the
  parent — so a span id or a duration read out of `getRequestContext()` inside a
  tool handler is the *request's*, not the call's.

  Unchanged: a call with **no** ambient context — stdio MCP, `createCli`, an
  agent loop outside a request — is not forked and behaves exactly as before.
  There is no shared store there to corrupt, and inventing one would have stamped
  every such row with a `parentSpanId` pointing at a span no row carries.
  → ADR 0045

## [0.35.0] — 2026-08-06

### ⚠️ Breaking changes

- **A collided field in a flattened discriminated union now advertises its
  type.** Previously a key present in more than one variant whose kept schema
  carried *any* check was widened to `z.unknown()` — a bare `description` in the
  JSON Schema a model is handed. `.int().min(0)` triggered it, so the more
  precisely a field was described the less the model was told.

  ```ts
  // before: {"description": "Required if op = setText | setButton"}
  // after:  {"description": "…", "type": "integer", "minimum": 0}
  ```

  Listed as breaking because the **advertised** schema changes for existing
  contracts, and the MCP SDK parses arguments with it: a call that previously
  slipped through as `unknown` and failed inside stitchkit with a
  `VALIDATION_ERROR` is now rejected by the SDK as `MCP error -32602` — **before**
  the tool callback, so `afterToolCall` does not fire and no audit row is written
  for it. If you detect bad calls through those rows, expect this class to stop
  appearing there. Nothing about your contracts or handlers needs to change.
  → ADR 0044

### Added

- **`validateMcpSchemas(…, { requireTypedProperties, allowUntyped })`** — fail a
  build when an advertised property carries no `type` / `enum` / `anyOf` /
  `$ref`, i.e. nothing a model can obey. Off by default; `allowUntyped` takes
  dotted `tool.property` paths for fields that are deliberately free-form.
  `findUntypedProperties` is exported for asserting on a schema you built
  yourself. It lives in a consumer-facing function on purpose: the framework
  ships no contracts, so a build-time check here would have nothing to inspect.

### Internal

- **No test binds a fixed port any more**, and a guard keeps it that way. Every
  hardcoded port (27 of them, plus the Node smoke script) now binds `port: 0` and
  reads the assigned port back. They were a scheduled flake: the ephemeral range
  on the development machine starts at 1024, so an unrelated process's
  **outgoing** connection can hold any of those numbers, and the bind then fails
  reporting a server that does not exist. Worse, when the bind happened at module
  scope the file dropped out of the run and the suite reported green — a gate
  that could pass by not running its tests.

## [0.34.0] — 2026-08-06

### Added

- **Nine types that a public signature names are now exported.** A consumer who
  has to write a type down must be able to import it; these could not be, so the
  only way to name one was `Parameters<...>` gymnastics.

  `stitchkit/tools` — `ViewFileOptions`, `McpAnnotations`, `CollectToolsConfig`.
  `stitchkit/server` — `MultipartResult`, `VerifyJwtOptions`, `EventBusOptions`,
  `EventHandler`, `DefaultEventMap`. `stitchkit/observability` —
  `WrapRequestContextOptions`.

### Internal

- **A guard for the rule** (`check-public-types.mjs`, part of `build`): every
  type named in a public signature must be exported from some entrypoint, read
  off the emitted declarations with the TypeScript compiler API. It is what found
  four of the nine. Types this package keeps internal — inference helpers, union
  members, aliases over `@types/bun` — are listed with their reason, and an entry
  that stops being referenced is reported so the list cannot rot.

## [0.33.0] — 2026-08-06

### Added

- **An audited HTTP failure names its cause without being wired to.** Every error
  travels one path inside the framework, and that path now records
  `{ code, message, details }` onto the request context — so `createAuditHook`'s
  HTTP row says *why* a request failed whether or not you wrote an `onError`, and
  whether or not your `onError` returns its own `Response` (that branch recorded
  nothing at all before).

  Where the envelope was scrubbed to `INTERNAL_SERVER_ERROR` the row gets the
  real message instead of the placeholder — the same rule 0.32.0 gave the tool
  row, now shared in one place rather than written twice. The caller still
  receives the scrubbed envelope, byte-identical to before.

  `setRequestError` becomes an **override** rather than the wiring: the framework
  writes only when the context carries nothing yet, so a project that curates its
  own value keeps winning and needs no change. → ADR 0043

### Internal

- **A consumer lane in the gate** (`bun run consumer-lane`, part of `verify`).
  The suite imports from `src`, in one process, with everything in scope; a
  consumer gets a tarball, an `exports` map and the emitted declarations. Four
  defects in one day lived in that gap and were all reported from outside. The
  lane packs the built package, installs it into fixture apps and uses it through
  the published entrypoints only — annotating types on purpose, so a missing
  export is a compile error, and asserting behaviour only the built artifact can
  show. Each of the four defects was reintroduced and confirmed to fail it. No
  runtime change.

## [0.32.0] — 2026-08-06

### Added

- **`afterToolCall` receives the raw thrown value as a seventh parameter**, and
  **`createAuditHook` uses it** — a tool audit row can finally name why the call
  failed.

  0.30.0 made the cause observable; it was still not *recordable*, because the
  hook holding the raw value and the hook building the row were different hooks.
  The HTTP row has always taken its message from `ctx.error` (whatever the project
  curated); the tool row took it from the scrubbed envelope, so every unexpected
  throw was recorded as `Internal server error`.

  ```ts
  hooks: {
    afterToolCall: (toolName, args, result, durationMs, context, endpoint, error) => {
      void writeRow({ toolName, result, durationMs, cause: error, endpoint })
    },
  }
  ```

  `error` is present **only** when the call failed by throwing — a validation
  failure, an output-schema mismatch and a `beforeToolCall` rejection leave it
  `undefined`. Additive: a six-parameter hook stays assignable, keeps compiling
  and keeps firing, so no existing hook needs touching.

  In `createAuditHook` the raw message replaces the placeholder **only** where the
  envelope was scrubbed to `INTERNAL_SERVER_ERROR`; a truthful envelope keeps its
  own message, `errorCode` and `errorDetail` are untouched, and the stack is never
  written to a row. The caller still receives the scrubbed envelope in every case
  — the raw text reaches your server-side record, never the response. → ADR 0042

  If you were correlating `onToolError` with `afterToolCall` through a `WeakMap`
  to get this, you can drop it.

## [0.31.0] — 2026-08-06

### Added

- **`ToolCallContext` is exported from `stitchkit/tools`.** Every tool hook takes
  one — `onToolError` names it in its signature — but the type itself was not
  public, so a hook written as a standalone function had to recover it with
  `Parameters<NonNullable<ToolCallHooks['afterToolCall']>>[4]`.

### Fixed

- **`onToolError` guidance no longer points at `setRequestError`.** It writes to
  the *request* context, which `createAuditHook`'s **tool** row does not read —
  a tool event takes `errorCode` / `errorMessage` / `errorDetail` from the
  `ToolResult`, and only identity and `dimensions` from the context. The advice
  left the tool audit row as scrubbed as before and, for MCP over HTTP, wrote the
  cause into the enclosing `/mcp` request's log line as well — one incident, two
  records. The guide now routes the cause to the consumer's own sink and shows
  how to correlate `onToolError` with `afterToolCall` if a single row must carry
  both.

## [0.30.0] — 2026-08-06

### Added

- **`ToolCallHooks.onToolError`** — the raw value behind a failed tool call, as
  thrown, before it is normalised into a `ToolResult`.

  A thrown `AppError` already reaches `afterToolCall` intact. Anything else does
  not: `normalizeError` scrubs an unexpected throw down to a bare
  `INTERNAL_SERVER_ERROR` with the message `Internal server error` (a raw
  `Error.message` can carry a connection string), so the cause existed only for
  the framework's own `console.error` and no consumer hook could reach it — while
  the HTTP path has handed the value as thrown to `hooks.onError` all along.

  ```ts
  createMcpHandler({
    serverInfo, auth, services,
    hooks: {
      onToolError: (toolName, error, _context, endpoint) => {
        reportToolFailure({
          tool: toolName,
          action: endpoint.key,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      },
    },
  })
  ```

  Fires for a throw from `lifecycle.beforeHandle`, the handler or
  `lifecycle.afterHandle`, and runs **before** `afterToolCall` so what it records
  is in place when the audit hook reads it. It does not fire for an
  argument-validation failure, an output-schema mismatch or a `beforeToolCall`
  rejection — each is already described in full by the `ToolResult`. Observation
  only: the return value is ignored and a throw from the hook is reported and
  swallowed. Reaches every mount that takes `hooks` — `mountMcp`,
  `createMcpHandler`, `mountAgent`, `createCli`.

## [0.29.0] — 2026-08-06

### Added

- **`logging.format: 'pretty' | 'json'`** — the built-in formatter's output is
  now the consumer's choice, not a guess.

  ```ts
  createServer({ services, logging: { format: 'json' } })
  ```

  | `format` | Writes | Carries `enrich` / context identity |
  |---|---|---|
  | `'pretty'` | two coloured lines per request (`→`, `←`) | no |
  | `'json'` | one structured line per completed request | yes |

  Unset, it follows `NODE_ENV` — `json` under `production`, `pretty` otherwise —
  read **per request**, so it reflects the environment your app runs in. Set it
  and the environment is not consulted at all. It governs the **built-in**
  formatter only: a custom `logger` always receives the structured object.
  → ADR 0040

### Fixed

- **The structured log line was unreachable in every installed copy of this
  package.** The format was decided by a module-scope
  `process.env.NODE_ENV === 'production'`, which a bundler folds into a literal
  at build time — *this package's* build, not yours. The published bundle
  carried `var isProd = false`, so every consumer got the pretty format
  permanently, whatever they ran under, and no `NODE_ENV` on their own build
  could change it (that only freezes their code the same way). The environment
  is now read through an indirection, per request.

  This is why anything the structured line carries — the request-context
  identity and `enrich` fields added in 0.28.0 — appeared not to work outside a
  custom `logger`. It affected every version since 0.1.0.

  A build guard (`check-env-live`) now fails the build if the read is ever
  folded away again.

## [0.28.1] — 2026-08-06

### Fixed

- **A throwing `hooks.onRequest` no longer escapes the handler.** It ran before
  the dispatch `try`, so an exception from the gate skipped every layer — no
  `onError`, no error envelope, no CORS headers, no log line, no
  `x-request-id` — and the runtime answered with a bare 500. It now takes the
  same path as any other failure. An `AppError` thrown by the gate keeps its
  status.
- **A throwing `traceId` resolver no longer costs the response.** The id exists
  to label a log line; a resolver that throws now falls back to the framework
  resolver, and the failure is reported **once per handler** (not once per
  request) through the configured logger. Consumers who wrapped `getTraceId` in
  a throwing guard — the shape the pre-0.28.0 type error forced — were one
  forgotten `wrapInRequestContext` away from bare 500s on every request. With
  the signature fixed in 0.28.0, `traceId: getTraceId` needs no guard at all.

## [0.28.0] — 2026-08-06

### ⚠️ Breaking changes

- **`logging` no longer takes a `StitchLogger` directly** — it takes a config
  object, so the logger can finally be tuned instead of only replaced.
  `logging: true` is now shorthand for `logging: {}`: **any** object turns
  request logging on, `logger` decides which sink writes it, and `skip` /
  `enrich` apply to whichever is active.

  ```ts
  // before
  createServer({ logging: myLogger })
  // after
  createServer({ logging: { logger: myLogger } })
  ```

  The migration is mechanical and loud: `LoggingConfig` shares no property with
  `StitchLogger`, so TypeScript's weak-type detection rejects the old form.
  A logger typed `any` or carrying an index signature would slip past the
  compiler and silently mean "a config with no logger" — that case **throws at
  `createHandler`** with the line above rather than booting with logging off.
  → ADR 0039

- **`DEFAULT_CORS_EXPOSE_HEADERS` no longer advertises `X-Trace-Id`; it
  advertises `X-Request-Id`.** The old value named a header the server has never
  sent, while the one it does send on every response was unreadable
  cross-origin. This is the **one change here the compiler cannot catch**: if
  something else in your chain (a proxy, a middleware) sets an `X-Trace-Id`
  *response* header that browser code reads, that read starts returning `null`.

  ```ts
  // before: the default list ended in `X-Trace-Id`
  // after: keep reading a proxy-set X-Trace-Id by asking for it explicitly
  createServer({ cors: { origin, exposeHeaders: `${DEFAULT_CORS_EXPOSE_HEADERS}, X-Trace-Id` } })
  ```

  `DEFAULT_CORS_ALLOW_HEADERS` is unchanged — inbound `X-Trace-Id` is still
  accepted and read by `resolveTraceId`. (0.27.0 introduced this default and
  quoted the old list verbatim in its own breaking note; this corrects it.)

- **`logging: true` emits more in production.** With an observability context
  active, every completion line now also carries `userId`, `serviceName`,
  `action` and nested `dimensions` — see *Added* below. A log store with a fixed
  schema will see new keys. Development output is unchanged.

### Added

- **`logging.skip(req, url)`** — drop chosen requests from the log. Runs after
  the built-in filter (framework assets, favicon, preflights), so it can only
  quieten more: health probes, a monitoring path that 404s every cycle,
  Socket.IO's polling transport.
- **`logging.enrich(req, url, outcome)`** — extra fields on the completion
  line. Runs once at close and is merged *under* the framework's own fields,
  which always win. A throw in either callback is swallowed — neither can fail a
  request.
- **The completion line picks up the active request context** — `userId`,
  `serviceName`, `action` and nested `dimensions`, with no configuration, when
  something established a context. Unchanged when nothing did.

  ⚠️ Both of the above reach the **structured** output only: the production JSON
  line and a custom `logger`'s `data`. The development `←` line is a line to
  read, not a record to query, and never carries them — so with
  `logging: true` in development you will see no difference at all.
- **`wrapFetch` on `createServer` / `serveNode`** — the seam for
  `wrapInRequestContext` and `createAuditHook`, which must wrap the handler from
  outside. Both servers build their own `fetch`, so until now neither could
  reach the observability layer at all.
  ```ts
  createServer({ services, wrapFetch: (h) => wrapInRequestContext(audit.http(h)) })
  ```
- **`ToolCallRecord.traceId`** — joins a tool call to the HTTP request that
  triggered it.
- New exported types: `LoggingConfig`, `LogOutcome`, `FetchHandler`,
  `FetchComposition`.

### Fixed

- **`traceId: getTraceId` now compiles.** The option demanded `string` while
  `getTraceId` returns `string | undefined`, so the documented way to share one
  id between request and application logs was a type error. `traceId` may now
  return `undefined`, and the framework falls back to its own resolver instead
  of stamping `"undefined"`.
- **A throwing logger can no longer take the request with it.** On the error
  path the throw was swallowed by the `onError` catch and then re-thrown,
  uncaught, by the fallback call. The whole log step is now guarded.
- **One completion line per request.** A result `Response.json` cannot
  serialise (a `BigInt`, a cycle) logged a `200` and then a `500` for the same
  request; the line is now written only once the response exists.
- **A custom logger now receives `ip`** on the completion line, as the built-in
  formatter always has, and `errorCode` is always present (`undefined` on
  success) so an `enrich` value can never forge one.

## [0.27.0] — 2026-08-05

### ⚠️ Breaking changes

- **CORS now sends `Access-Control-Expose-Headers` by default.** Every response
  from a server with `cors` configured — JSON endpoints included — begins
  advertising `Content-Disposition, Content-Length, Content-Range,
  Accept-Ranges, ETag, Last-Modified, X-Trace-Id` as readable cross-origin.
  Without this a browser cannot recover a downloaded file's name, revalidate or
  resume, so file responses were unusable cross-origin; but it is a **changed
  default**, and widening what cross-origin JavaScript may read is a
  security-review surface. These are headers the server already sends — nothing
  new is disclosed to the network — but review it rather than assume.
  `// before: (no header)` → `// after: cors: { origin, exposeHeaders: [] }` to
  keep the old behaviour, or pass your own list.

### Added

- **Raw-response endpoints — `rawResponse: true`.** An endpoint that answers with bytes
  rather than data (a PDF, a file download, an SSE stream) declares `rawResponse: true`
  and returns the `Response` itself. Until now such endpoints had to leave the
  contract for `rawRoutes`, which costs three things unrelated to bytes: the
  typed client, a single route registry, and — the serious one — the **auth
  gate**, since raw routes never run `hooks.beforeHandle` and each handler had
  to call the guard on its own first line. A raw endpoint keeps all three: the
  request half (`params` / `input` / `multipart`, `beforeHandle`) is completely
  unchanged; only the response is handed over. It is never an MCP tool, an agent
  tool or a CLI command, and declaring `output`, `toolName`, `ui`, `annotations`
  or a non-HTTP `expose` beside it is a type error (and throws at definition
  time for a contract assembled at runtime). `afterHandle` is **skipped** for
  raw endpoints — it transforms data, and there is none. On the typed client the
  method resolves to the untouched `Response`, so `Content-Disposition` (the
  download filename) survives, which a `Blob` would lose. → ADR 0038.

  ```ts
  download: {
    method: 'GET', path: '/:id/pdf', desc: 'Download a document as a PDF',
    params: z.object({ id: z.uuid() }),
    rawResponse: true, contentType: 'application/pdf',
  }
  // handler — no guard on the first line; beforeHandle already ran
  download: (ctx) => serveFile(ctx.req, { path: pathFor(ctx.params.id) }),
  ```

- **`RequestOptions.responseType: 'response'`** — hand back the untouched
  `Response` instead of parsed JSON or a `Blob`. What `rawResponse` endpoints use; also
  available for a direct `HttpClient` call.

- **`cors.exposeHeaders`** — control `Access-Control-Expose-Headers`, which the
  framework emitted nowhere. Pass `[]` to emit none, or a list to replace the
  default (see the breaking note above).

- **`isWithinDir` is exported** from `stitchkit/server`. `serveFile` deliberately
  leaves path containment to its caller, and the guide and ADRs 0023 / 0038 tell
  you to call this before serving a URL-derived path — but it was internal, so
  the advice was unactionable. The guide now carries the full recipe.

- **A raw route that shadows a contract route is reported at startup.** Raw
  routes match first, so a leftover one keeps serving while the contract
  endpoint — and its auth gate — never runs. The warning names the raw route,
  the dead endpoint and the scope being bypassed. Silent, this is the exact
  failure raw-response endpoints exist to prevent.

### Fixed

- **A `Response` on the data path no longer vanishes.** Returned from a normal
  handler it was wrapped by `afterHandle`, serialized by `json()` into `{}` and
  answered with status 200 — headers, status and body gone, and nothing logged.
  The guide's own SSE example (`return streamSSE(tokens())`) sat in that hole.
  The handler's return type already rejected it (`void | Promise<void>` admits
  no `Response`); what is new is that it now **fails at runtime** with a 500
  naming the fix, instead of answering 200. Checked after the hooks, so an
  `afterHandle` returning a `Response` is caught too. Declare `rawResponse: true` (see above); the SSE guide section is updated.

- **CORS no longer corrupts a partial response.** `applyCors` rebuilt every
  response it decorated (`new Response(res.body, …)`), and on Bun reading `.body`
  off a response built from `Bun.file().slice()` re-reads the *whole* file. A
  `206` therefore kept its honest `Content-Range` while shipping the rest of the
  file — a client stitching ranges (a video player, a download manager,
  `curl -C -`) got garbage. Measured: `Range: bytes=10-14` on a 26-byte file
  returned 16 bytes. Headers are now mutated in place, with the rebuild kept only
  as the fallback for the immutable-header case it was written for
  (`Response.redirect()`, which has no body to corrupt). Affects any raw route,
  `onError` response or `serveFile` handler behind `cors`.
- **`Vary` is appended, not overwritten.** With a list `origin`, CORS set
  `Vary: Origin` over whatever the handler had put there — a file response
  carrying `Vary: Accept-Encoding` lost it, and a shared cache would then serve
  one encoding to every client.

### Docs

- **`meta` opt-out documented:** an endpoint declaring `key: undefined` shadows
  the contract-level value — "the contract turns this on for everyone, this
  endpoint turns it off". This was already how 0.26.0 behaves; the ADR and guide
  wrongly said "no unset sentinel". Driven by a real consumer case (a public
  form-submission endpoint inside an admin-gated contract). The key stays present
  with value `undefined`, so read `meta` by value (`meta?.key`), not membership.

## [0.26.0] — 2026-08-05

### ⚠️ Breaking changes

- **Tool names are normalised across the whole character class, and an
  undeliverable name now throws at mount.** `toToolName` normalised only the
  hyphen, so anything else rode into the advertised name (`prefix:
  'admin/analytics'` derived `overview_admin/analytic`). Nothing downstream checks
  this — the MCP SDK only *warns* (SEP-986) and registers anyway, the `ai` SDK has
  no rule — so the provider rejected the request and **every** tool of that mount
  went dark, at the first model call. The enforced rule is `[a-zA-Z0-9_-]`, ≤64
  characters: OpenAI's, the tightest of the surfaces, so a passing name is
  deliverable everywhere (MCP and Anthropic both allow 128 and a dot, so an
  MCP-only consumer may need a shorter explicit `toolName`). → ADR 0035.

  ```ts
  // before: prefix 'admin/analytics' + `overview` → "overview_admin/analytic" (illegal, ships)
  // after:                                       → "overview_admin_analytics"
  ```

  Two things can now fail or move:
  - **An illegal name throws at mount**, naming the endpoint — an explicit
    `toolName` outside `[a-zA-Z0-9_-]`, a name over 64 characters (the only remedy
    is a shorter explicit `toolName`), or a prefix with no usable character at
    all — `'///'`, `'_'`, `''`, a fully non-ASCII prefix. Those last ones derived
    a degenerate name (`get____`, `get__`, `get_`) that *passes* the charset check
    while being meaningless and identical for every such service, so they are
    rejected on their own terms; setting an explicit `toolName` rescues them,
    since the prefix then never enters the name. Note this is the one sub-case
    where a name that was **provider-legal** now throws — an underscore-only or
    empty prefix. Otherwise nothing that worked stops working: an illegal name was
    already rejected provider-side.
  - **Some legal names are renamed**, because `singularize` now applies to the
    last `_` segment instead of the whole name — the exception list previously
    only ever matched an unprefixed service. `get_bot_statu` → `get_bot_status`,
    `get_user_setting` → `get_user_settings`, `get_chat_analytic` →
    `get_chat_analytics`, `get_site_new` → `get_site_news`. A host config or agent
    prompt pinned to an old name breaks — diff with `listToolNames` before and
    after (see `docs/guide/upgrading.md`).

  Names that are legal today are otherwise **byte-identical**: no run-collapsing,
  no trimming, and a hyphen in a *method key* is kept (`get-user_note` still
  derives as before) — so `get__internal`, `list_a__b` and `get_foo_` are
  untouched. **The CLI is exempt** from the charset and length rules entirely: a
  command name goes to a shell, not to a provider. The built-in native tools
  (`mountWait` / `mountDownload` / `mountUpload`) now assert their names too, since
  they share the `tools/list` with contract tools.
  `implementRemote` inherits the check — it derives names over someone else's
  contract. `listToolNames` deliberately does **not** throw, so it can still show
  you the offending row.

### Added

- **`warnOnOutputStrip` — see what the `output` schema is removing.** A handler
  returning more than its contract declares has the extra fields deleted, which is
  correct but invisible: types cannot catch it and nothing logged it. Turn the flag
  on while migrating a live API and every removed key is reported as a dot-path
  with the endpoint identity (`notes.get: secret, nested.alsoSecret`); tool mounts
  take the same via `onOutputStrip: (toolName, paths) => …`. Off by default, and
  the key diff only runs when a reporter is attached, so nothing changes for anyone
  who does not opt in. → ADR 0037.
- **`createErrorHook`'s `render` and `onError` receive the `RuntimeContext`.** The
  helper dropped it, so putting a `traceId` in the error envelope — the ordinary
  reason to have one — meant abandoning the helper and hand-rolling `onError`,
  re-implementing the normalisation it already does. Additive: a one-argument
  `render` stays assignable.
  `// before: render: (info) => …` → `// after: render: (info, ctx) => ({ …, traceId: ctx.traceId })`
- **`nativeTools` receives the resolved identity**, like `services` and `context`
  already did — `nativeTools: (server, auth) => …`. A native tool can now be
  per-tenant. It is **not** a scope gate: native tools are not contract methods, so
  `lifecycle` still does not run for them.
- **A contract can declare a default `meta` that endpoints inherit** —
  `defineContract({ prefix, meta: { owner: 'auth' } }, …)`. An endpoint's own
  `meta` is **shallow-merged over** it (endpoint keys win, one level), so a
  contract-wide `{ public: true }` survives an endpoint that adds
  `{ rateTier: 2 }` — which matters because `meta: { public: true }` is the
  documented allowlist for the generated OpenAPI spec. Applies through
  `implement`, `implementRemote` and `createContractFactory` (which previously
  rebuilt the meta object and would have dropped the field). `expose`
  deliberately does **not** cascade — → ADR 0036 for the reasoning, and pin
  `listToolNames` in a snapshot to catch an endpoint that forgot it.

## [0.25.0] — 2026-08-03

### ⚠️ Breaking changes

- **The advertised tool schema no longer deletes unknown keys — a `.strict()`
  contract schema is now enforced on the wire.** The MCP and AI SDKs parse a
  tool call's arguments *with the advertised schema* and hand the handler the
  parsed result, so every object stitchkit rebuilt while deriving that schema
  (the union flatten walk, the `params` + `input` merge, the `ToolExtend` fold)
  silently **removed** keys before validation could see them: a call carrying a
  key a `.strict()` schema forbids **succeeded**, with the key gone. Objects now
  carry their own key policy through every rebuild. → ADR 0034.

  ```ts
  // contract, unchanged
  input: z.object({ node: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('send'), outputs: z.object({ ok: z.string() }).strict() }),
  ]) })

  // before: tools/call { node: { kind: 'send', outputs: { ok: 'x', typo: 1 } } }
  //         → 200, handler receives outputs: { ok: 'x' } — `typo` silently dropped
  // after:  → rejected, the caller is told `Unrecognized key: "typo"`
  ```

  What to check when upgrading:
  - **A previously-accepted call may now fail.** Anything that leaned on the
    sanitising behaviour (a client sending a stale or extra field to a strict
    tool) must stop sending it. `.loose()` / `.passthrough()` / `.catchall()`
    schemas keep receiving their extra keys, as they always did on HTTP.
  - **A strict violation arrives on a different channel.** The SDK rejects it
    *before* the tool callback runs. `callTool` still resolves (it does not
    throw), but with an `isError: true` result carrying the SDK's own
    `MCP error -32602: Input validation error: … Unrecognized key: "…"` instead of
    stitchkit's `{ error, details, _hint }` envelope (agent: an `invalid: true`
    tool call) — and **`beforeToolCall` / `afterToolCall` do not fire**. Such
    calls move from "logged as a success" to "not logged at all"; audit
    dashboards counting tool calls will shift.
  - **A filtered `ToolExtend` can now reject cross-tool.** Where `extend.filter`
    advertises `tenantId` on some tools only, a model that sends it to a strict
    *non*-extended tool was sanitised before and is rejected now.
  - **The advertised JSON Schema changed** for strict/loose objects
    (`additionalProperties: false` / `{}`) on the MCP surface and in
    `buildToolManifest` — a snapshot test of a generated manifest will diff.
    OpenAPI output is unchanged.
  - Not covered: `z.intersection` (a `params` + union-`input` tool on the agent
    surface) still strips — Zod drops both sides' key policy when intersecting.

### Fixed

- **`flattenUnionInput` no longer injects a non-matching variant's `.default()`
  into the payload.** Every field of the flattened object is advertised optional,
  so a variant's default materialised on *every* call: sending variant `a` came
  back carrying variant `b`'s defaulted field, which the real union then rejected
  as an unrecognized key — a legal call turned into a hard `VALIDATION_ERROR`.
  `.default()` is now unwrapped when variant fields are merged, exactly as
  `.optional()` already was. Pre-existing since 0.14.0; it bites hardest on the
  all-`.strict()` unions the change above makes the sound choice.

## [0.24.0] — 2026-07-28

### Added

- **OAuth provider — `iss` on every authorization response (RFC 9207,
  MCP 2026-07-28 / SEP-2468).** `mountOAuthProvider` now returns the `iss`
  parameter on both the success and the error redirect from `/authorize`, and
  the authorization-server metadata advertises
  `authorization_response_iss_parameter_supported: true`. A client that talks to
  several authorization servers validates `iss` before redeeming the code, which
  closes the **authorization-server mix-up** attack. Additive on the wire — a
  client that ignores the parameter is unaffected.
- **OAuth provider — `application_type` on Dynamic Client Registration
  (SEP-837).** `/register` accepts `application_type: "native" | "web"`, echoes
  it back, and carries it on `RegisteredClient`. A **native** client (desktop /
  CLI) may register an `http` loopback redirect (RFC 8252 §7.3); a **web** client
  is held to `https` only — the mismatch behind the `redirect_uri` errors CLI
  clients hit. Omitting the field keeps the previous permissive behaviour, so no
  existing client breaks; an unknown value is rejected with
  `invalid_client_metadata` rather than silently defaulted. New exported type
  `ApplicationType`.

## [0.23.0] — 2026-07-18

### Added

- **`generateOpenApiDocument` — `includeMethod` predicate for a curated public
  spec.** Emit only the methods a predicate keeps, instead of the whole HTTP
  surface — a public `/openapi.json` that advertises a subset without revealing
  the rest. The core stays generic (no `public` field): the policy is the app's,
  filtering on anything the method carries. The recommended declarative allowlist
  uses the existing `meta` passthrough —
  `includeMethod: (m) => m.meta?.public === true` over endpoints flagged
  `meta: { public: true }`. An excluded method's path and every inlined schema
  are never emitted, so nothing about a hidden endpoint leaks. Additive — omit
  it for the previous behaviour (every HTTP method). **The filter advertises, it
  does not authorize** — the `scope` gate is still the guard; serve a full
  internal spec and a filtered public spec on separate routes.

## [0.22.0] — 2026-07-18

### Added

- **`VALIDATION_ERROR` now carries the offending fields as structured
  `details.issues`** — `{ path, code, message }[]` — alongside the text
  `message`. A machine client (or an MCP tool caller) matches on fields instead
  of parsing the message. It flows through the default error envelope,
  `normalizeError`, and `createErrorHook`'s `render` (`info.details.issues`), so
  the batteries-included path now serves a machine client without a hand-rolled
  `ZodError` branch. Additive — `details` was absent before.
- **`zodIssues(error)` exported from `stitchkit/server`** (with `ZodIssueSummary`)
  — project a `ZodError` into that structured `{ path, code, message }[]`, the
  machine-readable sibling of `formatZodError`. Use it in a bespoke `onError`.

### Docs

- Documented the `onError` contract explicitly: a hook receives the **raw**
  thrown value (a `ZodError`, an `AppError`, anything) — the framework normalises
  only when no hook is set. Call `normalizeError` / `zodIssues` yourself for the
  canonical classification or structured fields.

## [0.21.0] — 2026-07-18

### Fixed

- **`createErrorHook` now returns an honest `400 VALIDATION_ERROR` for invalid
  input, not a `500`.** It classified any non-`AppError` as
  `INTERNAL_SERVER_ERROR`, so a `ZodError` from input validation — a client fault
  — was dressed as a server fault (every consumer had to add its own ZodError
  branch). It now runs the thrown value through the framework's `normalizeError`
  first, exactly as the framework default does: `ZodError` → `VALIDATION_ERROR`
  400 (remapped through `codeMap` like any stitch code), `AppError` keeps its
  code/status, anything else stays a generic 500 with no message leak.

### Added

- **`normalizeError`, `errorCode` and `formatZodError` are exported from
  `stitchkit/server`.** The framework's canonical error classification — reuse it
  in a bespoke `onError` (or for log attribution) instead of reinventing the
  `ZodError` → 400 mapping. `createErrorHook` and the framework default both run
  through `normalizeError`.

### Docs

- **Corrected the multipart / query boolean-coercion guidance to `z.stringbool()`
  (Zod v4).** The 0.20.0 migration note recommended `z.coerce.boolean()` for a
  boolean field, but that is `Boolean(str)` — every non-empty string, including
  `'false'`, is truthy, so a `'false'` field silently became `true`.
  `z.stringbool()` decodes `'true'` / `'false'` (and `'1'` / `'0'`, `'yes'` /
  `'no'`) correctly. Applies to both multipart and query-string boolean fields.

## [0.20.0] — 2026-07-17

### ⚠️ Breaking changes

- **Multipart text fields are no longer JSON-decoded — they arrive as raw
  strings, and the schema coerces.** `parseMultipart` used to run every text
  field through `JSON.parse`, so a field's type depended on its *content*: an id
  like `'33111715'` silently became a number and failed a `z.string()` schema by
  the luck of its digits (`'true'` → boolean, `'[1,2]'` → array, and so on). A
  multipart text field is always a string per the spec; the type belongs to the
  contract, not the value — the same rule as query params. Update a multipart
  `input` field to coerce, and opt a JSON field in explicitly:
  `// before: z.number()` → `// after: z.coerce.number()`;
  `// before: z.boolean()` → `// after: z.stringbool()` (Zod v4 — **not**
  `z.coerce.boolean()`, which is `Boolean(str)`, so `'false'` would become `true`);
  `// before: z.object({ … })` → `// after: z.preprocess((v) => JSON.parse(String(v)), z.object({ … }))`.
  A field already typed `z.string()` now works as written (it previously broke on
  numeric-looking values). Removing the value-level `JSON.parse` also drops a
  prototype-pollution vector; the `__proto__` key guard stays.

## [0.19.0] — 2026-07-10

### Fixed

- **Default CORS now allows the `traceparent` / `tracestate` request headers**,
  so `createHttpClient({ trace: true })` (added in 0.18.0) actually works
  cross-origin. The client sends `traceparent` on every request, but the default
  `Access-Control-Allow-Headers` omitted it — every browser preflight failed and
  the API was unreachable whenever `trace` was on. The three divergent CORS
  header defaults (HTTP server, OAuth provider, OAuth metadata) are unified into
  one exported constant, `DEFAULT_CORS_ALLOW_HEADERS`.

### ⚠️ Breaking changes

- **The `HttpClient` (ky) client path now validates responses against the
  endpoint's `output` schema.** It previously returned the body unvalidated,
  while the bare-fetch client path validated — so which guarantee you got
  depended on whether you passed a `createHttpClient(...)` or a plain
  `{ baseUrl }`. Both paths now honour the contract's documented promise ("when
  set, the client parses the response through it"). A response the server sends
  that does **not** match `output` now throws a `ZodError` on the ky path where
  it used to slip through. For a correctly-built app this never fires — the
  server handler's return is already type-checked against the same `output`; it
  only surfaces a genuine server/client schema-version skew.
  `// before: createClient(c, createHttpClient({...}))  // returned unvalidated`
  → `// after: … validates output, throwing on a mismatch`

### Added

- **`createContractFactory<Scope>()`** (`stitchkit/contract`) — a `defineContract`
  with a required, typed `scope`, so a missing scope is a compile error, not a
  silent `'public'` endpoint. The scope vocabulary is the app's.
- **`defineErrors({...})`** (`stitchkit/contract`) — declare domain error codes
  once → typed throwers (`errors.SESSION_NOT_FOUND(msg)`) for the server and a
  code table (`codes.SESSION_NOT_FOUND`) the client matches with autocomplete
  instead of a magic `message` string.
- **`createErrorHook({ codeMap, render })`** (`stitchkit/server`) — an `onError`
  hook from an exhaustive `Record<StitchErrorCode, …>` map + an envelope
  renderer; never leaks an internal message.
- **`createToolLogger()`** (`stitchkit/tools`) — a ready `afterToolCall` preset
  that logs every tool call (ok/failed, duration, endpoint identity), with an
  optional `onRecord` metrics sink. **`summarizeTransports(services)`** returns
  per-transport operation counts for a boot-time summary.
- **`createEntityCacheHandlers()`** (`stitchkit/react`) — declarative
  created/updated/deleted cache handlers for `createCacheBridge`, patching the
  `Paginated<T>` list + detail queries (does not flatten pages).
- The bare-fetch client path now applies an endpoint's declared `timeout` (via
  `AbortSignal.timeout`) — it previously ignored it, so a declared `timeout` did
  nothing on that path. The ky path already applied it.
- **`DEFAULT_CORS_ALLOW_HEADERS`** exported from `stitchkit/server` — the default
  allow-list, to extend (not replace) when setting a custom `cors.headers`.
- The API reference — and the generated `llms.txt` / `llms-full.txt` a consuming
  agent reads — now documents ~45 previously-missing public exports (the OAuth
  provider, MCP Apps, the native `mountDownload` / `mountUpload` / `mountWait`
  tools, `signJwt`, PKCE, the whole `stitchkit/node` entry). No code change; the
  surface was already there, just undocumented. A new test keeps every export
  documented from now on.

### Changed

- **`createSocketIOClient` loads `socket.io-client` lazily.** It is no longer a
  static import of the root `stitchkit` entry, so `import { defineContract }`
  (or any non-socket use) no longer drags the Socket.IO client into a bundle —
  a minimal `bun add stitchkit zod` quick start now runs without the peer
  installed. The peer loads on the first `connect()`; the connection opens
  asynchronously as it always did, and a missing peer throws a clear
  install-me error. No API change.
- **Multipart on the `HttpClient` path now uses the endpoint's declared method**
  (`POST` / `PUT` / `PATCH`) instead of always `POST` — a `PUT` upload no longer
  silently becomes a `POST`. A multipart endpoint declared `GET` / `DELETE` now
  throws (it never had a valid body verb).
- **An `onRequest` hook's early `Response` now carries CORS headers** like every
  other response exit — a short-circuit (auth wall, maintenance page) answered
  to a browser is now readable cross-origin.

## [0.18.0] — 2026-07-09

### ⚠️ Breaking changes

- **The typed client now throws on a non-flat `GET` / `DELETE` input field**
  (a nested object, an array with non-primitive items, a function). Previously
  such a field was **silently dropped** from the query string, sending a subtly
  incomplete request. A query string can only carry `string` / `number` /
  `boolean` and arrays of `string` / `number` — see
  [Contracts → query input](docs/guide/contracts.md#query-input-get--delete).
  `// before: api.search({ filter: { status: 'active' } })  → GET /search (filter silently dropped)`
  → `// after: throws "GET /: input field \"filter\" is a nested object …" — flatten the field or use POST`
  Flat fields and primitive arrays are unaffected. Both client paths
  (`createHttpClient` adapter and the bare-fetch `ClientConfig` mode) enforce
  the same rule.

### Added

- **`createHttpClient` — `trace` option (`boolean`, default `false`).** Emits a
  W3C `traceparent` header with a fresh root trace on every request. The server
  already continues an inbound `traceparent` (`resolveTraceContext`), so with
  this on, a browser call, its HTTP handler and every nested tool call share
  one trace id end-to-end. A `traceparent` set via `headers` wins — the client
  never overwrites it.
- **Trace helpers on the root `stitchkit` entry.** `createTraceContext`,
  `formatTraceparent`, `parseTraceparent`, `childSpan` and the `TraceContext`
  type are now also exported from the browser-safe root entrypoint (they are
  Web Crypto-only), so a custom client can format its own `traceparent` without
  importing the server-only `stitchkit/observability`.
- **`listToolNames(services)` in `stitchkit/tools`.** Resolves every tool name
  the services expose — the `toolName` override or the derived name, with its
  `(service, method)` identity and tool transports (`MCP` / `AGENT` / `CLI`),
  sorted. Built on the exact resolver the mounts use, so it can never drift
  from what actually mounts. Use it for a name-baseline snapshot test (a
  derived-name drift across upgrades fails CI instead of silently breaking MCP
  client configs) and for migration diffs. Returns `ToolNameEntry[]`.

## [0.17.0] — 2026-07-05

### Added

- **`createSocketIOClient` — `onConnectionChange` now passes the disconnect
  reason.** The listener gains an optional second argument:
  `(connected: boolean, reason?: string) => void`, where `reason` is the
  Socket.IO disconnect reason (`io server disconnect`, `transport close`,
  `ping timeout`, …) on a down event and `undefined` on connect. Purely additive
  — an existing `(connected) => void` listener keeps working unchanged.
- **`createSocketIOClient` — `reconnectOnServerDisconnect` config option
  (`number | false`, default `1000` ms).** When the **server** initiates the
  disconnect (reason `io server disconnect`, e.g. a backend restart or an
  auth-gate drop), Socket.IO by design does **not** auto-reconnect — a long-lived
  client would stay dead for good. The client now recycles itself after the given
  delay, reconnecting on the same socket (which re-reads the `auth` function, so a
  rotated token is picked up automatically). Set `false` to keep Socket.IO's
  stay-disconnected default. Other disconnect reasons are untouched — Socket.IO's
  own reconnection already handles them.

### Changed

- **`createSocketIOClient` now recovers from a server-initiated disconnect by
  default.** Previously such a disconnect left the client permanently down; it now
  recycles after 1000 ms (see `reconnectOnServerDisconnect` above). Not a breaking
  API change — no signature or export changed — but the runtime behavior differs;
  pass `reconnectOnServerDisconnect: false` to restore the old behavior.

## [0.16.0] — 2026-06-26

### ⚠️ Breaking changes

- **`ai` peer dependency now requires `^7.0.0` (dropped v6).** `mountAgent` /
  `createToolkit` build the Vercel AI SDK `ToolSet` from your contract, so the
  `ai` major stitchkit links against must match the one your app runs. AI SDK 7
  keeps the symbols stitchkit uses — `tool`, `zodSchema`, `ToolSet` — source
  compatible, so **no stitchkit code changed** and the agent-tool surface behaves
  identically. But a consumer still on `ai@6` will hit a peer-dependency conflict
  on upgrade. Move your app to `ai@7` in the same step.
  `// before: "ai": "^6"` → `// after: "ai": "^7"`
  (if your app uses more of the SDK than stitchkit's tool mount, run
  `npx @ai-sdk/codemod v7` to migrate the rest.)

## [0.15.2] — 2026-06-26

### Fixed

- **A `ToolExtend` no longer strips a non-extended tool's own colliding param.**
  (`stitchkit/tools`) `createToolRunner` resolved the extend context only for a
  tool the extend applied to (`shouldExtend`), but stripped the extend keys from
  **every** tool's arguments. So a tool the `extend.filter` excluded, whose own
  contract param is named like an extend key (e.g. a `botId` path param on a
  service the extend doesn't cover), had that argument silently removed → the
  handler received it as `undefined` and validation failed (`Invalid params:
  <key>`), even though the client sent it. The strip is now gated on
  `shouldExtend`, mirroring the resolve — and `applyExtend` already forbids an
  extend key clashing with an extended tool's own field, so a non-extended tool's
  matching param is always legitimately its own. Affects all tool transports
  (MCP / agent / CLI — shared `createToolRunner`).

## [0.15.1] — 2026-06-22

### Fixed

- **Flatten collision-soundness now covers JSON-invisible checks at any depth.**
  (`stitchkit/tools`) 0.15.0 widened a colliding field to `z.unknown()` when its
  kept schema carried a `.refine()`/custom check, but the check was **shallow** —
  it only inspected the top node. A constraint nested below the kept field — behind
  a `.pipe()` output, an object field, an array element, or a `.default()` wrapper —
  still leaked verbatim onto the sibling variant and rejected its valid value (the
  same advertise-stricter-than-union hole, relocated deeper). `hasChecks` is now
  **deep** (recurses through wrappers, object fields, array items and both sides of
  a pipe), so any hidden constraint on a collided key widens to `z.unknown()`.
  Found by a 3-agent final-validation pass. → ADR 0033.

## [0.15.0] — 2026-06-22

### Fixed

- **`flattenUnionInput` no longer produces an unsatisfiable schema when variants
  share a key with different shapes.** (`stitchkit/tools`) The variant-field merge
  was first-wins: two variants declaring the same key with a different type (e.g.
  `media: object` in one, `media: array` in another) silently dropped one → the
  advertised schema was *stricter* than the original union → for the losing
  variant **no valid input existed** (the advertised schema rejected one form, the
  union rejected the other). The merge now **widens** the advertised field to a
  superset — identical types kept, string literal/enum collisions merged into one
  widened `enum`, otherwise `z.unknown()` — so it accepts every variant's value
  while staying free of `oneOf`/`anyOf` (the original union still validates the
  real shape). Covers the same defect on differing enums, object shapes, defaults
  and nested unions. → ADR 0033.
- **Discriminator handling.** A multi-value `z.literal([...])` discriminator now
  keeps all its values, and a `z.enum` discriminator is accepted. A union that
  cannot be flattened (non-string discriminator, non-object variant) is left
  untouched instead of throwing — it no longer crashes the whole `mountMcp` build.
  → ADR 0033.
- **`validateMcpSchemas` now validates the schema that actually ships.** It
  ignored `flattenUnionInput`/`extend`, so the build-time deploy check vetted the
  *un-flattened* schema — falsely failing union inputs and hiding flatten
  incompatibilities. It now takes those options (forwarded by `createMcpHandler`).
  → ADR 0033.
- **`params` + discriminated-union input is now a mountable tool.** `params` and
  `input` are flattened separately then merged, so a union input becomes a
  `ZodObject` and merges with path params into one object — instead of an `allOf`
  intersection MCP rejected. → ADR 0033.
- **`coerceJsonArgs` repairs nested double-serialization.** It coerced only
  top-level args and skipped union inputs; it now recurses into object fields,
  array items and the matching variant of a discriminated union, so a model's
  stringified nested value is un-stringified at any depth. → ADR 0033.

### Added

- **`flattenUnionsDeep` recurses into plain `ZodUnion` members and `ZodRecord`
  values** — a discriminated union nested there now flattens too. → ADR 0033.

## [0.14.0] — 2026-06-22

### Fixed

- **Domain errors no longer collapse to `INTERNAL_SERVER_ERROR` on tool calls.**
  `AppError.is` used `instanceof`, but the package ships as two `bun build`s
  (browser + server) that each bundle their own copy of the `AppError` class. A
  consumer's domain error (`class DomainError extends AppError`, extending the copy
  from `stitchkit`) thrown inside an MCP / agent tool handler or `lifecycle.beforeHandle`
  was checked against the *server* build's copy → `instanceof` false → the real
  `code` / `details` / `hint` were dropped and the model received a generic
  `INTERNAL_SERVER_ERROR` (so weak models retried blindly, cascading 500s). HTTP via
  the framework was affected by the same fragility. `AppError.is` now identifies by a
  global `Symbol.for('stitchkit.AppError')` brand instead of `instanceof`, so every
  chunk's copy — and every consumer subclass — is recognised across the bundle and
  across realms. The brand is non-enumerable (invisible to JSON / spread / keys).
  Additive: it recognises everything `instanceof` did, plus the cross-boundary cases.
  → ADR 0032.

## [0.13.0] — 2026-06-22

### Fixed

- **`flattenUnionInput` now flattens nested discriminated unions, not just the
  top level.** (`stitchkit/tools`) The flag advertises a discriminated union as a
  flat object so a tool schema carries no `oneOf` / `anyOf` (which weaker models
  drop or mangle) — but it only ever flattened a union that was the *entire* input.
  A union nested inside an object field or an array item (e.g. a `content.parts[]`
  that is an array of a discriminated union) still reached the model as `oneOf`. It
  is now **deep**: every discriminated union is flattened at any depth — object
  fields, array items, and through `optional` / `nullable` / `default` /
  intersection wrappers — with `.describe()` hints preserved. Still advertised-only
  and lossy (the original schemas remain the validation schemas in
  `executeToolMethod`), still opt-in behind the same flag, and schemas a transform
  cannot safely rebuild (refined / piped / lazy / plain unions) are left as-is.
  → ADR 0031.

### Added

- **`flattenUnionsDeep`** (`stitchkit/tools`) — the recursive flatten exposed
  beside `flattenDiscriminatedUnion`, for building a `oneOf`-free advertised schema
  directly.

## [0.12.0] — 2026-06-18

### Added

- **`RequestEvent.httpMethod` — the contract verb on tool events.**
  (`stitchkit/observability`) A tool event carries `method: 'TOOL'`; `httpMethod`
  now carries the endpoint's declared verb (`POST` / `GET` / …), so one filter
  tells a read from a write across HTTP and tools —
  `(event.httpMethod ?? event.method) !== 'GET'`. The raw verb, not a derived
  `isMutation` flag (the app decides). A project can fold a hand-rolled tool audit
  into the single `createAuditHook`. → ADR 0030.
- **`errorDetail` on tool audit events** — a failed tool call now carries the
  structured `ToolResult.details` (sanitised) on `RequestEvent.errorDetail`,
  symmetric with the HTTP path. → ADR 0030.

### Changed

- **`setRequestError({ details })` now accepts `unknown` and sanitises it.**
  (`stitchkit/observability`) `details` was typed `JsonValue` (0.11.0), so passing
  a domain `AppError`'s `Record<string, unknown>` details needed a
  `JSON.parse(JSON.stringify(...))` round-trip to launder the type. It now accepts
  the detail raw and runs it through `sanitizePayload` (the same masking/capping as
  the payload) before it lands on `RequestEvent.errorDetail` — no pre-laundering,
  and `errorDetail` can no longer leak a secret. (Considered narrowing
  `AppError.details` to `JsonValue` instead — rejected, it breaks the boundaries
  that build an `AppError` from untyped network data. → ADR 0030.)

### Fixed

- **The access log renders the error code even when `onError` returns its own
  Response.** 0.10.0 rendered `errorCode` only on the framework-default error
  path, so a project with a custom error envelope saw `← 400` with no code. The
  code is now derived from the original error (side-effect-free, no double log) on
  the `onError`-Response path too. → ADR 0030.

## [0.11.0] — 2026-06-18

### Added

- **Audit events carry the endpoint's `(serviceName, action)` identity.**
  (`stitchkit/observability`) `RequestEvent` gains `serviceName` / `action` — the
  stable contract identity of the matched operation (→ ADR 0022), populated on the
  HTTP path and the tool path alike, from the contract rather than parsed from the
  URL. The HTTP pipeline writes it into the request context at route-match, *before*
  validation, so even a pre-handler (400) failure is attributed to its operation.
  A sink with `service` / `action` columns no longer parses them out of `path`.
  → ADR 0029.
- **`setRequestDimensions` — domain dimensions on the audit event.**
  (`stitchkit/observability`) `RequestEvent` gains an opaque
  `dimensions?: Record<string, string>` bag the core attaches no meaning to (the
  ADR 0021 passthrough pattern). Resolve a tenant / project / entity id cheaply
  from `ctx.params` / headers in `beforeHandle` (success) or `onError` (a
  pre-handler failure, which carries `ctx.params` / `ctx.req` since 0.10.0) and it
  lands on the event for the request, success or failure alike — instead of the
  sink re-deriving identity from the path. → ADR 0029.

  Together these let a project drop a hand-rolled `afterHandle` + `onError` audit
  and adopt `createAuditHook` (now identity- and dimension-complete), which also
  removes that split's success/error asymmetry.

## [0.10.0] — 2026-06-17

### ⚠️ Breaking changes

- **`createContractDispatcher` removed** (`stitchkit/tools`) — along with the
  `ContractDispatcher` and `ContractDispatcherConfig` types. It shipped in 0.9.0
  for one requesting consumer (a webview ↔ local-sidecar raw-WebSocket lane), who
  on integration did not adopt it: their boundary already had a ~40-line executor,
  the typed-envelope benefit was a ~10-line addition to their own wire, and
  migrating *to* the dispatcher was net +90–110 lines. No other consumer uses it,
  so the export is withdrawn rather than carried as speculative surface toward 1.0.
  The execution core (`executeToolMethod`) is unchanged and still internal — a BYO
  executor can be re-exposed on real evidence later. The rest of 0.9.0
  (`idempotent`, `createRetainedTopics`, `MultipartFile` / `FileDescriptor`, the
  open `TransportSource` union) is unchanged. → ADR 0028.

  ```ts
  // before: const d = createContractDispatcher(service, { source: 'local-ws' })
  //         const result = await d.dispatch(method, args)
  // after:  run the method on your own transport — validate the frame against the
  //         contract's Zod schemas and call the handler (the ~40-line executor a
  //         raw-WS/IPC lane already has). `ctx.source` stays an open tag.
  ```

### Fixed

- **`onError` now sees the path params and the request on a validation failure.**
  Body/param validation runs before `beforeHandle`, so a malformed request threw
  while the context was still being assembled — `onError` (and any audit built on
  it) received an empty context: no `params`, no request, so a pre-handler failure
  could not be attributed to the resource it targeted. The context is now bound
  from the URL (path params, request) *before* parsing, so a validation failure
  still hands `onError` the matched path params, the `Request`, and the endpoint
  identity. The schema-validated `params` / `input` still replace the raw values
  on success — no change to a successful request.

### Added

- **`req` / `url` / `headers` are first-class, typed fields on the handler
  context.** They were already present at runtime but only under the context's
  index signature (`unknown`), so reading them needed an `as` cast. They are now
  declared on `RuntimeContext` / `HandlerContext` as optional Web Fetch types
  (`Request` / `URL` / `Headers`) — set on the HTTP transport, absent on the tool
  transports (MCP / agent / CLI / a bring-your-own lane). The core stays
  Fetch-clean. Additive — existing code is unaffected.
- **The built-in access log renders the error code.** A failed request logged
  `← 400 3ms` with no code, though the framework already knew it. The completed
  line now carries it — `← 400 VALIDATION_ERROR 3ms` (dev) / an `errorCode` field
  (prod JSON and a custom `StitchLogger`).
- **`setRequestError` accepts structured `details`, surfaced as
  `RequestEvent.errorDetail`.** (`stitchkit/observability`) The error handler can
  record the structure the message string flattens (e.g. the failing Zod issues)
  alongside the code and message; `createAuditHook` carries it onto the audit
  event. Additive — `details` is optional.

## [0.9.0] — 2026-06-05

### Added

- **Run a contract over a bring-your-own transport — `createContractDispatcher`.**
  (`stitchkit/tools`) Drives a `defineContract` over a transport stitchkit does
  not own (a raw-WebSocket lane between a webview and a local sidecar, an IPC
  channel, a queue worker) without hand-rolling a method registry. `dispatch(method,
  args, context?)` runs a method by its contract key through the **same** execution
  core as the MCP / agent mounts — same Zod validation, the same `{ ok, data } |
  { ok: false, code, details, hint }` envelope, the same `beforeToolCall` /
  `afterToolCall` hooks and `beforeHandle` scope gate. The app keeps its own wire
  (framing, handshake, reconnect); stitchkit ships the executor, not a competing
  engine. → ADR 0027.
- **`idempotent?: boolean` on an endpoint** — a transport-neutral hint that the
  operation is safe to call twice with the same input (like HTTP `PUT`/`DELETE`).
  The core attaches no behaviour; it rides through to `MethodDef.idempotent`, where
  a retrying transport reads it to decide whether to replay a call after a
  reconnect. → ADR 0027.
- **`createRetainedTopics` — sticky events (retained last value).** (`stitchkit`,
  browser-safe) A transport-agnostic store that replays the last payload per topic
  to a late subscriber (MQTT retained / `BehaviorSubject`), so a subscriber that
  connects or re-renders after an event still sees current state.
  `createSocketIOClient` gains a **`retain`** option that uses it — list the
  server → client events to retain and a late `on()` handler is replayed the last
  value at once (and across a `disconnect()` / `connect()` cycle). → ADR 0027.
- **`TransportSource` is now an open union** (`… | (string & {})`) — the four
  built-in transports keep autocomplete, and a bring-your-own transport can tag
  its calls (`source: 'local-ws'`). Additive — no existing value breaks. → ADR 0027.

- **Typed client multipart accepts a platform file descriptor, not only `Blob`.**
  React Native / Expo represent a file as `{ uri, name, type }` (their `FormData`
  streams it from disk by `uri`); the client previously hard-required
  `file instanceof Blob`, forcing RN consumers to bypass the typed client and
  hand-roll `FormData` + `fetch` (losing baseUrl / auth / per-endpoint timeout /
  `ApiError` / output parsing). The multipart file field now accepts
  `Blob | FileDescriptor`, and the new public types `MultipartFile` and
  `FileDescriptor` let a consumer type its own upload helpers. The web / Bun path
  is unchanged (`Blob`); the descriptor is matched only when it carries string
  `uri` + `name` + `type` and is not a `Blob`.

## [0.8.1] — 2026-06-05

### Fixed

- **Browser bundlers no longer break on the root `stitchkit` entry.** A
  `createRequire` / `node:module` helper from the MCP-apps code was hoisted by the
  bundler (`--splitting`) into a shared chunk that the browser-safe root entry
  side-effect-imported, so a client build (Next.js / Turbopack) failed with
  *"the chunking context does not support external modules (request:
  node:module)"*. The browser-safe entrypoints (`stitchkit`, `/react`,
  `/contract`) are now built **separately** from the server / tools entrypoints,
  so no Node built-in can leak into their graph; a post-build
  `check-browser-clean` guard fails the build if one ever does, and the Node
  smoke test now also runs in the local `verify` gate (not just CI).

## [0.8.0] — 2026-06-05

### Server

- **Raw routes combine `:param` with a trailing `/*` wildcard** — `/app/:slug/*`
  now matches `/app/x/a/b` with `ctx.params.slug === 'x'` and the remainder in
  `ctx.params['*']` (an SPA deep-link fallback). Previously a trailing `/*` was a
  literal prefix and a `:param` before it was not interpolated, so such a route
  404'd. Pure literal wildcards (`/static/*`) are unchanged and now also expose
  the remainder as `params['*']`.

### Pagination

- **`encodeCursor` / `decodeCursor`** (`stitchkit`) — the opaque cursor codec that
  completes the pagination story (`Paginated` / `paginatedSchema` /
  `createCursorQuery` already shipped). Encode a keyset value (`{ v, id }`) into
  the `nextCursor` string and decode + Zod-validate it back (garbage / malformed →
  `null`, treated as "no cursor"). base64url over UTF-8 via `btoa`/`atob` — works
  on the server, the typed client and the browser, and a non-ASCII sort value
  round-trips (a naïve `btoa(JSON)` corrupts it; `Buffer` is not browser-safe).
  The keyset WHERE clause stays in the app (ORM-specific); this is only the
  string ⇄ value codec.

### Docs & packaging

- **The package now ships `llms.txt` + `llms-full.txt`** — a consumer-agent entry
  point. `llms.txt` is a curated index of the guide + reference; `llms-full.txt`
  inlines the whole guide for offline use. Generated from `docs/` by
  `bun run gen:llms` (runs in `build`). A coding agent in a consuming project
  reads them from `node_modules/stitchkit/`.
- **A Claude Code skill** (`skills/stitchkit/`) — the consumer build workflow for
  agents that support skills.
- **Breaking-change marking convention + an [upgrading guide](docs/guide/upgrading.md)** —
  a release that breaks a public API leads its changelog entry with a
  `### ⚠️ Breaking changes` section (with before → after); a version without one
  is purely additive. Docs reorganised into two roads — *build with* (README +
  guide + `llms.txt`) vs *develop* (AGENTS.md + CONTRIBUTING).

## [0.7.0] — 2026-06-05

### Errors

- **Published stitch error-code registry** — `STITCH_ERROR_STATUS` (the `code →
  HTTP status` map for the codes stitchkit itself emits), `StitchErrorCode` (its
  `keyof`, so type and map never drift) and `isStitchErrorCode()`, exported from
  `stitchkit` and `stitchkit/server`. A consumer maps stitch → app codes in an
  `onError` hook against `Record<StitchErrorCode, …>` instead of a hand-copied
  string list — a renamed/added code becomes a TS error, not a silent 500.
  `appError()` and the router resolve status through it (`METHOD_NOT_ALLOWED` →
  405). → ADR 0026.

### Tools

- **`afterToolCall` / `beforeToolCall` now receive the `MethodDef`** as a final
  argument — the tool-side twin of `afterHandle(ctx, result, endpoint)`. Read
  `endpoint.serviceName` / `.key` / `.meta` directly for audit / metrics; no
  toolName→identity map and no replicating the internal tool-naming (which lost
  audit rows for auto-named tools). → ADR 0022.

### Server

- **Configurable multipart upload limit** — `EndpointDef.maxUploadBytes`
  (per-route) and `createServer`/`createHandler` `maxUploadBytes` (global
  default) thread into `parseMultipart`, replacing the hard-coded 25 MB cap. A
  per-route value overrides the global; without either the 25 MB framework
  default applies (avatar 5 MB vs video 200 MB declared per endpoint).
- **Actionable missing-peer errors** — `createSocketIOServer` now turns a missing
  optional peer into `"needs the optional peer \"@socket.io/bun-engine\" — install
  it: bun add @socket.io/bun-engine"` instead of a bare `Cannot find module` at
  bootstrap.

### Docs

- New **peer-dependency matrix** (feature → packages) in getting-started, so the
  optional peers each feature needs are discoverable up front.
- Documented that span ids live in the observability request context
  (`getRequestContext()?.trace`), not on the handler `ctx` — the core carries a
  single `traceId`.

## [0.6.0] — 2026-06-05

### Range-capable file serving

- **`serveFile(req, opts)`** (`stitchkit/server`, Bun) — serve a file with full
  HTTP `Range` support (`206` / `416` / `Content-Range` / `Accept-Ranges`) plus
  the conditional-request handling Range correctness needs: weak `ETag`,
  `Last-Modified`, `If-Range`, and `If-None-Match` / `If-Modified-Since` → `304`.
  Handles `HEAD`, streams the byte range via `Bun.file().slice()` (no full read
  into memory), and auto-detects `Content-Type`. For media seeking / caching that
  `staticRoute` deliberately does not cover. → ADR 0023.
- **`parseByteRange(header, size)`** + **`weakETag(size, mtimeMs)`** — the pure,
  runtime-neutral core, exported for direct use and unit testing. Single-range
  only; multiple ranges return `null` (full `200`).
- **`staticRoute` now detects media MIME types** (mp4 / webm / mov / mp3 / m4a /
  wav / ogg / pdf / wasm / …) — the extension→MIME map is shared with
  `serveFile`. Behaviour is otherwise unchanged (still basic, in-memory).

### Resource-scoped mounting & client

- **`scopePrefixes`** on `createServer` / `createHandler` — a `scope → URL prefix`
  map (`{ tenant: 'tenants/:tenantId', … }`). Each `services` entry mounts under
  its `service.scope` prefix (`:param` segments reach the context); an unmapped
  scope mounts flat; explicit `groups` are unaffected. Declares the
  scope↔prefix mapping once instead of hand-partitioning into groups. Scope stays
  a free string. → ADR 0024.
- **Typed scoped client** — `stripPrefixKeys` (a `const` tuple) now adds the
  consumed keys as required, typed args on every method of the client
  `createClient` returns. `createClient(c, http, { stripPrefixKeys: ['tenantId'] })`
  → `api.list({ tenantId, … })` is typed; the per-tenant scoped-client type
  wrapper is no longer needed. The **bare-fetch client** (a plain `{ baseUrl }`
  config) now also honours `pathPrefix` / `stripPrefixKeys` — previously only the
  `HttpClient` path did, so the typed keys had no runtime effect there.
  `TypedHttpClient<C>` is now an alias of the new `ScopedHttpClient<C, unknown>`
  (structurally identical). → ADR 0025.

### Realtime

- **`SocketIOServerConfig.serverOptions`** — a typed passthrough for the rest of
  socket.io's `ServerOptions` (`maxHttpBufferSize`, `connectionStateRecovery`,
  `perMessageDeflate`, `connectTimeout`, …). On Bun the engine-level options
  (`maxHttpBufferSize`, ping heartbeat, `upgradeTimeout`) are now forwarded to the
  hand-built `@socket.io/bun-engine` too — previously only `path` reached it, so a
  configured `maxHttpBufferSize` was silently dropped and large emits truncated at
  the 1 MB default. → ADR 0008.

### Raw-route helpers

- **`respondJson` / `errorResponse` / `parseBody`** (`stitchkit/server`) — the
  three things every raw route re-implemented: a JSON response (`204` for
  null/undefined), the framework error envelope from any thrown value (via
  `normalizeError`, with `x-request-id` when in a request context), and a
  no-throw Zod body parse (`data | null`). Conveniences over the existing error
  normalization — raw routes and contract routes now return identical errors.

### Tools

- **`McpServerBuildConfig.extend`** — `ToolExtend` now reaches the batteries-path
  (`createMcpHandler` / `buildMcpServer`), not only the manual `mountMcp` /
  `mountAgent`. Add a tool argument (e.g. a `tenantId` resolved into handler
  context) without hand-wrapping every service. → ADR 0007.

### Endpoint identity for hooks & audit

- **`MethodDef.serviceName` + `MethodDef.key`** — stable `(service, action)`
  identity (contract prefix + endpoint key), populated by `implement` /
  `implementRemote`. Read it in `beforeHandle` / `afterHandle` / `onError` (or on
  a tool mount) to key audit / metrics — the action is not in the URL and
  `toolName` is absent on HTTP-only endpoints, so this is the only stable pair.
  → ADR 0022.
- **`implementRemote` now passes `EndpointDef.meta` through** — it was dropped for
  remote-proxied contracts (`implement` already carried it). → ADR 0021.

### Client

- **`ContractClientConfig` and `ClientConfig` are now exported from the root
  `stitchkit` entrypoint** — the per-tenant / resource-scoped client config and
  the bare-fetch client config (siblings of `HttpClientConfig` /
  `SocketIOClientConfig`, which were already exported).

### Fixed

- **`safePath` no longer ships raw control bytes in `server/logger.ts`** — the
  sanitiser was a regex literal containing literal `\x00`–`\x1f`/`\x7f` bytes,
  which older Bun regex parsers (≤ 1.3.5) reject at parse time, so `import
  'stitchkit'` threw on those versions (`engines.bun >= 1.2.0`). Rewritten as a
  char-code filter (no regex, no raw bytes); a regression test scans `src/**`
  for raw control bytes so it cannot recur.

### Docs

- Documented the `EndpointDef.meta` gotcha — declare a meta type as a `type` /
  inline literal / `satisfies`, not an `interface` (an interface is not
  assignable to `Record<string, unknown>`). Guide + ADR 0021 + field JSDoc.
- New **multi-tenant / resource-scoped** guide (`docs/guide/multi-tenant.md`) —
  contract → `scopePrefixes` server → auth → typed scoped client → `extend` for
  the AI surface, end to end.
- **Node deployment** documented — `serveNode` in getting-started and a "Deploy on
  Node" section (`@types/bun` peer, `transports: ['websocket']`, Bun-only helpers).

## [0.5.0] — 2026-06-05

### Endpoint metadata passthrough

- **`EndpointDef.meta`** + **`MethodDef.meta`** (`Record<string, unknown>`) — an
  opaque, app-defined per-endpoint metadata bag the core attaches no meaning to
  (the `scope`-style escape-hatch). It rides through `implement()` and is
  readable in lifecycle hooks (`beforeHandle`/`afterHandle`/`onError`) and on
  tool mounts — for app concerns the generic core does not model (feature gate,
  rate tier, cache hint, doc tag). Never serialized into OpenAPI. → ADR 0021.

## [0.4.0] — 2026-06-05

### Realtime — token handshake auth + a raw WebSocket lane

- **`SocketIOClientConfig.auth`** (`stitchkit`) — token-based handshake auth, the
  alternative to cookie auth (`withCredentials`). Reaches the server as
  `socket.handshake.auth`. A **function** form (sync or async) is re-read on
  every (re)connect, so a rotated token is picked up without recreating the
  client (and losing durable subscriptions). **`query`** and **`extraHeaders`**
  added alongside. No server change — the gate stays project `io.use(...)`.
- **`composeWebSocketHandlers`**, **`webSocketLane`**, **`socketIoLane`** +
  types **`ComposedLane` / `WebSocketLane` / `WebSocketComposeConfig`**
  (`stitchkit/server`, Bun-only) — compose Bun's single `websocket` handler from
  several lanes, so a truly-raw binary lane can run beside Socket.IO on one
  server. Routing is by a positive raw marker on `ws.data`; Socket.IO is the
  catch-all, so the engine's opaque data is never inspected — cast-free. → ADR 0020.

### MCP Apps — interactive UI widgets

A contract tool can now render an inline UI widget in the chat (MCP Apps /
SEP-1865). stitchkit owns the generic plumbing; the app owns the widget HTML/UI.

- **`EndpointDef.ui`** — a tool endpoint declares `ui: { resourceUri, visibility? }`;
  its MCP registration carries `_meta.ui` so a host renders the named `ui://`
  resource as a widget for that tool's results.
- **`McpServerBuildConfig.resources`** + **`mountMcpResource()`** (`stitchkit/tools`) —
  serve `ui://…` UI resources over `resources/list` / `resources/read`, default
  MIME `text/html;profile=mcp-app`, with per-resource `_meta.ui` (CSP, border, domain).
- **`inlineMcpAppBundle()`**, **`RESOURCE_MIME_TYPE`**, **`EXT_APPS_BUNDLE_PLACEHOLDER`**,
  **`McpResourceDef` / `McpAppCsp` / `McpAppResourceMeta`** (`stitchkit/tools`) —
  inline the `@modelcontextprotocol/ext-apps` runtime (new optional peer) into a
  widget HTML; the app keeps full ownership of the widget markup.

### CLI — the fourth transport

A `defineContract` now drives a command-line program too, peering with the HTTP,
MCP and agent surfaces — same validation, same auth gate, same error model
(HTTP ≡ MCP ≡ agent ≡ CLI). See [ADR 0016](./docs/decisions/0016-cli-transport.md)
and the [CLI guide](./docs/guide/cli.md).

- **`createCli()`** (`stitchkit/cli`, also `stitchkit/tools`) — build and run a
  CLI from contract services: `<app> <command> [positional] [--flags]`. Resolves
  identity once at startup, routes each command through the shared
  `executeToolMethod` pipeline. The `stitchkit/cli` entrypoint needs neither the
  MCP SDK nor `ai`.
- **`Transport` gains `'CLI'`, `TransportSource` gains `'cli'`.** CLI exposure is
  **opt-in** — a method is a command only when its `expose` lists `'CLI'`.
- **CLI-unique behaviour:** schema-aware argv coercion, positional args, piped
  stdin, `--json` / `--quiet` / `--dry-run`, per-`ToolResult.code` exit codes,
  `--output-dir` downloads, and a generic `--wait` poller (`pollUntilDone`).
- **`parseCliArgs`, `emitResult`, `DEFAULT_EXIT_CODES`, `CliConfig`,
  `CliWaitConfig`, `ExitCodeMap`** and friends are exported for advanced use.
- The core ships **no binary** — `createCli` is the building block; an app writes
  its own `#!/usr/bin/env node` executable and `bin` entry.
- **Output is JSON** — pretty-printed by default (like an MCP tool result),
  compact with `--json` for `| jq`. No hand-formatted tables; the audience is
  agents / scripts. Per-command `format` overrides are intentionally not shipped.
- **`passthrough`** — a command's unknown `--flags` fold into a freeform object
  field (`generate <model> --prompt … --aspect_ratio 16:9` → `parameters`), no
  `--parameters '{json}'` blob.

### Generic native MCP tools

The imperative tools the contract model can't express — shipped generic so an
app configures them instead of hand-rolling on the raw SDK. → [ADR 0019](./docs/decisions/0019-generic-native-tools.md).

- **`mountWait` / `mountDownload` / `mountUpload`** (`stitchkit/tools`) — native
  MCP tools (poll-until-done / save URL to disk / upload a local file); the app
  injects the domain (`poll` / `done`, `resolveUrl`, `upload`).
- **`pollUntil`** — one backoff/timeout poll loop behind both the CLI `--wait`
  (`pollUntilDone`) and `mountWait` — no duplicate loop.
- **`type McpServer` is re-exported** from `stitchkit/tools` so a native-tool
  registrar needs no direct `@modelcontextprotocol/sdk` import.

### Fixes

- **Remote errors keep their code.** `implementRemote` translates the typed
  client's `ApiError` to `AppError`, so a proxied remote `400` surfaces as a
  clean `VALIDATION_ERROR` (correct exit code, no stack) instead of being
  flattened to `INTERNAL_SERVER_ERROR`.
- **`z.record(...)` arguments are JSON-coerced** — a `--parameters '{…}'` string
  for a record-typed field now parses (was object/array only).

### Typed tool-path context

- **`createToolkit<AppContext>()`** (`stitchkit/tools`) — the tool-side mirror of
  `createImplement`. Returns context-pinned `mountMcp` / `mountAgent` /
  `buildMcpServer` / `createMcpHandler` / `createStdioMcpServer` / `createCli`,
  type-checking the injected `context` (and `ToolExtend.resolve`) against your
  app's context shape. Pure typing sugar; the loose form still compiles.
  See [ADR 0017](./docs/decisions/0017-typed-tool-context.md). `ToolExtend` is now
  generic (`ToolExtend<TContext>`).

### OpenAPI 3.1 from the contract

- **`generateOpenApiDocument()` / `openApiRoute()`** (`stitchkit/server`) —
  generate an OpenAPI 3.1 document straight from contract services (HTTP-exposed
  methods only), sharing the single `toJsonSchema` point and the `jsonSchemaFields`
  walker with the CLI `--help` table. No decorators, no parallel spec.
  See [ADR 0018](./docs/decisions/0018-openapi-generation.md).

### OAuth 2.1 for MCP

A remote MCP server can now be a native Claude (Desktop / web) custom connector —
the framework ships the OAuth 2.1 resource-server machinery, the app supplies
only identity and storage. See [ADR 0015](./docs/decisions/0015-oauth-resource-server.md).

- **`createMcpHandler({ protectedResource })`** — a `401` now carries
  `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1) so a client
  can discover the authorization server.
- **`oauthProtectedResourceRoute()`** (`stitchkit/tools`) — serves
  `/.well-known/oauth-protected-resource` (RFC 9728).
- **`mountOAuthProvider()`** (`stitchkit/tools`) — returns the authorization-
  server routes: AS metadata (RFC 8414), Dynamic Client Registration
  (RFC 7591), `/authorize` and `/token` with PKCE (RFC 7636) and resource
  indicators (RFC 8707). Pluggable `clients` / `codes` / `refreshTokens` stores
  and an `authorizeUser` login/consent callback.
- **`signJwt()`** (`stitchkit/server`) — HS256 signer, the issuing counterpart
  of `verifyJwt`; mints access tokens whose `aud` binds them to one resource.
- **`verifyPkce()` / `deriveCodeChallenge()`** (`stitchkit/server`) — S256 PKCE.

### Observability

- **`RequestEvent` gains `authMethod` and `clientId`** — the audit event now
  carries how a tool call authenticated (`'oauth'` / `'apikey'`) and the OAuth
  client id, threaded through `createAuditHook`.

### Security & correctness hardening (pre-release)

A per-file review of the unreleased surfaces above closed a set of holes before
the cut.

- **SSRF guard is now shared and applied to every fetched URL.** The
  `view_file` private-host / per-redirect-hop guard is extracted to one module
  and reused by **`mountDownload`** and the CLI **`--output-dir`** downloader —
  both fetch model/handler-derived URLs that were previously fetched raw. New
  `allowPrivateHosts` (download tool) / `allowPrivateDownloadHosts` (CLI) opt-ins.
- **A redirect to a non-`http(s)` scheme is refused.** A `302` to
  `file://` / `gopher://` no longer turns a fetch into a local-file read; the
  scheme is re-checked on every hop.
- **Download bodies are size-capped.** `mountDownload` / CLI downloads read with
  a byte cap (`maxBytes` / `maxDownloadBytes`, default 100 MB) so a hostile or
  unbounded URL cannot OOM the process.
- **CLI download filenames are contained.** A result `name` is reduced to its
  basename and re-checked, so `../../etc/x` cannot escape `--output-dir`.
- **`view_file` local reads are media-only + symlink-safe** — a non-media file
  (`config.json` / `.env`) inside the sandbox is refused, and a symlink that
  points out of the sandbox is rejected via a `realpath` re-check.
- **RFC 9728 metadata path fixed.** For a resource with a path
  (`https://h/mcp`), the protected-resource metadata is served at
  `/.well-known/oauth-protected-resource/mcp` (the path is no longer dropped).
- **PKCE is S256-only.** `plain` is removed (`verifyPkce(verifier, challenge)`,
  no method arg) — OAuth 2.1 forbids it for public clients.
- **DCR is stricter.** `refresh_token` is advertised in the registration
  response only when the grant is enabled; an `http` redirect URI is accepted
  only on a loopback host (RFC 8252).
- **OpenAPI accuracy.** Multipart endpoints are documented as
  `multipart/form-data`; DELETE input is documented as query params (matching the
  typed client, via the shared `inputIsQuery`); `requestBody.required` reflects
  whether the body schema has required fields; a single unrepresentable field
  (`z.date()`, …) degrades to `{}` instead of collapsing the whole endpoint.
- **CLI prototype-pollution & passthrough.** A `--__proto__…` flag (dotted or
  flat) is dropped at every argv write boundary; `--parameters '{json}'` merged
  with passthrough flags no longer loses the JSON payload.

## [0.3.0] — 2026-05-20

### Security hardening

A multi-agent audit of the framework surfaced and closed a set of holes.

- **Prototype-pollution defence at every input boundary.** A `__proto__` key in
  a JSON body, query string, cookie, multipart field, tool argument, path param
  or JWT claim is stripped before it can rewire a prototype chain. New
  `safeJsonParse` helper.
- **Real client IP, unspoofable by default.** `ctx.ipAddress` (and a raw
  route's `ctx.ipAddress`) is the actual socket peer — resolved by the adapter
  (`Bun.serve` / `srvx`), not a header. `HandlerConfig.trustProxy` (default
  `false`) switches it to the `x-forwarded-for` client for deployments behind a
  trusted proxy. A spoofed forwarded header is ignored unless `trustProxy` is
  set.
- **SSRF — `view_file` no longer follows redirects past the guard.** A public
  URL could `302` to an internal address; the guard now re-validates every
  redirect hop. A non-canonical numeric host (`http://2130706433/`) is rejected.
- **CORS — `credentials: true` with a wildcard origin is rejected** at
  construction. A rejected origin no longer receives `Allow-Credentials`.
  Origin matching is case-insensitive.
- **Internal error messages no longer leak.** An unexpected (non-`AppError`)
  error returns a generic `Internal server error`; the real cause is logged
  server-side. Applies to the HTTP response and the SSE error event.
- **Multipart uploads are capped before buffering.** The body is stream-read
  with a hard byte limit, so an upload with a missing / spoofed
  `Content-Length` can no longer exhaust memory.
- **JWT verification hardened** — an empty secret is rejected, `exp` / `nbf`
  honour a configurable clock-skew leeway (default 60 s), a non-numeric `exp`
  is malformed (not "non-expiring"), optional `issuer` / `audience` checks, an
  oversized token is rejected, and a non-base64url segment is rejected.
- **`createAuthHook` fails closed** — a scope with no matching rule now throws
  instead of silently passing the request. Identity resolution branches on the
  authoritative `ctx.source`, not the presence of `ctx.req`.
- **MCP session and event stores are bounded** — hard caps with LRU eviction
  on top of the TTL sweep, closing a memory-exhaustion vector.
- **`createHandler` is fully Web-Fetch-clean** — request timing uses
  `performance.now()`, not `process.hrtime`.
- A non-empty request body must declare `Content-Type: application/json` — a
  `text/plain` body (a forgeable cross-origin form post) is rejected.
- `staticRoute` uses `node:fs` (runs on Node, not just Bun), sets
  `X-Content-Type-Options: nosniff` and a content type, and rejects
  percent-encoded path traversal.
- The JSON-coercion of tool arguments is now an argument transform, not a
  schema wrapper — the advertised tool schema keeps its correct `required`
  fields. `withJsonCoercion` is replaced by `coerceJsonArgs`.
- Smaller fixes: rate-limiter LRU key-space cap, `afterToolCall` fires even when
  `beforeToolCall` throws, the response `x-request-id` is always the
  framework-resolved id, `createEventBus` takes an `onListenerError` hook,
  `traceparent` rejects the all-zero id, `buildToolManifest` tolerates an
  incompatible schema, `redact` no longer mislabels a shared subtree as
  circular.

### Tool ≡ HTTP parity — follow-up fixes

A post-0.2.0 audit found gaps in the contract-parity guarantee between the HTTP
and tool surfaces.

- **`createAuthHook` no longer silently skips tool calls.** It previously
  early-returned when there was no `ctx.req`, so a `createAuthHook` passed as a
  tool mount's `lifecycle.beforeHandle` enforced **nothing** — a scoped tool was
  callable by anyone. The hook now resolves identity per surface: `resolve`
  (HTTP, from `ctx.req`) or the new `resolveFromContext` (tool calls). A scoped
  tool call with no `resolveFromContext` **fails closed**.
- **HTTP output-validation mismatch is now `INTERNAL_SERVER_ERROR`.** A handler
  returning a value the contract `output` rejects is a server fault — it was
  reported as a client `VALIDATION_ERROR` (400). Now `500`, matching the tool
  transport.
- **ADR 0014** — the tool surface carries the same contract guarantees as HTTP.
  Records the invariant the parity fixes established; lists the intentional
  differences (error envelope, multipart endpoints are HTTP-only).
- New `tests/parity.test.ts` runs one contract's args through both surfaces and
  asserts identical accept / reject.

## [0.2.0] — 2026-05-20

### Tools — LLM robustness and mount extensions

New mount-time options for real-world LLM tool usage.

- **JSON coercion for tool arguments.** `coerceJsonArgs` (default `true`) on
  `mountAgent` / `mountMcp` / `createMcpHandler` — LLMs that double-serialize
  arrays/objects (sending `"[1,2]"` instead of `[1,2]`) no longer hit validation
  errors. New public `withJsonCoercion()` helper.
- **Discriminated union flatten for MCP.** `flattenUnionInput` on mount configs
  flattens a `z.discriminatedUnion` into a single `z.object` with an enum
  discriminator — MCP tools with variant inputs (patch operations) register
  instead of being rejected. New public `flattenDiscriminatedUnion()` helper.
- **Global error hints.** `errorHint` callback on mount configs — inject a
  recovery hint into every failed tool result (e.g. "try a different approach").
  Combined with per-error `AppError.hint` when both are present.
- **Tool manifest for deferred tools.** `buildToolManifest(tools)` produces a
  searchable `{ name, description, inputSchema }[]` from `collectTools()` — the
  primitive for building a `tool_search` native tool. `collectTools` and
  `MountableTool` are now public exports.

### Runtime-agnostic core

The core is now Web Fetch-clean — `createHandler` has no Bun globals. Node ≥ 22
is a supported runtime.

- **`stitchkit/node` subpath.** `serveNode(config)` runs the same `createHandler`
  on Node via [`srvx`](https://srvx.h3.dev). One contract, one `implement()`,
  one set of handlers — different import for the server bootstrap.
- **Type split.** `ServerConfig` is replaced by `HandlerConfig` (runtime-neutral,
  used by `createHandler`) and `BunServerConfig` (extends `HandlerConfig` with
  Bun-specific fields, used by `createServer`).
- **`new URL` fallback.** `createHandler` passes a base to `new URL(req.url)` so
  Node adapters that supply only a pathname no longer throw.
- **New exports from `stitchkit/node`:** `serveNode`, `NodeServerConfig`,
  `NodeServerHandle`, `createHandler`, `HandlerConfig`.
- **New exports from `stitchkit/server`:** `HandlerConfig`, `BunServerConfig`.
- `engines` in `package.json` now declares `node: ">=22"` alongside
  `bun: ">=1.2.0"`. `srvx` is an optional peer dependency.
- CI runs a Node 22 smoke test against the built `dist/`.

### ADR split

- Architecture decisions moved from a single `docs/DECISIONS.md` into individual
  files under `docs/decisions/` (one per ADR). New: ADR 0013 (runtime-agnostic
  core).

### Tools — tool-surface integrity

A pass over the MCP / agent layer to close the cases where a tool surface
silently diverged from the HTTP contract.

- **MCP tools fail loud on an incompatible schema.** A tool whose schema cannot
  be represented as JSON Schema (a `z.date()`, a `z.map()`, …) no longer
  vanishes from the surface with a `console.error`. `mountMcp` /
  `buildMcpServer` / `createMcpHandler` take `onIncompatibleSchema:
  'throw' | 'skip' | 'warn'` (default `'throw'`), and `createMcpHandler`
  validates a static `services` array at construction — a failed deploy, not a
  lost tool. New `validateMcpSchemas()` runs the same check on its own.
- **One Zod → JSON Schema conversion point** (`tools/json-schema.ts`) — the
  build-time validity probe now uses the same converter direction (`io`) the
  transport SDKs emit with, so it tests what is actually shipped.
- **Tool arguments are validated by the schema the tool advertises.** The
  advertised schema is no longer coerced or discriminated-union-flattened away
  from the schema used to validate a call — `withJsonCoercion` and the lossy
  union flatten are gone. An agent tool advertises a union / discriminated
  union natively; an MCP tool needs an object input (the MCP surface cannot
  advertise a top-level union), so a non-object input is reported through
  `onIncompatibleSchema` rather than shipped as an empty schema.
- **Tool calls parse params and input over disjoint argument slices**, like the
  HTTP transport — a `.strict()` contract schema now works as a tool.
- **Tool calls run a `beforeHandle` / `afterHandle` lifecycle.** `mountMcp`,
  `mountAgent`, `buildMcpServer` and `createMcpHandler` take a `lifecycle` —
  pass the same `createAuthHook` result used for the HTTP `beforeHandle` and
  tool calls are scope-guarded identically (previously a tool call bypassed it).
- **A tool's handler output is validated against the contract** (an
  `INTERNAL_SERVER_ERROR` on mismatch), as on HTTP.
- **A non-object `output` still yields `structuredContent`** — it is wrapped in
  `{ result: … }` for the MCP structured payload.
- **Cross-service tool-name collisions throw** in `mountMcp` / `mountAgent`.
- `mountAgent` now also accepts `ServiceDef | ServiceDef[]` (`mountMcp` already did).
- `defineContract` rejects an empty `desc` and a `toolName` on an endpoint not
  exposed on any tool transport.
- New exports from `stitchkit/tools`: `validateMcpSchemas`,
  `IncompatibleSchemaPolicy`, `ToolLifecycle`, `ToolCallHooks`, `ToolResult`.

## [0.1.0] — 2026-05-20

First public release.

### Contract

- `defineContract(meta, endpoints)` — one declaration describing an API: method,
  path, Zod `input` / `output` / `params`, `scope`, `expose` transports,
  `multipart`, per-endpoint `timeout`.
- `AppError` + `notFound` / `badRequest` / `unauthorized` / `forbidden` /
  `conflict` / `rateLimited` / `appError` — a single error model. `ErrorEnvelope`
  is the one error-response shape, shared by the server and the typed client.
- `paginatedSchema()` / `Paginated<T>` — the cursor-pagination envelope.

### HTTP server

- `createServer()` / `createHandler()` — HTTP on `Bun.serve()`, no HTTP
  framework dependency. Route groups, lifecycle hooks, raw routes, CORS,
  request logging, trace ids.
- `implement()` / `createImplement<Ctx>()` — type-safe handler binding.
- `createAuthHook()` / `createBearerResolver()` — scope-aware auth derived
  from `contract.scope`.
- `streamSSE()` / `parseSSE()`, `parseMultipart()`, `createRateLimiter()`,
  `createCache()`, `createEventBus<EventMap>()`.

### MCP & AI agents

- `createMcpHandler()` — a full MCP Streamable-HTTP server from contracts; the
  consuming app never imports `@modelcontextprotocol/sdk`.
- `createStdioMcpServer()` — serve contract tools over the **stdio** transport,
  as a subprocess of the MCP client. `buildMcpServer()` is the transport-neutral
  core shared by both MCP transports.
- `mountMcp()` mounts contract tools onto an existing server; `mountAgent()`
  produces Vercel AI SDK tools. `ToolExtend` adds host-supplied arguments.
- `implementRemote(contract, http)` — bind a contract to a remote HTTP API, for
  building a thin local MCP / agent server. Optional `transformArgs` hook.
- `instructions` on the MCP server config — a host-facing usage hint, surfaced
  to MCP tool-search.
- MCP tools register an `outputSchema` (from the contract `output`) and return
  `structuredContent` — the structured payload consumed by MCP App UIs.

### Observability

- `stitchkit/observability` — the audit layer above the raw hooks. A project's
  request logging becomes a table plus a `write` function.
- `createAuditHook({ write, filter?, sanitize? })` — wires the HTTP fetch
  handler and the `afterToolCall` hook into one sink, normalising every
  completed call into a `RequestEvent`.
- `wrapInRequestContext` + `getRequestContext` / `getTraceId` / `setRequestUser`
  / `setRequestError` — a per-request `AsyncLocalStorage` context.
- W3C Trace Context — `resolveTraceContext` / `parseTraceparent` /
  `formatTraceparent` / `childSpan`.
- `sanitizePayload` / `redact` / `truncatePreview` / `measureSize` — mask
  secret-named keys, drop binary blobs, cap payload size.

### Client & React

- `createClient()` / `createClients()` / `createHttpClient()` — a typed fetch
  client built from contracts (Ky-based, SSR cookies, error parsing).
- `createCursorQuery()` — the canonical cursor-paginated infinite query, built
  on `react-query-kit`.
- `createSocketIOClient()` / `createSocketIOServer()` — typed Socket.IO
  wrappers with durable subscriptions.
- `createCacheBridge()` — sync socket events into the TanStack Query cache;
  transport-agnostic.

[Unreleased]: https://github.com/max-listov/stitchkit/compare/v0.65.1...HEAD
[0.65.1]: https://github.com/max-listov/stitchkit/compare/v0.65.0...v0.65.1
[0.65.0]: https://github.com/max-listov/stitchkit/compare/v0.64.0...v0.65.0
[0.64.0]: https://github.com/max-listov/stitchkit/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/max-listov/stitchkit/compare/v0.62.0...v0.63.0
[0.62.0]: https://github.com/max-listov/stitchkit/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/max-listov/stitchkit/compare/v0.60.1...v0.61.0
[0.60.1]: https://github.com/max-listov/stitchkit/compare/v0.60.0...v0.60.1
[0.60.0]: https://github.com/max-listov/stitchkit/compare/v0.59.4...v0.60.0
[0.59.4]: https://github.com/max-listov/stitchkit/compare/v0.59.3...v0.59.4
[0.59.3]: https://github.com/max-listov/stitchkit/compare/v0.59.2...v0.59.3
[0.59.2]: https://github.com/max-listov/stitchkit/compare/v0.59.1...v0.59.2
[0.59.1]: https://github.com/max-listov/stitchkit/compare/v0.59.0...v0.59.1
[0.59.0]: https://github.com/max-listov/stitchkit/compare/v0.58.0...v0.59.0
[0.58.0]: https://github.com/max-listov/stitchkit/compare/v0.57.0...v0.58.0
[0.57.0]: https://github.com/max-listov/stitchkit/compare/v0.56.5...v0.57.0
[0.56.5]: https://github.com/max-listov/stitchkit/compare/v0.56.4...v0.56.5
[0.56.4]: https://github.com/max-listov/stitchkit/compare/v0.56.3...v0.56.4
[0.56.3]: https://github.com/max-listov/stitchkit/compare/v0.56.2...v0.56.3
[0.56.2]: https://github.com/max-listov/stitchkit/compare/v0.56.1...v0.56.2
[0.56.1]: https://github.com/max-listov/stitchkit/compare/v0.56.0...v0.56.1
[0.56.0]: https://github.com/max-listov/stitchkit/compare/v0.55.0...v0.56.0
[0.55.0]: https://github.com/max-listov/stitchkit/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/max-listov/stitchkit/compare/v0.53.2...v0.54.0
[0.53.2]: https://github.com/max-listov/stitchkit/compare/v0.53.1...v0.53.2
[0.53.1]: https://github.com/max-listov/stitchkit/compare/v0.53.0...v0.53.1
[0.53.0]: https://github.com/max-listov/stitchkit/compare/v0.52.0...v0.53.0
[0.52.0]: https://github.com/max-listov/stitchkit/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/max-listov/stitchkit/compare/v0.50.0...v0.51.0
[0.50.0]: https://github.com/max-listov/stitchkit/compare/v0.49.2...v0.50.0
[0.49.2]: https://github.com/max-listov/stitchkit/compare/v0.49.1...v0.49.2
[0.49.1]: https://github.com/max-listov/stitchkit/compare/v0.49.0...v0.49.1
[0.49.0]: https://github.com/max-listov/stitchkit/compare/v0.48.1...v0.49.0
[0.48.1]: https://github.com/max-listov/stitchkit/compare/v0.48.0...v0.48.1
[0.48.0]: https://github.com/max-listov/stitchkit/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/max-listov/stitchkit/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/max-listov/stitchkit/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/max-listov/stitchkit/compare/v0.44.1...v0.45.0
[0.44.1]: https://github.com/max-listov/stitchkit/compare/v0.44.0...v0.44.1
[0.44.0]: https://github.com/max-listov/stitchkit/compare/v0.43.1...v0.44.0
[0.43.1]: https://github.com/max-listov/stitchkit/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/max-listov/stitchkit/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/max-listov/stitchkit/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/max-listov/stitchkit/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/max-listov/stitchkit/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/max-listov/stitchkit/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/max-listov/stitchkit/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/max-listov/stitchkit/compare/v0.36.1...v0.37.0
[0.36.1]: https://github.com/max-listov/stitchkit/compare/v0.36.0...v0.36.1
[0.36.0]: https://github.com/max-listov/stitchkit/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/max-listov/stitchkit/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/max-listov/stitchkit/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/max-listov/stitchkit/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/max-listov/stitchkit/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/max-listov/stitchkit/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/max-listov/stitchkit/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/max-listov/stitchkit/compare/v0.28.1...v0.29.0
[0.28.1]: https://github.com/max-listov/stitchkit/compare/v0.28.0...v0.28.1
[0.28.0]: https://github.com/max-listov/stitchkit/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/max-listov/stitchkit/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/max-listov/stitchkit/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/max-listov/stitchkit/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/max-listov/stitchkit/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/max-listov/stitchkit/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/max-listov/stitchkit/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/max-listov/stitchkit/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/max-listov/stitchkit/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/max-listov/stitchkit/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/max-listov/stitchkit/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/max-listov/stitchkit/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/max-listov/stitchkit/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/max-listov/stitchkit/compare/v0.15.1...v0.15.2
[0.15.1]: https://github.com/max-listov/stitchkit/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/max-listov/stitchkit/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/max-listov/stitchkit/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/max-listov/stitchkit/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/max-listov/stitchkit/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/max-listov/stitchkit/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/max-listov/stitchkit/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/max-listov/stitchkit/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/max-listov/stitchkit/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/max-listov/stitchkit/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/max-listov/stitchkit/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/max-listov/stitchkit/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/max-listov/stitchkit/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/max-listov/stitchkit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/max-listov/stitchkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/max-listov/stitchkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/max-listov/stitchkit/releases/tag/v0.1.0
