---
title: Typed divergent collisions in flattened tool schemas
description: Preserve every known base type when a flattened discriminated union reuses one property with divergent shapes.
type: task
status: done
created: 2026-08-08
updated: 2026-08-08
completed: 2026-08-08 08:18 +00:00
---

## Problem

`flattenUnionInput: true` projects every structurally identifiable discriminated object union
into one conservative object so weaker models do not receive nested `oneOf` / `anyOf`. When the
same property has genuinely different kinds between variants, `mergePropertySchemas()` currently
falls back to `{}`. Runtime validation remains correct, but MCP and AGENT presentation lose type
information and `findUntypedProperties()` correctly reports the field as debt.

Confirmed generic examples include:

```ts
z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('one'), value: z.string() }),
  z.object({ kind: z.literal('many'), value: z.array(z.string()) }),
]);
```

and a property that is a scalar in some variants and an object union in others:

```ts
z.discriminatedUnion('type', [
  z.object({ type: z.literal('link'), target: z.string() }),
  z.object({
    type: z.literal('select'),
    target: z.union([
      z.object({ names: z.array(z.string()) }),
      z.object({ pattern: z.string() }),
    ]),
  }),
]);
```

## Decision boundary

Do not restore branch-level `oneOf` / `anyOf` inside a discriminated union processed by
`flattenUnionInput: true`. Deep removal of those keywords is the purpose of the opt-in flat mode
and is covered by ADRs 0031, 0033 and 0050. Consumers that need exact discriminator-to-branch
relationships already have the lossless default: `flattenUnionInput: false`.

The flat projection should instead publish the sound union of every JSON-visible base kind, for
example `type: ['string', 'array']` or `type: ['string', 'object']`. This remains a conservative
superset, tells the model which value kinds are legal, keeps the flat-mode compatibility contract
and leaves the original Zod schema as the only executable parser.

## Plan

- [x] Extend the property projection in `packages/core/src/tools/flatten-join.ts` to collect base
  kinds from `type`, `const`, `enum` and nested `oneOf` / `anyOf` branches.
- [x] Emit one scalar `type` when all branches share a base kind and a deterministic JSON Schema
  type array when branches genuinely diverge.
- [x] Keep only constraints that are sound for every projected branch; never attach object, array
  or scalar keywords to incompatible sibling kinds.
- [x] Preserve nullability and numeric `integer` / `number` widening without narrowing any branch.
- [x] Keep discriminator enums and existing `Required if …` / `Available if …` guidance.
- [x] Leave unresolved references and genuinely unknowable schemas untyped rather than guessing.
- [x] Verify the same immutable presentation document reaches MCP, AGENT, manifests and schema
  validation through the existing shared preparation pipeline.
- [x] Add a new ADR that extends ADR 0044, and update the guide, API reference and changelog.

## Regression coverage

- [x] Object ↔ array collision publishes both base kinds and no untyped property.
- [x] String ↔ nested object-union collision publishes `string` and `object` and no untyped
  property.
- [x] Same-kind nested object unions project to `type: 'object'` without inventing a branch shape.
- [x] Nullable divergent fields retain `null` alongside every non-null base kind.
- [x] Numeric `integer` ↔ `number` remains `number`, not a two-entry type array.
- [x] Hidden or unresolved shapes remain visible to `findUntypedProperties()`.
- [x] MCP and AGENT presentation schemas are byte-equivalent for the same definition.
- [x] `flattenUnionInput: false` preserves the original exact `oneOf` / `anyOf` document.
- [x] Original Zod validation, transforms, hooks and error normalization are unchanged.

## Acceptance

- [x] Known divergent fields never degrade to `{}` when every branch exposes a JSON Schema base
  kind.
- [x] `findUntypedProperties()` returns no finding for the two generic fixtures above.
- [x] Flat mode still contains no `oneOf` / `anyOf` for a flattenable discriminated union.
- [x] The projected schema is a sound superset of every original branch.
- [x] No domain exceptions, `allowUntyped` entries, compatibility wrappers or runtime parser
  changes are introduced.
- [x] `bun run verify` is green.

## Что сделано

- [x] **Core:** `packages/core/src/tools/flatten-join.ts` выводит конечные базовые типы из
  `type`, `const`, `enum`, `oneOf` и `anyOf`, нормализует числовые типы и публикует
  детерминированный sound type union без несовместимых sibling-keywords.
- [x] **Regression tests:** `packages/core/tests/flatten-collision.test.ts` покрывает
  object/array, scalar/nested union, same-kind object unions, nullable, const/enum и
  unresolved-reference cases.
- [x] **Surface parity:** `packages/core/tests/flatten-deep.test.ts` подтверждает один документ
  для MCP, AGENT и manifest, отсутствие union-keywords в flat mode и сохранность исходной схемы.
- [x] **Strict validation:** `packages/core/tests/untyped-properties.test.ts` подтверждает, что
  известные divergent kinds проходят `requireTypedProperties`, а неизвестные остаются finding.
- [x] **Existing contract:** `packages/core/tests/collided-field-keeps-type.test.ts` обновлён на
  новый deterministic multi-type invariant и проверяет независимость от порядка вариантов.
- [x] **Architecture and public docs:** добавлен ADR 0065, обновлены ADR index, MCP/Agent guide,
  API reference, changelog и сгенерированные consumer docs.
- [x] **Что НЕ делалось:** runtime Zod parser, lifecycle, hooks, error normalization и exact
  `flattenUnionInput: false` representation не менялись; доменных исключений и allowlists нет.
- [x] **Гейты:** `bun run verify` прошёл полностью — lint, typecheck, 938 core tests, build,
  Node smoke, packed consumer lane и starter lane с 27 browser E2E.
