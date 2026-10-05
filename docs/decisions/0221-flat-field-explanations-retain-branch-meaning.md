---
title: "ADR 0221: Flat field explanations retain branch meaning"
description: "Structural joins deduplicate constraints independently from discriminator-qualified descriptions and applicability."
type: decision
status: active
created: 2026-10-01 10:30 +07:00
updated: 2026-10-01 10:30 +07:00
---

# ADR 0221 — Flat field explanations retain branch meaning

## Decision

The existing flattened tool projection joins constraints and explanations independently.
Structural equality can deduplicate a field schema without discarding different meanings.
Distinct descriptions are grouped only by identical text, labelled with their discriminator
values and ordered deterministically. A description shared by every present field appears
once. An undescribed variant does not inherit another variant's description.

Every field that is not required everywhere advertises all branches where it is available,
and independently identifies branches where it is required. A missing field is never labelled
available. The projected object remains a conservative presentation; the original Zod schema
owns discriminator correlations, validation and execution.

## Why

A typed object/array alternative tells a model which values are possible but cannot explain
which branch uses each value. Losing two distinct descriptions, or naming only a required
branch while omitting an optional branch, hides meaningful parts of the canonical contract.
An exact structural union alone does not repair lost semantic annotations.

## Alternatives and consequences

Selecting one description silently assigns its meaning to other branches. Joining descriptions
without labels preserves words but loses their scope. Reconstructing discriminator validation
with `if`/`then` or additional unions defeats the opt-in object presentation. Qualified text
preserves intent without introducing a second parser or changing the public API.

The extra text increases the presentation size. It does not guarantee model obedience;
applications still verify their own agent behavior. Regression tests assert semantics on every
surface and through the packed public entrypoints, independently of projection equality.

Serves I1, I3 and I8.
