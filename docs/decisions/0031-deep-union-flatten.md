---
title: "ADR 0031 — Deep discriminated-union flattening for tool schemas"
type: decision
status: accepted
created: 2026-06-22
updated: 2026-06-22
---

# ADR 0031 — Deep discriminated-union flattening for tool schemas

- **Status:** Accepted — completes the `flattenUnionInput` feature; refines
  [ADR 0007](0007-mcp-agent-tools.md) / [ADR 0014](0014-tool-http-parity.md).
- **Date:** 2026-06-22

## Context

`flattenUnionInput` advertises a discriminated union as a single flat object
(discriminator → enum, variant fields → optional + `Required if …` hint) so a
tool transport carries no `oneOf` / `anyOf` — a construct weaker models drop or
mangle. But it only ever flattened the **top level**:

- The call-site flattened only when the *entire* merged input was a
  `ZodDiscriminatedUnion` (`mount.ts`); a normal object input with a union nested
  inside it was a no-op.
- `flattenDiscriminatedUnion` itself is shallow — it copies a variant's fields
  verbatim, never recursing into them.

So a contract like `broadcast_create` — input `{ name, content }` where
`content.parts[]` is an array of a discriminated union — shipped that nested union
to the model as `oneOf`. A consuming project proved the impact with a byte-level
A/B on a weaker model: with the nested `oneOf`, the model dropped the field or
collapsed newlines in strings; with the same schema minus `oneOf`, output was
correct 3/3. The feature did not deliver what its own docstring promised ("flatten
… for transports that cannot represent `oneOf`").

## Decision

Make `flattenUnionInput` **deep**: a new `flattenUnionsDeep` walks the merged
input schema and replaces **every** `ZodDiscriminatedUnion` — at the top level and
nested inside object fields, array items, and `optional` / `nullable` / `default` /
intersection wrappers — with its flattened object form, recursing into the result
(a variant field may itself hold a union). `.describe()` text is preserved through
the rebuild. The call-site now always runs the deep walk when the flag is set,
subsuming (and fixing) the old top-level-only check.

Properties kept from the shallow version:

- **Advertised-only and lossy.** The original `params` / `input` schemas remain the
  validation schemas in `executeToolMethod`; only the advertised hint changes, so
  a mis-flatten degrades a hint, never validation.
- **Opt-in.** Behind the existing `flattenUnionInput` flag — no change for anyone
  not setting it.
- **Best-effort.** Schemas a transform cannot safely rebuild (refined / piped /
  lazy / plain non-discriminated unions) are left untouched; a discriminated union
  behind one of those keeps its `oneOf` (documented).

## Alternatives considered

- **Document the shallow limit, do nothing** (the consumer's fallback option).
  Rejected — the feature exists precisely to remove `oneOf` for weak transports;
  leaving nested `oneOf` means it silently fails its purpose. The evidence (a
  rigorous A/B) is strong, and the fix is low-risk because it is advertised-only.
- **`isMutation`-style heuristics / per-model schema variants.** Out of scope —
  the flat-object form already works for every model (a B-test shows the strong
  models were fine before and stay fine).

## Consequences

- **Additive — no breaking change.** Same flag, same semantics, applied at depth.
  A nested array-of-union now advertises each item as a flat object (all variant
  fields optional) rather than `oneOf` — messier for a human reading the schema,
  but what weak models handle, and validation is unchanged. Ships in 0.13.0.
- **`flattenUnionInput` now delivers its docstring** — no `oneOf` at any depth.
- `flattenUnionsDeep` is exported from `stitchkit/tools` beside
  `flattenDiscriminatedUnion`.
