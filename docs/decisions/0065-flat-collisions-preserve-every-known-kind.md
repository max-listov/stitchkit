---
title: "ADR 0065 — Flat collisions preserve every known JSON kind"
description: Divergent fields in a flattened discriminated union publish a sound JSON Schema type union instead of becoming untyped.
type: decision
status: accepted
created: 2026-08-08
updated: 2026-08-08
---

# ADR 0065 — Flat collisions preserve every known JSON kind

- **Status:** Accepted — extends [ADR 0044](0044-a-collided-field-keeps-its-type.md),
  preserves the flat presentation boundary of
  [ADR 0050](0050-presentation-schema-is-not-a-parser.md), and supersedes ADR
  0044's rule that genuinely different kinds become unknown.
- **Date:** 2026-08-08

## Context

`flattenUnionInput` joins a discriminated object union into one conservative
presentation object without nested `oneOf` or `anyOf`. ADR 0044 retained a
shared base type when colliding variants agreed, but a property that was a
string in one branch and an array or object in another still became `{}`.

The executable Zod contract remained correct. The model-facing document did
not: every branch exposed a finite JSON kind, yet the projection discarded all
of them and `requireTypedProperties` correctly rejected the resulting surface.

## Decision

A colliding property collects every provable JSON Schema base kind from direct
`type`, `const`, `enum`, and recursively from `oneOf` or `anyOf` branches.

- One non-null kind produces the existing scalar `type` projection.
- Several kinds produce a deterministic `type` array.
- `integer` plus `number` widens to `number` because every integer is a number.
- `null` is retained alongside every non-null kind.
- A same-kind object or array collision remains a loose object or array; branch
  structure and incompatible constraints are not invented.
- If any participating branch has no provable kind, the collision remains
  untyped. An unresolved reference or free-form schema is evidence that the
  projection does not know, not permission to guess.

The multi-type projection carries no kind-specific sibling keywords. It is a
sound superset of every original branch and preserves flat mode's guarantee of
no `oneOf` or `anyOf` in a structurally flattenable discriminated union. The
unflattened mode remains the lossless representation when a caller needs exact
discriminator-to-branch relationships.

## Consequences

- Known object/array, string/number and scalar/nested-union collisions no longer
  degrade to `{}`.
- `findUntypedProperties` accepts these fields through their ordinary `type`
  keyword; no validator exception or allowlist is required.
- MCP, Agent, manifests and schema validation see the same immutable document
  because the change lives in the shared presentation projection.
- Runtime parsing, transforms, lifecycle, hooks and error normalization remain
  owned by the original Zod contract and canonical tool runner.
- Flat mode remains intentionally lossy: a type array describes legal JSON
  kinds, not the exact correlations between a discriminator and each shape.
