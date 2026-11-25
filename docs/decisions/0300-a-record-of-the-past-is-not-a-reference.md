---
title: "ADR 0300: A record of the past is not a reference, and a conversation address is not the model's to give"
description: A declared application key may retain a value naming the source conversation, a run or a message as a record of the past; the runtime's own records cross a branch by their type; runtime tools that act for a conversation take it from the run the runtime started, within limits their owner declares, never from the model.
type: decision
status: accepted
amends: ["0298"]
amendedBy: ["0328"]
created: 2026-11-21 22:51 +08:00
updated: 2026-11-25 13:41 +08:00
---

# ADR 0300 — A record of the past is not a reference, and a conversation address is not the model's to give

Amends the application-key rule in [ADR 0298](0298-an-application-file-crosses-a-branch-by-declaration.md). Serves **I8**, **I12** and **I15**.

## Context

ADR 0298 let a host declare key names it uses for its own data, and kept one
guard: a declared key whose value names an identity of the source conversation
refuses. A consuming project keeps the ID of the run that took each input in the
input's metadata, and its tools that read its own data answer with run and
conversation IDs. Both are records of what happened. Under the guard such a
conversation could not be branched at all.

Rewriting those values to the destination's identities is not an answer. The
provider journal holds what the model was actually sent and is copied
unrewritten, so a rewritten tool output would disagree with it; and a record
that says "run X took this" is false once X is renamed.

While reviewing this, the runtime's own child and schedule tools turned out to
take the conversation they act for from the model's input. Any conversation
address the model saw — in history, in a tool output, in a branch's records —
was authority over that conversation's child budget, children and schedules.
The state and event search tools took their conversation from a free host
argument that nothing tied to the run they served. And the model, not the host,
chose how many children to spawn and with what budget, and how often a schedule
repeated: the child manager and the schedule service had no limits of their own.

## Decision

`applicationKeys` declares each key once, with a named mode instead of a pair
of lists:

- `sourceIdentity: 'refuse'` (default) — the value is data. One that names the
  source conversation, an identity it defines or a declared application file
  refuses the branch.
- `sourceIdentity: 'retain'` — the value may be a record of the past. A value
  naming the source conversation, one of its runs or one of its messages crosses
  byte for byte and is never read as a reference by the destination. These three
  are defined before any value is judged, so the answer does not depend on event
  order. A value naming a spill, an application file, a tool call, an approval,
  an operation, an idempotency key, a schedule, a child or an owner still
  refuses: what such a value grants crosses only by its own contract. (amended by ADR 0328: `applicationKeys` adds `sourceIdentity: 'rekey-spill'` to rekey source spill references — live or legitimately expired — while still refusing foreign spills and all other source identities.)

A key is one of the runtime reference names the branch reads; a misspelt name
would declare nothing, so the schema refuses it. A refusal names the key's path
inside the payload, never its value, so a host can locate it in an archive it
must not disclose.

Runtime tools that act for a conversation are created for the run that calls
them: `createAgentChildTools`, `createAgentScheduleTools`, `createAgentStateTools`
and `createAgentEventSearchTools` take the run context the runtime passes to
`tools()`, read the conversation from its run, and refuse a context no runtime
issued. Their input schemas carry no conversation address. An ID in front of the
model is information, never an address to act on, and a free host argument is
not an address either: nothing ties it to the run the tools serve.

How much such a tool may spend is the owner's to bound, not the model's: the
child manager requires the parent's remaining budget and a number of active
children, the schedule service a number of active schedules per conversation and
a shortest repeat. The tool factories add no limits of their own, so each limit
has one place.

The declaration is for the application's data only. Records the runtime's own
capabilities wrote cross by their type, and a host declares nothing for them:

- A model invocation record is a receipt of a call a conversation made. It
  crosses as an inert observation, so no ledger reader counts it as the
  branch's invocation, and it keeps naming the conversation and run that made
  the call: rewriting them would make the receipt false and would cut it off
  from its body, whose encryption is bound to that conversation. The encrypted
  body does not cross: a branch copies bytes only under a fresh authorization
  the host gives for them, as it does for spills, and there is none for these.
  A record taken from the source's ledger must belong to the source and name one
  of its runs; one an earlier branch carried crosses as it is.
- A deferred tool selection receipt names itself in `kind` and selects tools for
  one run; its `runId` follows that run's copy. The search tool's name is the
  host's to choose, so the receipt is recognised by what it is. One that names no
  run of the conversation is application data.
- What the event search tools were asked and answered is a record of what the
  model read. It crosses as it was, under the tools' own shapes — an input by its
  keys alone, since a call the tool refused stays in the history — with
  encrypted invocation bodies removed. It may name the source's spills, events
  and runs; those addresses are inert in the branch, because the runtime reads
  each of them only through the conversation asking.

Every event kind has one branch rule, and the table of rules is checked against
the event vocabulary by the compiler: a kind added without a rule does not
build. Two ledgers share the kinds `provider/request` and `provider/response`;
the ledger reader and the branch tell their records apart with one function.

## Consequences

- A conversation whose application records name its own runs branches and
  restores; the records read the same in the destination and in the journal.
- A retained ID is visible to the destination's model. A host tool that accepts
  such an ID checks it against the conversation calling the tool, as the
  runtime's own tools now do by construction.
- The guard is one hop deep: after a branch of a branch, an ID of the first
  source is no longer a source identity and passes under either mode. The
  guard catches a reference carried by accident; it is not a provenance system.
- A conversation that used the invocation ledger, the deferred tool search or the
  event search tools branches without any declaration. Before, the ledger made a
  conversation unbranchable, and the two tools forced a host to declare the
  runtime's own fields as application keys.
- A branch does not hold the bodies of the provider payloads its source recorded;
  its receipts name the source conversation, where a host reads them.
- Under `throughRunId`, the boundary run's invocation receipt can lack its
  finished record: the ledger finishes an agent invocation after the run's
  terminal, which is where the selected history ends.
- Callers migrate `applicationKeys: ['messageId']` to
  `[{ key: 'messageId' }]`, create the built-in tools inside `tools()` from the
  run context, and give the child manager and the schedule service their limits.
- A host that runs its own model loop without the runtime holds no run context
  and cannot use the built-in tools; they exist for runs the runtime owns.
