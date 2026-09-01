---
title: "ADR 0140: The runtime tells a step how full the context is"
description: contextUsage reports the last completed step's prompt size with its provenance beside the model's window, because only the runtime sees both what was composed and what the provider received.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 0140 — The runtime tells a step how full the context is

## Context

A run reached a hard context overflow without changing its behaviour on a single
step before it. It could not: nothing had told it a limit was approaching, so
there was no moment at which compacting or finishing became the obvious move.

Only the runtime can tell it. The consumer counts what it composes and the
provider reports what it received; neither party sees both numbers, and the
runtime sees both.

## Decision

`AgentRuntimeRunContext` carries `contextUsage` — `usedTokens` beside the
model's declared `contextWindow` — so every step and every `tools()` call can
read it.

**The number is the last completed step's prompt size.** Not the run's
cumulative `usage.inputTokens`, which counts every step's prompt again and is a
multiple of the real fill: substituting it reports a model as overflowing while
it has room. The guide already warns against exactly this substitution, and the
warning existed because the mistake is natural.

**Absence is reported as absence.** Before the first step lands there is no
provider-reported number, and `usedTokens.provenance` is `unavailable` — which
is a different fact from zero, and zero would read as "the window is empty".
`usedTokens` is an `AgentUsageValue`, so it carries the provenance vocabulary
the rest of the surface already uses (→ ADR 0109).

**No fraction, and no output reserve.** Dividing is one line where the number is
rendered, and a quotient of an estimated numerator would need provenance of its
own to be honest about what it is. The reserve is not here because this layer
does not choose it — the consumer's prompt budget does — and reporting a number
this layer does not own would be a second copy that can disagree.

## Consequences

- How the number reaches a model is the consumer's decision, and remains so.
  Placing it in the system instructions invalidates the provider's prefix cache
  for the whole conversation on every step; the cheap placement is at the tail
  of the conversation, where the prefix survives. The runtime supplies the fact
  and takes no position on the rendering.
- The value is read through a getter on the run context, so a step sees the
  state after the previous step landed rather than a snapshot taken once at the
  start of the run.
