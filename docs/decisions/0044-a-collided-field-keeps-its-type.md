---
title: "ADR 0044 — A collided field keeps its type"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0044 — A collided field keeps its type

- **Status:** Accepted — narrows the collision rule of
  [ADR 0033](0033-sound-flatten-collisions.md) while keeping its invariant;
  extends [ADR 0031](0031-deep-union-flatten.md)
- **Date:** 2026-08-06

## Context

A field declared `.int().min(0)` in 8 of a contract's 14 operations was
advertised to the model as a `description` and nothing else. On a live bot an
agent called the tool sixteen times in ninety seconds, each time sending `"1"`
where a number was required, each time getting `VALIDATION_ERROR`. Its own
reasoning log read *"I need to pass numbers"* — and the next call sent a string
again. Nothing was applied; a broadcast queued to 2192 recipients kept a wrong
button, and it stayed unsent only because the owner never pressed send.

The cause was ADR 0033's collision rule: a key present in more than one variant
whose kept schema carried **any** check was widened to `z.unknown()`. The guard
is right in principle — two variants can normalise to the same JSON and still
validate differently through a `.refine()` or a pipe's output side, and
advertising one variant's hidden rule could reject another's valid value. What
was wrong is the scope: `.int()` and `.min(0)` are *visible* in JSON Schema, and
the field lost its type because it was described **too precisely**.

## Decision

**Hidden is decided by what JSON can show, not by the name of a check.** A
constraint is hidden when it cannot appear in the advertised document: a `custom`
check (`.refine()`, `.superRefine()`), an `overwrite` check (`.trim()`,
`.toLowerCase()` — worse than a rejection, it *changes the value*), a pipe's
output side, or any node JSON Schema cannot represent at all and degrades to
`{}`. The kind list is a fast path over that question, not the definition of it.
The kind is read from `check._zod.def.check`; the top-level `.check` is the check
*function*, and comparing that to a string is silently always false — which would
have deleted the guard entirely while looking like a narrowing.

**Where a constraint must go, the type stays.** A collided field is one every
variant declared, so the type is provably shared, and a bare type is a superset
of every variant by construction. `projectToBaseType` returns `z.number()`,
`z.string()`, `z.array(z.unknown())`, `z.looseObject({})` — loose, never strict,
so an advertised object cannot delete a key a variant keeps (→ ADR 0034).
Nullability is carried through: `null` is part of the accepted set, not a
constraint on it, and dropping it would advertise a rejection no variant makes.

**The same rule applies where the variants disagree.** A field that is a number
in every variant with different bounds, or an enum against a free string, used to
reach the model blank for the same reason. Each variant is projected; if they land
on one base type, that is the shared truth. Genuinely different kinds stay
`unknown` — JSON Schema could say `"type": ["string","number"]`, but no Zod node
emits that and inventing one is a separate decision.

**Two hazards keep `unknown`, and are scanned across every variant.** Coercion
and `.catch()` accept **more** than their type keyword says, so the base type
would be a *narrowing*: `z.coerce.number()` takes `"1"`, and advertising `number`
would reject it. Crucially the scan covers the whole collision set rather than the
kept schema alone — reading only the first would make the advertised result depend
on the order the variants happen to be written in.

## Consequences

- The incident's field advertises `{"type":"integer","minimum":0}`. A model that
  is told the type stops guessing.
- **The failure channel moves.** A bad call is now rejected by the MCP SDK's
  `validateToolInput` *before* the tool callback: no `afterToolCall`, no
  `errorHint`, no audit row, and the client sees `MCP error -32602` instead of
  stitchkit's envelope. The sixteen audit rows are what made this incident
  visible in the first place — a project that relies on them for detection should
  know they will not appear for this class any more.
- **Scalars are still not coerced, deliberately.** `coerceJsonArgs` only
  JSON-parses a string when the schema wants a *structure*; nothing turns `"1"`
  into `1`, and after this change nothing can on the MCP path, because the SDK
  parses before stitchkit sees the arguments. A project that wants tolerance must
  add it outside that parse. Making the advertised schema coercing would
  contradict the whole point: it would tell the model one thing and accept
  another.
- **The CLI is unaffected** — it never flattens (`flattenUnionInput` defaults to
  false), so this class could not reach that surface.
- ADR 0033's Consequences paragraph describing the old widen is annotated rather
  than left to contradict this one.

## The check that ships with it

A schema this wrong converts cleanly, mounts cleanly and is advertised cleanly —
nothing fails until a model is confused by it in production. So
`validateMcpSchemas` gains `requireTypedProperties`: every advertised property
must carry `type` / `enum` / `anyOf` / `$ref`, with `allowUntyped` for the ones a
project means to leave free-form.

It is **off by default and lives in a consumer-facing function** on purpose. The
framework ships no contracts, so a build-time check here would have nothing to
inspect and could never have caught this; the defect lived in a consuming
project's contract, and that is where the check has to run.
