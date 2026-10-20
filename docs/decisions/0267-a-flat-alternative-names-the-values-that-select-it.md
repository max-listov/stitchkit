---
title: "ADR 0267: A flat alternative names the values that select it"
description: "Each structural alternative of a field shared by flattened variants carries, as its description, the discriminator values that select it; the link stays text, never `oneOf`."
type: decision
status: accepted
created: 2026-10-20 08:25 +07:00
updated: 2026-10-20 08:25 +07:00
---

# ADR 0267 — A flat alternative names the values that select it

**Invariants:** I1, I2. Amends [ADR 0205](0205-flat-tool-collisions-retain-structural-alternatives.md).

## Context

ADR 0205 keeps the distinct shapes of a field the variants share as an `anyOf`, ordered
canonically so that one union reads the same however its variants are listed, and leaves
the discriminator-to-field correlation out of the presentation. For a union whose variants
differ only by such a field — `{ type, data }` with a different `data` per `type` — that
leaves a model the discriminator as an enum and a set of shapes, and nothing that pairs them:
it is told `type: text | image | quiz` and three shapes for `data`, and it guesses.

## Decision

Each alternative of the joined field carries `description: "When <discriminator> = <values>."`,
naming every discriminator value whose variant has that shape (`photo | video` for a shape two
values share). The correlation is text: it adds no `oneOf`, no conditional keyword and no vendor
keyword, so the schema stays inside the one profile every provider is served (ADR 0047) and
validates exactly the same values. The canonical order of the alternatives is unchanged.

## Consequences

A model reading a flattened tool can pair each shape with its value. The structural alternatives
of ADR 0205 gain a description each; a test comparing the exact flattened shape lists it
(`tests/flatten-structural.test.ts`, `tests/flatten-collision.test.ts`,
`tests/collided-field-keeps-type.test.ts`), and
`tests/flatten-alternative-labels.test.ts` proves the labels, including one shape shared by two
values. Validation is unaffected: the original Zod schema still owns parsing.
