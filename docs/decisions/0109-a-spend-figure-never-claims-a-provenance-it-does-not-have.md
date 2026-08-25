---
title: "ADR 0109: A spend figure never claims a provenance it does not have"
description: "The runtime reports what it observed, names what it did not, and labels a number it derived as derived — so a caller can tell a total from a floor from a silence."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0109 — A spend figure never claims a provenance it does not have

## Context

`AgentUsage` has carried `provenance` on every field since it existed:
`provider-reported | computed | estimated | unavailable`. The emission did not
use it honestly, and three separate figures were wrong as a result.

**A successful multi-step run reported one step's money.** The step loop assigned
rather than accumulated, and the `finish` branch grafted the surviving `cost`
onto the SDK's token aggregate — which has no cost of its own. A three-step run
costing $0.50, $1.00 and $1.50 reported **$1.50**, beside all 6 000 of its
input tokens, labelled `provider-reported`. Half the money, on the ordinary
path, with no abort involved — and the shortfall grows with the number of steps,
though not by any fixed ratio: it is whatever every step but the last cost, and
the last step is often the expensive one.

**A run that ended before the provider's `finish` reported nothing.** The `usage`
key was absent — not zero — so "never reached the provider" and "burned a minute
of the most expensive model available" were indistinguishable to a reader.

**A run terminated by another actor reported nothing either.** Both event emits
sat behind `committedByCaller`, so an executor that lost the terminal CAS
published no record of what it had spent.

## Decision

**The runtime reports what it observed, names what it did not, and never lets a
number it derived wear the provider's word.**

**Sums are `computed`.** A total this code produced is `computed` however
`provider-reported` its parts were. The distinction is not pedantry:
`provenance === 'provider-reported'` is the obvious predicate for "a figure I can
bill against unchanged", and a sum is not that. A single step passes through
untouched, so a one-step run still reports the provider's number with the
provider's word.

**A run total is `computed`; a step figure is `provider-reported`.** That line
is where the two labels divide, and it does not move by field. The AI SDK's
`totalUsage` is a sum the SDK performed over per-step provider figures, not a
number any provider reported for the run — which loop did the adding is not a
difference a caller filtering for a billable figure cares about. Keeping the
provider's word on it made one run report `provider-reported` on success and
`computed` on abort for the same arithmetic.

**A token floor is `computed`; a cost floor does not exist.** A token total
missing a step is still a useful diagnostic, so it is reported as a sum. A cost
missing a step is `unavailable` — money is what people bill against, and "at
least $1.00" reported as `$1.00` is the defect this ADR is about, one level down.
It also has to *stay* unknown: a floor that forgot it was one recovered into a
confident total as soon as the next step reported.

**`unavailable` is a value, not an omission.** A terminal event always carries
`usage`. A run that reported nothing carries every field `unavailable`. Silence
is not a smaller version of zero — they are opposite claims, and only one of them
is free.

**A field no step reported stays `unavailable` rather than becoming zero**, and a
sum containing an `unavailable` component is a floor. Treating an unknown as zero
is how a sum quietly becomes a lie.

**Two currencies do not add.** The core records a currency; it never converts
one. Adding a USD cost to a EUR cost by keeping the first label would report a
number that is quietly not the total, so the sum reports `unavailable` instead.

**The two event channels are gated for their own readers.** The delivery
`terminal` event stays behind `committedByCaller`: it carries the assistant
message to the application's transport, and publishing it for a run someone else
committed would deliver the turn twice. The operator `run-terminal` event is not
gated: a losing executor still ran and still spent. Delivering a turn twice is a
user's problem; omitting a run's cost is an operator's, and neither channel
should pay for the other's constraint.

## Consequences

An existing reader filtering on `provenance === 'provider-reported'` stops
matching multi-step totals. That is the point — it was matching a wrong number —
and it is a `### ⚠️ Breaking changes` entry with no compile error behind it,
which is exactly the shape `AGENTS.md` means by "never break silently".

The core still stores no spend. `AgentUsage` reaches consumers on events and in
`AgentRuntimeResult.metrics`, and nothing is written to the durable record; where
a figure lives afterwards remains the application's (→ ADR 0002, no billing in
the core). Two known gaps stay open and are tracked rather than closed here: the
spend figure has no durable home and its channels may drop it under load, and a
cost learned after a run closed has nowhere to attach.

## Alternatives considered

**Add a provenance member for "at least this much".** The enum answers *how did
you get this number*; completeness is a second axis, and one enum answering two
questions breaks every exhaustive switch in both directions — a reader handling
`'computed'` would silently lose the floor case. Completeness belongs beside the
figure, not inside its derivation label.

**Report peak input tokens on aborted paths** — the context size rather than the
billed sum. It would make one field mean cumulative billing on one path and peak
context on another, distinguished only by `terminalReason`. Peak stays derivable
from `step-finished`, where each step already carries its own input count.

**Leave the omission and document it.** A reader cannot act on a distinction the
data does not carry, and every consumer would reinvent the same placeholder.
