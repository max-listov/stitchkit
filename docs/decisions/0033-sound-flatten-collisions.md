---
title: "ADR 0033 — Sound flatten: collision widening, discriminator support, probe parity"
type: decision
status: accepted
created: 2026-06-22
updated: 2026-06-22
---

# ADR 0033 — Sound flatten: collision widening, discriminator support, probe parity

- **Status:** Accepted — completes/repairs [ADR 0031](0031-deep-union-flatten.md).
- **Date:** 2026-06-22

## Context

`flattenUnionInput` (ADR 0031) advertises a discriminated union as one flat
object so weak models avoid `oneOf`. A 5-agent audit found the merge was
**first-wins** (`flatten.ts`): when two variants share a key with a different
shape, one is silently dropped → the advertised schema is **stricter** than the
original union → for the losing variant **no valid input exists** (advertised
rejects one form, the union rejects the other). Confirmed on `media: object`
(message) vs `media: array` (mediaGroup). The same defect surfaces on differing
enums/literals (K2), object shapes (K3), defaults (K4) and nested (K5). The audit
also found: a multi-value/`enum` discriminator was mishandled or **crashed the
whole mount** via a raw `throw`; `validateMcpSchemas` validated the *un-flattened*
schema (blind to what ships); `params` + union input produced a non-mountable
`allOf`; and the deep walk missed plain-union / record members.

**Invariant:** the advertised (flattened) schema must accept a **superset** of the
original union — never be stricter on any path — so a model can always produce a
value that passes both the SDK and validation.

## Decision

1. **Collision widening (superset by construction, zero `oneOf`/`anyOf`).** Per
   key across variants, dedupe by normalized JSON Schema (annotations stripped):
   one distinct → keep; all string literal/enum → one **widened `z.enum`**;
   otherwise → **`z.unknown()`** (accepts every variant's value; the `.describe()`
   carries the per-variant shape). No `anyOf` is introduced, so ADR 0031's
   "no `oneOf`/`anyOf` at any depth" **still holds** — no reversal.
2. **Discriminator:** collect **all** literal values (multi-value `z.literal`) and
   accept a `z.enum` discriminator; a non-string discriminator / non-object
   variant makes the union **non-flattenable** — `flattenUnionsDeep` leaves it
   untouched instead of throwing (graceful, no mount crash).
3. **Probe parity.** `validateMcpSchemas` takes the mount options
   (`extend` / `flattenUnionInput`) and the `createMcpHandler` build-time check
   forwards them, so the deploy probe vets the **same** schema that ships.
4. **`params` + union input.** Flatten `params` and `input` **separately, then
   merge** — a union input becomes a `ZodObject` and merges with params into one
   object (mountable), instead of an `allOf` intersection.
5. **Deeper walk.** Recurse into plain `ZodUnion` members and `ZodRecord` values
   (a discriminated union nested there now flattens too).
6. **`coerceJsonArgs` recursion.** Coerce double-serialized values at any depth
   (object fields, array items, the matching variant of a discriminated union) —
   not just top level — closing the advertise(object)≠coerce(union) gap.

## Alternatives considered

- **Per-field `anyOf` for collisions** (the audit's first instinct). Rejected — it
  re-introduces the construct ADR 0031 removed and would reverse that ADR + break
  its test. Value-widening (`enum`) and `z.unknown()` keep zero `anyOf` and are
  equally satisfiable.
- **Hard-reject `.strict()` variants.** Deferred — strictness is dropped from the
  *advertised* hint (validation still enforces it); it is invariant-safe (looser).
  The residual cross-variant "lure" is a guidance issue the describe hint
  mitigates; revisit if a second consumer reports it.
  > ⚠️ **Superseded by [ADR 0034](0034-advertised-schema-key-policy.md).** The
  > premise is wrong: the transport SDKs *parse arguments with* the advertised
  > schema and hand the handler the parsed result, so dropping strictness is not
  > "looser" — it **deletes** the offending key before validation sees it. Object
  > key policy is now carried through every rebuild.

## Consequences

- **Additive — no breaking change.** Same `flattenUnionInput` flag; the advertised
  schema is now a sound superset. Ships in 0.15.0.
- **The whole advertise≠validate class is closed** for the confirmed kinds
  (K1–K5, discriminator, params+union, deep), and the build probe now sees the
  real schema.
- **Collision soundness covers JSON-invisible checks at any depth (0.15.1):** a key
  that collides across variants and whose kept schema carries any check — directly,
  or nested under an object field / array element / `.pipe()` output / `optional` /
  `nullable` / `default` wrapper — is widened to `z.unknown()` (a `.refine()` /
  custom check / pipe constraint does not serialize to JSON Schema, so it would
  otherwise leak onto a sibling variant). The 0.15.0 check was shallow (top node
  only); 0.15.1 made it deep.

  > **Narrowed by [ADR 0044](0044-a-collided-field-keeps-its-type.md)
  > (2026-08-06).** "Any check" was too wide: `.int().min(0)` is visible in JSON
  > Schema and cost a live agent its type. The widen now fires only for
  > constraints JSON cannot show, and it keeps the base type instead of going to
  > `z.unknown()`.
- **Known residual (documented, not silent):** ~~`.strict()`/`catchall`~~ (carried
  through since [ADR 0034](0034-advertised-schema-key-policy.md) — dropping them
  deleted data, it was never merely "looser") / object-level
  refinements are dropped from the advertised hint; a non-flattenable union (non-
  string discriminator) keeps its `oneOf`; `ZodTuple`/`ZodMap`/`ZodSet` members and
  `z.lazy` are not walked (`coerceJsonArgs` likewise stops at a `z.lazy` boundary).
  All are best-effort and invariant-safe (looser advertised / missed coercion that
  validation still rejects — never a false reject).
