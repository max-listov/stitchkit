---
title: flatten field-collision → unsatisfiable advertised schema (deep-flatten regression)
description: flattenDiscriminatedUnion merges variant fields first-wins; a same-key/different-type collision (message.media object vs mediaGroup.media array) silently drops a type, so the advertised schema diverges from per-variant validation and NO valid input exists for the losing variant. Third bug in the flatten/error class — fix the collision AND add a soundness invariant so the whole class stops recurring.
type: task
status: done
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22 13:32 +08:00
related:
  - docs/decisions/0031-deep-union-flatten.md
  - docs/decisions/0030-audit-verb-and-json-error-details.md
  - docs/decisions/0032-apperror-brand-identity.md
---

# flatten field-collision → unsatisfiable advertised schema

> **Reported by a consuming project** (live agent building a `message + media`
> broadcast). Third finding in the flatten/error chain after deep-flatten (0.13)
> and `AppError.is` brand (0.14) — all from one real weak-model agent flow.

## Problem — the double trap

A contract `broadcast_create` whose input has `content.parts[]`, where `parts[]`
is a discriminated union on `kind`:

- `message` → `media` is a single **object** `ArtifactRef = { id }` (optional)
- `mediaGroup` → `media` is an **array** `ArtifactRef[]`

`flattenUnionInput` (deep, 0.13+) merges variant fields into one flat
`parts.items`. For the shared key `media` it **silently keeps one type** (the
first variant's — `object` from `message`, or `array` from `mediaGroup`,
whichever the union lists first). But `executeToolMethod` validates against the
**original** union. Result for the *losing* variant — both possibilities fail:

| Model sends | Rejected by | Error |
|---|---|---|
| `media: { id }` (object) | ai-sdk vs **advertised** (array) | `expected array, received object` |
| `media: [{ id }]` (array) | handler vs **original union** (object) | `expected object, received array` |

→ **No valid input exists** for `message + media`. Any model is structurally
unable to send it. Confirmed by both error texts on one run.

## Root cause (code)

`packages/core/src/tools/flatten.ts`, `flattenDiscriminatedUnion`:

```ts
for (const [key, field] of Object.entries(opt.shape)) {
  if (key === discriminator) continue;
  ...
  if (!(key in fieldSchemas)) {                 // ← FIRST-WINS
    fieldSchemas[key] = field instanceof z.ZodOptional ? field : z.optional(field);
  }
}
```

`if (!(key in fieldSchemas))` is **first-wins**: the first variant's type for a
key is stored; later variants with the same key but a **different type** are
silently dropped. The function assumed all same-key fields share a type — false
for `media`. The advertised flat object therefore advertises one type while the
union validates per-variant → unsatisfiable for the variant whose type lost.

**Regression of deep-flatten (0.13).** Before 0.13 the field stayed inside its
variant's `oneOf` branch — `message.media: object` and `mediaGroup.media: array`
were distinct. 0.13 removed `oneOf` (to stop weak models dropping content) but
collapsed same-named different-typed fields into one. The flatten contract
"advertised is a hint; the original union validates" was silently violated: a
hint that **rejects** a value the union accepts is not a hint, it is a wall.

## Fix plan (mine)

**(1) Per-key type union, not first-wins.** When a key appears across variants:
- one distinct type → keep it (current behaviour, correct).
- multiple distinct types → advertise the **union** of them, optional, with a
  `describe` (`object if kind=message · array if kind=mediaGroup`). A narrow
  per-field `anyOf` — not `oneOf` on the whole `parts[]` — so a weak model faces a
  2-way local choice, and advertised now ⊇ every variant's value (satisfiable).
- de-dupe identical types (compare via `toJsonSchema` string) so same-type keys
  do **not** become a redundant `anyOf[A,A]`.

**(2) Never silently lose a type.** First-wins is removed; a dropped type can no
longer reach prod as a silent unsatisfiable schema.

## Bigger idea (mine) — a flatten **soundness invariant** + build probe

This is the **third** flatten-class bug (nested `oneOf` 0.13; collision now). The
meta-root: flatten is a lossy advertise-time transform whose core invariant is
neither enforced nor tested:

> **The advertised (flattened) schema must accept a *superset* of the original
> union** — every value valid under the original must be valid under the
> advertised one, so the model can always produce a passing value. Advertised may
> be looser (it is a hint); it must never be *stricter* on any path.

Proposal: a build/test-time **flatten-soundness probe** (sibling of
`validateMcpSchemas` / the JSON-schema probe) that, for every flattened union,
checks advertised ⊇ original — at minimum, that no field present in a variant is
advertised with a type that would **reject** that variant's value. The current
collision is exactly such a violation; the probe turns "silent unsatisfiable in
prod" into a **build-time error** (the project's ethos — fail at deploy, not first
request, like `onIncompatibleSchema`). This stops the whole class, not one case.

## Open questions for the audit (5 subagents)

- Other same-key collisions beyond type: **optional vs required** across variants;
  same key different **object shape**; **discriminator value** collisions; nested
  union-in-variant-field collisions; array-of-union-of-union; `default` / `nullable`
  divergence across variants.
- Does the per-key-union fix interact badly with `extend` (`applyExtend`),
  `coerceJsonArgs`, or `mergeSchemas` (params∩input)?
- Is the soundness probe feasible structurally (without executing the handler)?
  What is the minimal check that catches all advertise<original divergences?
- Is there a fundamentally cleaner representation than flatten for weak models
  (e.g. keep `oneOf` but only where unavoidable, per-field) that eliminates the
  class?
- Any OTHER latent advertise≠validate or error-path divergence in the tools layer.

## Acceptance

- [x] `message + media` (object) and `mediaGroup + media` (array) both produce a
  satisfiable advertised schema **and** pass validation — test `flatten-collision.test.ts` K1.
- [x] No silent type loss in `flattenDiscriminatedUnion`; same-type keys stay
  un-unioned — widening (enum/`z.unknown`), zero `anyOf`; test "same-type key".
- [x] Soundness guaranteed — by **construction** (advertised = superset) + **probe
  parity** (`validateMcpSchemas` now sees the flattened schema) + collision tests.
  *(A separate runtime subset-probe was NOT added — undecidable in general; the
  audit's conclusion was "make construction sound → tests are the guard". → ADR 0033.)*
- [x] Audit findings triaged: K1–K5 / discriminator D1+D2 / P1 / P2 / P4 / P5 **fixed**;
  `.strict()` (P3) and `ZodTuple`/`Map`/`Set` walk **documented as best-effort** in ADR 0033.

## Что сделано (релиз 0.15.0)

5-агентный аудит превратил 1 баг дева в полный разбор класса `advertise≠validate`.
Чинили **в корне** (sound producer + probe parity), zero-anyOf — ADR 0031 НЕ реверсили.

**Producer (`tools/flatten.ts`):**
- [x] `flattenDiscriminatedUnion` — per-key **widening** вместо first-wins: dedup по нормализованной JSON-schema → 1 distinct keep / string enum-literal → один широкий `z.enum` / иначе `z.unknown()`. Superset by construction, ноль `anyOf` (K1–K5).
- [x] Дискриминатор: все `def.values` (multi-value literal, D1) + `z.enum`-дискриминатор; non-string/ non-object → `isFlattenableDU` false → union оставляется как есть (D2, без краша).
- [x] `flattenUnionsDeep`: ветки `ZodUnion` (plain — рекурс в members) + `ZodRecord` (value) — P5.

**Mount (`tools/mount.ts`):** flatten params и input **раздельно**, потом merge → params+DU = один `ZodObject` (P2), не `allOf`.

**Probe parity (`tools/mcp.ts`, `tools/mcp-handler.ts`):** `validateMcpSchemas` принимает `{extend, flattenUnionInput}`, `createMcpHandler` их прокидывает → deploy-probe видит реально шипящуюся схему (P1).

**Coerce (`tools/coerce.ts`):** рекурсивный `coerceValue` — object-поля / array-items / matching-variant discriminated union на любой глубине (P4), вместо top-level-only.

**Доки/тесты:** ADR 0033 (+индекс); `flatten-collision.test.ts` (9 тестов: K1/K2/K3, dedup, D1/D2, P2, P5); CHANGELOG `[0.15.0]`; версия 0.15.0. Существующий `flatten-deep.test.ts:50` («no anyOf at any depth») остался **зелёным** — подтверждает zero-anyOf.

**Не делалось (осознанно, в ADR 0033):** P3 `.strict()` (strip+describe, invariant-safe — отдельно если всплывёт у 2-го консьюмера); `ZodTuple`/`Map`/`Set` walk (редко).

**verify:** lint 162/0 · typecheck 0 · test **478** (+9) · build · smoke ✅.

## Audit synthesis — 5 opus agents (read-only), 2026-06-22

Strong convergence. The reported bug is **one defect** (`flatten.ts:47` first-wins)
surfacing on many attributes, plus several adjacent holes the same flow hides.

### The collision class (all from `flatten.ts:47` first-wins, recursive via `flattenUnionsDeep`)
- **K1 different TYPE** (object vs array) — the reported bug. HIGH.
- **K2 different ENUM/LITERAL values** — first-wins drops values; fix must **widen the enum** (union values), not just types. HIGH.
- **K3 different OBJECT SHAPE** (`{x}` vs `{y}`, both `type:object`) — a naive "same JSON type" check MISSES it; needs structural union. HIGH.
- **K4 default / nullable divergence** across a colliding key — advertised keeps one variant's `.default()`/wrapper; **strip per-variant `.default()` on collision** (it misleads the other variant). HIGH/MED.
- **K5 nested** (DU in a variant field / array-of-DU) — same root, recursive; **fix in `flattenDiscriminatedUnion`, not the walk**. HIGH.

### Discriminator bugs (separate from field collision)
- **D1 multi-value `z.literal(['a','b'])`** — `flatten.ts:36` reads `values[0]` only → drops other discriminator values. HIGH/MED.
- **D2 non-string / `z.enum` discriminator** — `flatten.ts:31/37` **raw `throw`** → crashes the *whole* `mountMcp`/build, bypassing `onIncompatibleSchema`. Route through the policy, not throw. HIGH.

### Adjacent holes (all 5 agree)
- **P1 — `validateMcpSchemas` is blind to flatten** (`mcp.ts:229` passes no `flattenUnionInput`). The deploy probe (`mcp-handler.ts:142`) validates the **un-flattened** schema while `mountMcp` ships the flattened one → false build *failures* (a union input flagged "must be object") **and** false *negatives* (every flatten defect invisible). The comment `mcp.ts:130` "the two cannot drift" is **false**. **Must fix first** — any soundness probe inherits this blindness. HIGH.
- **P2 — `params` + DU input → `allOf`, never `ZodObject`.** `mergeSchemas` (`schema.ts:53`) intersects → `flattenUnionsDeep` flattens both sides but the top stays `ZodIntersection` → `prepareMcpTool` rejects ("must be object") and advertises `allOf` (the weak-model construct flatten exists to remove). A path-params + DU-body tool **can't be an MCP tool even with flatten on**. MED-HIGH.
- **P3 — `.strict()` inverse-trap.** Flatten drops `.strict()` → advertised is *looser* (invariant-SAFE), but the model attaches a sibling variant's field per the flat hint → the original strict union **rejects** it. Shows the superset invariant alone is **not sufficient** for satisfiability. MED.
- **P4 — `coerceJsonArgs` advertise≠coerce.** `coerce.ts` is top-level-only and short-circuits on non-object (union) inputs → a model double-serializing a nested field (which flatten makes common) is never un-stringified → spurious `VALIDATION_ERROR`. LOW-MED.
- **P5 — `flattenUnionsDeep` coverage gaps.** No recursion into plain `ZodUnion`, `ZodRecord` values, `ZodTuple` items, `ZodMap`/`Set` → a DU nested there keeps `oneOf`. So ADR 0031's "no oneOf at ANY depth" (and `flatten-deep.test.ts:50`) is **already not universally true**. LOW.

### Verdict on my plan (consensus)
- **Direction right** (remove first-wins) but my dedup-by-type is too coarse (misses K2/K3) and my minimal probe is **type-only → unsound** (misses K2/K3).
- **My per-field `anyOf` reverses ADR 0031** ("zero anyOf at any depth") + breaks `flatten-deep.test.ts:50`. Must be a **deliberate ADR amendment**, not a silent test change.
- **dedup-by-`toJSONSchema`-string is fragile** — strip `description`/`default`, use `unrepresentable:'any'` (else `z.date()` throws), beware `$ref`/cycles and non-serialized `.refine`/`.regex`.

## Final design (synthesized → for 0.15.0)

1. **Sound producer (`flattenDiscriminatedUnion`).** Per key, collect ALL variant schemas; dedup by **normalized** JSON Schema (description/default stripped, `unrepresentable:'any'`):
   - 1 distinct → keep, `optional` + hint (no `anyOf`).
   - enum/literal collision → **merge into one widened `enum`** (no `anyOf`).
   - ≥2 structurally distinct → `z.union(distinct).optional()` + describe (**minimal local `anyOf`**, only here).
   - **strip per-variant `.default()`** on a collided key.
   Discriminator: collect **all** `def.values` (fix D1); accept `z.enum` discriminator (fix D2); non-representable → **policy report, not throw**.
2. **Probe sees the shipped schema (P1).** Thread `flattenUnionInput` (+`extend`) into `validateMcpSchemas` → it vets the **flattened** schema.
3. **Soundness guard (regression backstop).** In `prepareMcpTool`/`validateMcpSchemas` on the flattened schema: assert each variant's field schema is contained in the advertised field's union (structural membership, no value generation) + advertised top is `ZodObject` + no surviving non-string-discriminator. Route failures via `onIncompatibleSchema`. (Construction makes it pass; the guard catches future regressions / novel field kinds.)
4. **params + DU (P2).** When `flattenUnionInput` and input is a (discriminated) union: flatten the union to an object **first**, then merge `params` keys into it → a single `ZodObject` (MCP-mountable, `oneOf`-free).
5. **ADR amendment.** New ADR superseding ADR 0031's absolute "zero `anyOf`" → "zero *unnecessary* `anyOf`; a minimal per-field `anyOf` is allowed where variants are structurally irreconcilable." Update `flatten-deep.test.ts:50` accordingly (not silently).
6. **Deferred / lower-priority (file separately, not 0.15.0 unless cheap):** P3 (`.strict()` — document + describe; superset invariant noted insufficient), P4 (coerce recursion), P5 (deep-walk record/tuple/plain-union). Flag explicitly so they're not assumed covered.

### Not bugs (confirmed safe — don't re-chase)
- optional-in-one/required-in-other same type → advertised optional = looser = safe.
- nullable vs non-nullable same type → `anyOf[T,null]` accepts both = safe.
- `.refine()`-wrapped variant → zod v4 exposes inner ZodObject in `def.options`, no throw; refine dropped from advertised, kept on original = looser = safe.

## Links

- Code: `packages/core/src/tools/flatten.ts` (`flattenDiscriminatedUnion`,
  `flattenUnionsDeep`), `tools/mount.ts` (call-site), `tools/execute.ts`
  (validation), `tools/schema.ts` (`mergeSchemas`), `tools/json-schema.ts`.
- ADR 0031 (deep-flatten — the regression source).
