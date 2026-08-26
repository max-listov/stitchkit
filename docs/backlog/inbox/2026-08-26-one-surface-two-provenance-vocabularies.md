---
title: One surface, two provenance vocabularies
description: AgentUsageValue and AgentTokenCount describe token counts for the same request with different words and different numeric types.
type: task
status: inbox
created: 2026-08-26
updated: 2026-08-26
---

## Зачем

Two enums in one entrypoint describe the same kind of fact — how a token count
came to be known — and they do not share a word:

| type | provenance values | number |
|---|---|---|
| `AgentUsageValue` (`schemas.ts`) | `provider-reported`, `computed`, `estimated`, `unavailable` | `z.number()` — **accepts 3.5 tokens** |
| `AgentTokenCount` (`prompt.ts`) | `measured`, `estimated`, `unavailable` | `z.int()` |

Both describe token counts for the same request: `AgentPromptBudget.toolSchemas`
beside `AgentUsage.inputTokens`. Neither accepts the other's terms — a probe
confirms `AgentUsage` rejects `measured` and `AgentTokenCount` rejects
`provider-reported`. A consumer holding both writes two switches over what is
conceptually one question, and `measured` versus `provider-reported` is a
distinction nobody can explain without reading both files.

This is not wrong today. It is the shape most likely to have to break later,
which is exactly what a stable declaration must not carry (→ ADR 0111).

## Результат

- One vocabulary for how a number came to be known, or a written reason why two
  are correct.
- Token counts are integers wherever they are counted.

## План

- [ ] Decide whether `measured` and `provider-reported` are the same fact. If
      they are, one word survives and the other is a breaking rename.
- [ ] Decide whether a budget estimate and a spend figure genuinely need
      different vocabularies — a defensible answer is that one is a *forecast*
      and the other a *report*, and if so, say it where both are defined.
- [ ] Make token counts integral in both. A fractional token is not a thing, and
      `z.number()` accepting `3.5` is how a bad estimator's output survives
      validation.
- [ ] Whatever is decided lands before any promotion to stable, because it is a
      rename across a public surface.

## Acceptance

- [ ] A test enumerates both vocabularies and fails if they diverge again in a
      way the decision did not sanction.
- [ ] A fractional token count is refused wherever tokens are counted.
