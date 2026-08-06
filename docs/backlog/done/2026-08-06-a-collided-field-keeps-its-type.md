---
title: "A collided field keeps its type — widening to unknown blinded a live agent"
description: mergeCollidingFields widens any multi-variant field carrying checks to z.unknown(), so .int().min(0) erased the advertised type and a model retried the same string sixteen times against a live broadcast.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 15:45 +07:00
related: docs/decisions/0044-a-collided-field-keeps-its-type.md
---

# A collided field keeps its type

## The incident

Reported by a consuming project, from production. 6 Aug, 10:26–10:27 UTC. An
owner was editing a broadcast queued to **2192 recipients**. The agent called
`broadcast_patch` **sixteen times** and got `VALIDATION_ERROR:
operations.0.partIndex: expected number, received string` every time. Nothing was
applied; the button kept pointing at the wrong place while the agent reported
"fixing it". It did not go out only because the owner never pressed send.

The consumer's own reasoning log, verbatim: *"The patch failed because I passed
strings for partIndex/buttonIndex. I need to pass numbers. Let me do the patch
with numeric indices"* — and the next call sends `"1"` again. **The model
understood the error and could not act on it**, because the schema it was given
never said the field was a number.

## Root, reproduced here before writing this

`mergeCollidingFields` (`tools/flatten.ts:234`):

```ts
return schemas.length > 1 && hasChecks(only) ? z.unknown() : only;
```

`hasChecks` (same file, :180) returns true for **any** check, including `.int()`
and `.min(0)`. `partIndex` appears in 8 of 14 operations, so it collides, so it
is widened. One probe in this repo:

```
partIndex  (2 variants, .int().min(0)) : {"description":"Required if op = a | b"}
mediaIndex (1 variant,  .int().min(0)) : {"description":"…","type":"integer","minimum":0,…}
```

No `type`. The perverse part: **the more precisely the field is described, the
worse the hint the model gets.** A bare `z.number()` would have survived.

## Why the guard exists, and where it is too wide

The widening is not paranoia. Two variants can normalise to the same JSON shape
and still validate differently when one carries a `.refine()` / `.pipe()` /
`.transform()` — invisible in JSON Schema. Advertising one variant's hidden
constraint could reject another variant's valid value. That invariant is right
and must survive this task.

But it does not apply to what was widened here. Two facts, both verified:

1. **This branch only runs when every variant shares one JSON shape**
   (`values.length <= 1`, keyed on the normalised JSON). So the serializable
   constraints are *identical* across variants — advertising them cannot reject
   anyone. Differing constraints take the other branch entirely.
2. **Zod v4 marks the dangerous ones.** Probed:

   | Schema | `checks[].check` |
   |---|---|
   | `.int().min(0)` | `number_format`, `greater_than` |
   | `.regex(…)` | `string_format` |
   | `.length(3)` | `length_equals` |
   | `.refine(…)` | **`custom`** |
   | `.superRefine(…)` | **`custom`** |

   The split is exact, not a heuristic: `custom` is the non-serializable family.

And a second, independent point: **even when widening is warranted, the type is
not the thing that has to go.** All colliding variants agree the field is a
number — that is why they collided. Dropping to `z.unknown()` discards the one
piece of information that is provably shared. `z.number()` is both invariant-safe
and incomparably more useful to a model than nothing.

## Validator 1 notes — invariant safety (read-only, live probes)

**B1. The plan named the wrong property, and literally implemented it would delete
the guard.** In Zod 4.4.3 `check.check` is the check *function*; the kind lives at
`check._zod.def.check`. `c.check === 'custom'` is false for every check, so
`hasChecks` would return `false` always and ADR 0033's protection would vanish —
shipped as a "narrowing".

**B2. `overwrite` is hidden AND mutating, and is not `custom`.** `.trim()`,
`.toLowerCase()`, `.normalize()` emit `check: 'overwrite'`, serialize to nothing,
and *change the value*. Today the broad `hasChecks` catches them; under the
plan the kept schema trims a sibling variant's value on the way to its handler —
ADR 0034's "the advertised schema changed the payload" class.

**B3. `.pipe()` breaks an existing, correct test.** `flatten-collision.test.ts:93`
— the out-side `min_length` is a *serializable-family* check that is invisible on
the input side. Under custom-only it is not widened and the advertised schema
rejects `{k:'b', v:'x'}`, which the union accepts. Step 2 does not rescue it:
there are no custom checks to strip.

**B4. The step-3 guard fails the repo's own tests.** K1
(`flatten-collision.test.ts:22`) legitimately produces a description-only
property, and so does any consumer-authored `z.unknown()`.

**B5. My load-bearing sentence was false as written.** `distinct` is keyed on
`toJsonSchema(…, unrepresentable: 'any')`, so `z.custom`, `z.date`, `z.bigint`,
`z.map`, `z.set` all collapse to `{}` and land in one bucket. Correct form:
*identical JSON proves identity only of **JSON-expressible** constraints.*
A live counterexample exists today (`z.custom` vs `z.unknown`) where the flat
schema rejects a value the union accepts.

**Also pre-existing, same family, found on the way:** `.transform()` is not
guarded at all (probed: variant b's value gets variant a's transform);
`.catch()` makes the advertised schema *accept what the contract rejects* and
fabricates a value; `z.coerce` vs plain is decided by variant declaration order.

**Recommendation that beats my step 2:** do not strip checks — **project to the
base type** (`number → z.number()`, `object → looseObject({})`, `pipe → def.in`,
else `z.unknown()`). A superset of every variant by construction, no Zod-internals
surgery, one function instead of a recursive rewriter, and it delivers the actual
goal: the model is told it is a number.

## Validator 2 notes — what the model receives, and scope (read-only, live probes)

**B6. I fixed the smaller of two erasure sites.** `mergeCollidingFields` has a
second `z.unknown()` exit at `flatten.ts:252` — *different* JSON shapes, not all
enum/literal. Untouched by my plan. Reproduced on a realistic 4-op contract:

```
partIndex {"description":"…"}   ← :234, my plan fixes
target    {"description":"…"}   ← :252, string vs number
mode      {"description":"…"}   ← :252, enum vs free string — BOTH strings
n         {"description":"…"}   ← :252, z.number().min(0) vs .min(5) — BOTH numbers
```

`n` is the damning one: a number in every variant, still blank after my fix, for
exactly the reason `partIndex` was. My own strongest argument applies verbatim at
`:252` and my plan did not apply it there.

**B7. Define "hidden" by representability, not by a kind allowlist.** Kinds rot;
`z.bigint().min(1n)` carries the "serializable" `greater_than` yet converts to
`{}`. Make it self-checking: strip, then assert `normalizedJson(stripped)` equals
`normalizedJson(only)` — if the JSON moved, the strip removed something the model
was being told, so fall back. A property instead of a taxonomy.

**B8. Deep detection with a shallow strip is worse than today.** `hasChecks`
recurses into object shapes, array elements, records, intersections, both pipe
sides. A nested `.refine()` would be detected, "handled", and then survive into
the advertised schema where today it is widened away. Cloning is mandatory —
`only` is the contract's own instance, and mutating `def.checks` would strip the
refinement from the real validation schema. Nested object rebuilds must go
through `rebuildObject` (`schema.ts:43`) or key policy is dropped (ADR 0034).

**B9. The guard has no corpus here, and could never have caught this incident.**
The package ships no contracts, so there is nothing to generate a tool schema
from at build time; and the defect lived in the **consumer's** contract. The
consumer lane cannot supply one either — `fixtures/full` mounts a plain object
contract with no discriminated union and no `flattenUnionInput`, so the lane goes
green on the pre-fix code. The instrument that *would* have caught it is
`validateMcpSchemas` (`mcp.ts:222`), which already walks `collectTools` with the
mount's real options and aggregates failures. The check belongs there, shipped to
consumers; the fixture becomes the test *of* the guard, not the guard.

**B10. The fix moves the failure channel and takes the audit trail with it.**
Once `partIndex` advertises `integer`, the MCP SDK rejects the bad call in
`validateToolInput` **before** the tool callback: no `afterToolCall`, no
`errorHint`, no audit row, and the model sees `MCP error -32602` instead of our
envelope. Those sixteen rows are what made the incident visible. Does not argue
against the fix — argues for writing it down.

**B11. Guard mechanics.** It must recurse rather than read top-level
`properties` (an intersection root emits `allOf` with no root `properties`), and
it must convert the way the clients do — both real paths emit **draft-07** with
`definitions`, while our `toJsonSchema` emits draft-2020-12 with `$defs`.

**B12. Coercion — state the decision, do not stay silent.** Nothing coerces
scalars in the tool path today (`coerceJsonArgs` only JSON-parses when the schema
wants a *structure*). After the fix it is structurally unreachable: the SDK parses
before we see the arguments. The consumer's tolerance must sit outside the
MCP/agent parse. Say so, or the question returns in three weeks.

**B13. Bounds and missing paperwork.** The CLI never flattens
(`flattenUnionInput` defaults false), so the incident cannot reach that surface —
worth stating. Missing from the plan: the `docs/decisions/README.md` index row,
`docs/guide/mcp-and-agents.md`, and an inline annotation on ADR 0033's
Consequences, which states verbatim the sentence this task overturns.

## Plan (rewritten after validation)

The original plan was wrong in three ways the validators proved: it named the
wrong property, it defined "hidden" by a taxonomy that leaks, and it fixed one of
two erasure sites. Rewritten:

1. **"Hidden" is decided by representability, and the decision is self-checking.**
   A check is hidden when removing it does not change the advertised JSON — assert
   `normalizedJson(projected) === normalizedJson(only)` and fall back if it moved.
   Kind lists (`custom`, `overwrite`) become a fast path, not the definition, so a
   new Zod check kind cannot silently reopen the hole. Read
   `check._zod.def.check`. Widen unconditionally for `ZodPipe` (take `def.in`),
   `ZodCatch`, `z.custom()`-typed nodes and any `coerce` mismatch across variants.
2. **Never `unknown` where a type is provable — project to the base type.**
   `number → z.number()`, `string → z.string()`, `array → z.array(z.unknown())`,
   `object → looseObject({})`, `pipe → def.in`, otherwise `z.unknown()`. A
   superset of every variant by construction. Replaces "strip the checks", which
   needed a recursive rewriter and `rebuildObject` care to be safe.
3. **Apply the same rule to the divergent branch (`flatten.ts:252`).** Where the
   variants share a kind — number vs number, object vs object — advertise
   `{"type": …}`. Where they do not, JSON Schema permits `"type": ["string",
   "number"]`, which is neither `oneOf` nor `anyOf` and so keeps ADR 0033's
   prohibition intact. Enum-vs-free-string is a pure miss of the existing
   enum-merge branch: both sides are strings.
4. **The guard ships to consumers, not just to us.** Extend `validateMcpSchemas`
   (`mcp.ts:222`) with "every advertised property carries `type`/`enum`/`anyOf`/
   `$ref`", exempting deliberately-unconstrained nodes via an `ACCEPTED`-style
   list (`check-public-types.mjs` is the idiom). It must recurse past `allOf` and
   convert as draft-07, the way the SDKs do. The repo-side test is a fixture with
   a real discriminated union and `flattenUnionInput` — which the consumer lane
   does not have today and needs.
5. **Retro-check.** Reproduce the incident's shape, confirm red before / green
   after, and confirm the guard fails on pre-fix output.
6. **Write down what the fix changes beyond the schema:** the failure moves to the
   SDK channel (no `afterToolCall`, no audit row), scalars are deliberately not
   coerced and cannot be, and the CLI surface was never affected.

## Acceptance

- [x] A field colliding across variants with only serializable constraints keeps
      its full advertised schema (`type` + the shared constraints)
- [x] A field colliding with a hidden constraint keeps its **type** — never
      `unknown` where a type is provable
- [x] A field colliding across *different* JSON shapes keeps its type too, when
      the variants share a kind (`flatten.ts:252`)
- [x] `.trim()` / `.overwrite()` cannot reach a sibling variant's value
- [x] `.pipe()` advertises its `in` side; `flatten-collision.test.ts:97` stays green
- [x] The self-check holds: projecting never changes the advertised JSON
- [x] The invariant survives: no advertised constraint can reject a value another
      variant accepts. Covered by a test with genuinely divergent refinements
- [x] Existing flatten tests (ADR 0031 / 0033 / 0034) stay green, or a change is
      argued as a fix rather than papered over
- [x] Build guard: no property in any generated tool schema carries a
      `description` and nothing else
- [x] Retro-check performed and written down
- [x] ADR + row in `docs/decisions/README.md` + inline annotation on ADR 0033's
      Consequences, which states verbatim the sentence this overturns
- [x] `docs/guide/mcp-and-agents.md` — collision widening is undocumented today
- [x] `CHANGELOG.md`

## Process (конвейер 2/2 со стопом)

- [x] Task written
- [x] 2 read-only validators against the real code, different lenses
- [x] Findings absorbed as "Validator N notes"; task → `in-progress`
- [x] **STOP** — plan to Max, wait for "го"
- [x] Implementation
- [x] Gate: `bun run verify`
- [x] 2 read-only validators against the implementation
- [x] Report to Max

## Validator 3 + 4 notes — the implementation (read-only)

Both found the same **new regression I introduced**, independently:
`projectToBaseType` unwrapped `ZodNullable` and never re-applied it, so a
nullable collided field advertised `{"type":"number"}` and **rejected `null`** —
which every variant accepted, and which the old code accepted. Five shapes
reproduced. Fixed: nullability is carried through the projection, because `null`
is part of the accepted set, not a constraint on it.

Validator 3 also found the scan was **order-dependent**: `hasInvisibleConstraint`
read only `values[0]`, so a coercing or `.catch()` sibling was invisible and four
new rejections appeared depending on which variant was written first. Fixed by
scanning the whole collision set — and the tests for it now assert **both
orderings** of the same pair, since the originals happened to use the only order
that worked.

Validator 4 found two things I had made *worse* than before:
- `z.coerce.*` and `.catch()` in **both** variants went from typed to blank, and
  the behaviour was self-inconsistent (coerce in one variant kept its type, in
  two it did not). Fixed twice over: an accept-more hazard only forces `unknown`
  when the variants **disagree** about it, and the projection now **preserves
  coercion** (`z.coerce.number()`), so the field keeps its type *and* still
  accepts what a coercing variant accepts.
- A collided `z.date()` used to fail the mount loudly in `probeSchema`; my change
  made it convert cleanly and ship a blank property — a silent version of a
  caught error. Fixed: an unrepresentable node is returned untouched so the
  mount still throws.

Both flagged the missing paperwork (ADR 0044 did not exist while eight comments
already cited it), stale docblocks, the guard's silence under `'skip'`, and the
draft-07 tuple shape (`items: [...]`) the walk did not visit. All fixed.

Not taken: `ZodReadonly` / `ZodLazy` / `ZodTuple` are not walked by the hidden
check. Validator 3 proved this breaks the invariant — and proved it breaks
identically on `HEAD`, so it is pre-existing, out of this mandate, and ADR 0033's
claim that skipping them is "invariant-safe" is wrong. Its own task.

## Что сделано

**Ядро** — `packages/core/src/tools/flatten.ts`
- `hasInvisibleConstraint` replaces `hasChecks`: kind read from
  `check._zod.def.check`, hidden = `custom` / `overwrite` / pipe / unrepresentable
- `acceptsMoreThanItsType` — coercion and `.catch()`, scanned across every variant
- `projectToBaseType` — base type instead of `z.unknown()`, nullability and
  coercion preserved, objects projected **loose** so no key is deleted
- both merge branches: the same-shape one and the divergent one at `:252`

**Гвард потребителю** — `untyped-properties.ts` + `validateMcpSchemas({
requireTypedProperties, allowUntyped })`. Recurses past `allOf`, into `items`
(object and draft-07 array form), `prefixItems`, `additionalProperties`,
`patternProperties`, `$defs` and `definitions`. Speaks under `'skip'`, because a
project that switched it on asked to hear.

**Тесты** — 796 → 804. The incident's exact shape; hidden constraints costing the
constraint and never the type; order-independence in both directions;
nullability; coercion on one side vs both; an unrepresentable node still failing
loudly; the guard's traversal and its `allowUntyped` escape.

**Документация** — ADR 0044 + index row + inline annotation on ADR 0033's
Consequences (which stated verbatim the sentence this overturns) ·
`docs/guide/mcp-and-agents.md` (both the collision behaviour and the new check) ·
`docs/api/reference.md` · `CHANGELOG.md` with a `⚠️ Breaking changes` section,
because the advertised schema changes and the SDK parses with it.

**Записано, как и требовал план** — the failure channel moves to
`validateToolInput` (no `afterToolCall`, no audit row, `MCP error -32602`),
scalars are deliberately not coerced and after this cannot be on the MCP path,
and the CLI never flattens so it was never affected. All three in ADR 0044.
