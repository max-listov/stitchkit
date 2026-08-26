---
title: "ADR 0111: The driver is the extension point, and the agent runtime is not stable yet"
description: "AgentRuntimeStore stops being a public implementation target so its growth costs adopters nothing; promotion to stable waits on two named conditions, not on a feeling."
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0111 — The driver is the extension point

## Context

ADR 0103 requires a promotion from **evolving** to **stable** to be its own
decision. `stitchkit/agent-runtime` has never had one, and the question has been
deferred on a loop: promotion needs evidence from a real consumer, a real
consumer needs a stable surface.

**The loop was already broken and nobody had looked.** A consuming project has
been running on `createAgentRuntime` with its own durable store adapter,
exercised against the public conformance kit. The evidence exists. Collecting it
changes the two open questions from opinion into measurement.

### What the evidence says

**The aggregate is not what adopters implement.** The consumer's adapter ends:

```ts
const driver: AgentRuntimeStoreDriver<TransactionClient> = { … }
export const store = createAgentRuntimeStore(driver)
```

It implements the **driver** — `transaction`, `head`, `runs`, `admissions`,
`history`, `scanRecoverable` — and receives the nine-member aggregate built from
it. So the argument that closed this question in the other direction is wrong on
the facts: `AgentRuntimeStore` grew by three members in three releases, and every
one of them cost the driver population **nothing**. `absorbQueuedRun`, the most
recent, is composed from `runs.save` twice and needed no driver change at all.

**Adoption is cheaper than hand-rolling by a factor of five.** The consumer's
entire agent layer, including a 509-line Prisma driver, is roughly 1 800 lines.
Two other projects in the same family that own their loops are at roughly 5 000
and 9 500 lines for the same job.

**And the surface really is volatile**: breaking changes in **six of the eight**
minors since it shipped. That figure is derived from the changelog by
`scripts/surface-cadence.ts` rather than counted by hand — a count kept by hand
beside a maturity table is a count that rots, and the first hand count for this
ADR said five.

## Decision

**The driver is the supported extension point. `AgentRuntimeStore` is a contract
you receive, not one you implement.**

`AgentRuntimeStore` stays exported, because it is the type of
`AgentRuntimeConfig.store` and a caller must be able to name it — and it stays
implementable, for an in-process double or a store that is not a database.
What changes is what its growth *means*: **adding a member to the aggregate is
not a breaking change**, because the supported way to obtain one is
`createAgentRuntimeStore(driver)`. Adding a member to the **driver** is, and that
is where the stability promise lives.

This is itself a change of contract and is announced as one. Without it, an
adopter reads three aggregate members in three releases as three migrations, when
in fact they were none.

**The agent runtime is not promoted to stable today.** Two conditions remain, and
they are checkable rather than atmospheric:

1. **A minor with no breaking change to the surface.** Not a promise to stop
   breaking it — evidence that it has stopped. One release is a weak signal and
   is deliberately the bar: the point is to have a bar at all, not to pick a
   comfortable one. The release carrying this ADR breaks the surface itself, so
   the count stands at seven of nine and the condition is unmet by construction;
   the next release is the earliest that could meet it.
2. **The known reporting gaps are closed or declared.** A spend figure can still
   be dropped by a bounded sink — recoverable from the run record, but only by a
   reader who knows to look — and compaction spend is reported only when the
   application's own `summarize` counts it. A stable surface may carry gaps; it
   may not carry undocumented ones.

The third condition is discharged by this ADR: the `AgentRunEvent` shape. It was
one flat object for three kinds of event, so `usage` had to be optional even on a
terminal, and the guarantee "a terminal event always carries `usage`" lived in
prose while the published migration snippet for it did not typecheck. It is now
a discriminated union by `type`, and the invariant is held by the schema.

**Separately, and permanently: "no consumer depends on this yet" is never an
argument for breaking an evolving surface.** It was offered twice in one
afternoon in this repository, and it was false both times — a consumer already
existed. The authority for breaking an evolving surface is ADR 0103, which does
not rest on a fact nobody can check. A published package cannot enumerate who
installed it, so an argument of that shape is unfalsifiable in principle and
happens to be wrong in practice.

## Consequences

An application that implements `AgentRuntimeStore` directly is on an unsupported
path and should move to the driver; the changelog says so and the guide shows the
one-line composition. Its own tests keep working — nothing is removed.

Aggregate growth stops being announced as breaking, which is a smaller changelog
and a truer one. Driver growth is announced as breaking and will be rarer,
because the driver is six things and they are storage primitives.

Promotion is now a checklist rather than a mood, and the next person to ask does
not re-derive any of this.

## Alternatives considered

**Promote now.** The surface broke in six of its eight minors, twice today. A
stable declaration that is contradicted within a fortnight is worth less than no
declaration, because it teaches a reader that the table lies.

**Freeze the aggregate instead.** It would make the ninth member a mistake rather
than a non-event, and it would push every future capability into the driver —
where it costs every adapter, which is exactly backwards.

**Keep deferring.** The loop it was deferred on does not exist; continuing to
cite it would be citing something already known to be false.
