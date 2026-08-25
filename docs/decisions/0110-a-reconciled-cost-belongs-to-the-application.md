---
title: "ADR 0110: A reconciled cost belongs to the application, not to the core"
description: "A provider figure that arrives after a run closed is joined in the application's own ledger on runId; the core reports what it observed and stores none of it."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0110 — A reconciled cost belongs to the application

## Context

ADR 0109 made the runtime's spend figure honest: a total says it was added up, an
unknown says `unavailable`, and a run that ended before the provider reported
anything says so instead of staying silent. That leaves a real question open.
Whether a provider bills for a call aborted mid-flight cannot be known inside the
process — the authoritative number arrives later, from the provider's own
accounting. A figure reported `unavailable` stays `unavailable` forever unless
something can attach the real one afterwards.

The obvious shape is to amend the terminal run. It runs into the store's central
invariant. A terminal run is an absorbing state: `commitRunTerminal` requires
`running | interrupt_requested`, `checkpointRunAssistant` requires `running`,
`recoverRun` requires `queued | running | interrupt_requested`. Nothing may touch
a run once it is terminal, and the fencing and CAS design rests on that.

Worse than the guard is the coupling. Every mutation compare-and-swaps the
**conversation head**, so a late billing write would bump the conversation
version and make a concurrent `replaceCompactedRange` conflict — and a
conflicting compaction discards the summary it just paid a model to produce. **An
accounting write would be able to throw away a model-generated summary.** That is
decisive on its own, independent of taste.

The append-only alternative avoids the coupling and costs more than the feature:
a new driver namespace, a new table, its own pagination and its own entry in the
public conformance kit — a second write path every adapter must implement. The
cheap shape has the bad coupling and the good shape is expensive, which is itself
a signal about where the feature belongs.

## Decision

**A cost learned after a run closed is joined in the application's ledger, keyed
by `runId`. The core neither stores it nor accepts it.**

The core's duty is to report what the process observed and to name what it did
not. Nothing else can see that; the core is the only place it can come from. An
externally-sourced authoritative number is a different kind of fact — it is
accounting, and ADR 0002 keeps billing out of the core.

The tell is the question the alternative needs answered next: *what happens to a
reconciled figure for a run the application can no longer find?* That is a
retention question. Retention is a ledger's problem, not a runtime's, and a
runtime that has to answer it has become one.

Everything reconciliation needs is already there and already durable: a stable,
externally-resolvable `runId`, and — since ADR 0109 — a per-run figure that is
either true or honestly `unavailable`. The application writes its own spend row
keyed by that id and updates it when the provider's accounting arrives.

**If this is ever revisited**, the shape is fixed in advance by the argument
above: append-only, keyed by `runId`, **outside** the conversation aggregate and
with no head CAS — precisely so accounting can never conflict with a conversation
operation. It would need its own ADR superseding this one.

## Consequences

Three requests follow this one predictably, and all three are refused here rather
than argued again later:

- **The core records a currency; it never converts one.** `AgentCostValue`
  carries an ISO code so a reader knows what it is holding. Two costs in
  different currencies report `unavailable` rather than a converted total.
- **The core never aggregates.** No sums by user, model, day or purpose. A spend
  figure belongs to one run.
- **The core never enforces a budget.** Refusing work because a limit was reached
  is a product decision, and ADR 0002's "no billing in the core" is the literal
  precedent.

What the core does owe, and what stays open, is that the figure it reports should
survive the channel that carries it — today usage exists only on two bounded,
drop-on-overflow sinks with no durable counterpart. That is a reporting duty, not
a ledger, and it is tracked separately.

## Alternatives considered

**Amend the terminal run.** Cheapest for an adapter — the run is an opaque JSON
payload, so a new optional field needs no migration — and it is the one that lets
an accounting write conflict a compaction into discarding a paid-for summary.

**An append-only amendment log inside the store.** Correct in isolation and a
second write path for every adapter, to hold data the core has no other reason to
know.

**Do nothing and leave `unavailable` as a dead end.** This is what is chosen —
but only because it is *not* a dead end: the application joins on `runId`. It
would be one if the core had no stable external identity for a run, and it does.
