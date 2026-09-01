---
title: "ADR 0142: A primitive leaves the runtime when nothing in it needs the runtime"
description: The rule that decides which agent-runtime internals are published for an application that drives the model itself — and, as importantly, which are not.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 0142 — A primitive leaves the runtime when nothing in it needs the runtime

## Context

Two consuming applications sit on either side of one boundary. The first adopted
`stitchkit/agent-runtime` whole — durable store, run protocol, recovery. The
second did not: its model loop is written over the SDK directly, because what it
needs is one call with a journal, and the runtime's price is a store and a
protocol it has no use for.

The second application is not doing it wrong. It is, however, re-deriving our
internals. Three cases surfaced within one week:

- provider usage and cost normalisation — already written, exported only through
  `openRouterProvider`, so reachable only by adopting the runtime;
- provider-failure classification — not published in any form, and rewritten by
  three applications, two of the copies byte-identical;
- **history compaction** — 387 lines in one application and 475 in another, both
  independently evolved, while `structuredCompaction` had shipped for months.

Three instances in a week is not three coincidences, and answering each one on
its own merits is how a public surface grows without a rule. The question is one
question: *which runtime internals mean anything outside the runtime.*

The compaction case also exposed a second failure that the first two hid.
`selectAgentHistory` was **already exported** and still nobody used it, because
it is typed against `AgentMessage` — a record only the store produces. A symbol
can be public and the thing it does still be behind the store.

## Decision

**A primitive is published for a non-runtime consumer when all three hold:**

1. **It needs no store.** No snapshot, no version, no compare-and-swap.
2. **It needs no run protocol.** No acquire/commit, no fencing, no recovery.
3. **It already exists inside and is proven by tests.** Publishing is exposing
   an implementation we depend on, never writing a second one for outsiders.

And one condition on *how* it is published, which the compaction case added:

4. **It is typed against what the caller already holds.** A primitive whose
   parameter type only the store constructs is not reachable, whatever the
   export list says. Where the internal type is genuinely the subject — a
   conversation record, in this case — the primitive keeps it and the reference
   says so plainly, rather than pretending the export settled the matter.

A primitive that fails any of the three is not published, and the reason is
recorded here rather than re-litigated per request.

### The candidates, judged

| Primitive | Verdict | Why |
|---|---|---|
| `normalizeOpenRouterUsage` | **published** (0.71.0) | pure function over an SDK usage record |
| `classifyProviderFailure` / `isToolResultFailure` | **published** (0.71.0) | pure functions over a thrown value |
| `selectAgentHistory` | already public | budget selection over a message list; reachability is the `AgentMessage` type, not the export |
| `selectCompactableHistory` | **published** (0.71.0) | the half of compaction that is arithmetic over a message list |
| `structuredCompaction` | **stays** | fails (1): reading a snapshot and writing it back under a version check *is* what it does |
| `createAgentRuntime`, run execution | **stays** | fails (1) and (2) |
| a context-pressure ratio (`used / window >= 0.75`) | **not published** | fails (3): one division, written nowhere inside, and exporting arithmetic is a maintenance promise bought for nothing. `contextUsage` (→ ADR 0140) already hands over both numbers |
| a model → context-window catalog | **not published** | fails (3), and it is data that ages between our releases while the provider answers it live |

The last two matter more than the ones we shipped: a rule you cannot fail is not
a rule, and both of these are things consuming applications actually hand-write.
We are declining to own them, on the record.

## Consequences

- `structuredCompaction` now calls `selectCompactableHistory` rather than
  containing its own copy of the selection, so the published function and the
  runtime cannot drift into two behaviours.
- Publishing a primitive is a patch, not a minor: it is additive by
  construction, and the caller who needed it was going to write it otherwise.
- The rule can refuse. Two named refusals above are the proof, and a request to
  publish something is answered against the three conditions rather than by
  weighing how useful it sounds.
- What this does **not** do is offer a second way to run an agent. Everything
  published under this rule is a function over values the caller already has;
  none of it starts, resumes or persists anything.
