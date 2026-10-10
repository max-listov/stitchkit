---
title: "ADR 0257: CLI dotted values follow their declared schema"
description: "Dotted CLI leaves coerce only when their schema declares a primitive type; free record leaves preserve argv text and whole-object JSON carries explicit types."
type: decision
status: accepted
created: 2026-10-10 21:49 +07:00
updated: 2026-10-10 21:49 +07:00
---

# ADR 0257 — CLI dotted values follow their declared schema

**Invariants:** I1, I2, I3, I8, I14.

## Context

A dotted CLI argument arrives as text. The old fallback guessed from spelling when the receiving
schema was a free `record<string, unknown>`: `5` became a number and `true` became a boolean, while
`007`, `+007` and `1e3` lost or changed lexical meaning. The same syntax under a declared object has
enough schema information to coerce safely, so treating both cases alike either guesses without a
contract or makes typed leaves inconvenient.

This behavior belongs to the stable `stitchkit/cli` entrypoint. Correcting it changes values seen by
handlers whose free records depended on the guess, so the change needs one named migration rather
than an undocumented parser heuristic.

## Decision

1. A dotted leaf under a declared number or boolean schema is coerced and then validated by that
   leaf. String leaves remain lexical. Literal sets, unions, wrappers and arrays use the same
   schema-derived rule rather than the option name or spelling alone.
2. A dotted leaf under `record<string, unknown>` preserves the exact argv text. Unknown means there
   is no contract authorizing conversion.
3. A whole-object JSON value retains JSON's explicit primitive types. A caller that needs numbers or
   booleans in a free record passes the record as JSON, or declares a structured object schema for a
   dotted interface.
4. A wholly unknown root admitted by `allowUnknown` keeps its existing best-effort coercion. That
   passthrough has no declared record boundary and is outside this correction; changing it would
   widen the migration without improving schema fidelity.
5. Invalid values for typed dotted leaves fail before the handler. Tests cover lexical lookalikes,
   valid typed leaves and invalid number/boolean controls through the real CLI argument builder.

## Consequences

- `--data.count=5` under a free record now yields `{ count: "5" }`; use
  `--data='{"count":5}'` for a numeric value.
- A declared `z.object({ count: z.number() })` continues to receive the number `5` from the dotted
  form.
- The release is a pre-1.0 minor with an explicit breaking section and migration.
