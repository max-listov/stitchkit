---
title: "Two gaps the key-policy fix could not close: z.intersection strips, and unwalked shapes keep their oneOf"
description: Zod drops both sides' catchall when intersecting objects, so a params + union-input tool still strips on the agent surface; and the shapes flattenUnionsDeep does not walk (tuple, lazy, pipe, readonly) never flatten, so a union nested there still reaches the wire as oneOf.
type: task
status: icebox
created: 2026-08-03
updated: 2026-08-03
related: docs/decisions/0034-advertised-schema-key-policy.md
defrost: a consumer actually hits it — a `params` + union-`input` tool on the agent surface (MCP rejects those at mount), or a discriminated union nested under a tuple / `z.lazy` / `.transform()`. Both need a different instrument than the ADR 0034 catchall copy, and neither has a reported case.
---

# Two residual gaps after ADR 0034

Both were found while fixing the advertised-schema key policy and deliberately
left out of that pass — each needs a different instrument than a catchall copy.

## 1. `z.intersection` strips, and nothing can copy a policy onto it

Zod v4 drops **both** sides' `catchall` when it intersects two objects. Verified
with no stitchkit involved:

```ts
const S = z.object({ ok: z.string() }).strict();
S.safeParse({ ok: 'x', dirt: 1 }).success                       // false
z.intersection(S, z.object({})).safeParse({ ok: 'x', dirt: 1 }) // { success: true, data: { ok: 'x' } }
```

So the two intersection branches still silently delete keys:

- `mergeSchemas` — `params` + a **non-object** `input` (a union, a refined/piped
  schema): `schema.ts` returns `z.intersection(paramsObject, inputSchema)`.
- `applyExtend` — a `ToolExtend` over a non-object base: `mount.ts` returns
  `z.intersection(z.object(extra), base)`.

**MCP is protected** — `prepareMcpTool` rejects a non-object merged schema at
mount, so such a tool never registers. **The agent surface and the CLI are not**:
`mountAgent` happily advertises the intersection, and the AI SDK parses with it.

Directions worth probing before choosing:
- flatten the union first so the merge takes the object path (already true when
  `flattenUnionInput` is on — measure whether the gap is only reachable with the
  flag **off**, which would shrink this to a documentation note);
- build the merged schema as one object with a merged policy instead of an
  intersection, when the input is a flattenable union;
- or reject a non-object merged schema on the agent surface too, matching MCP.

## 2. Unwalked shapes never flatten — a nested union still ships `oneOf`

`flattenUnionsDeep` recurses into object / array / record / union / intersection
and the `optional` / `nullable` / `default` wrappers. Everything else is returned
untouched: **tuple items, `z.lazy()`, `ZodPipe` (a `.transform()` output),
`.readonly()`**. A discriminated union nested under one of those therefore never
flattens and reaches the wire as `oneOf` — exactly what `flattenUnionInput`
exists to prevent (→ ADR 0031 / 0033, listed there as a known residual).

This surfaced from the other side while auditing the key-policy bug: those same
shapes were the ones that *kept* their `.strict()`, because the walk skips them.

Before implementing, probe what the hosts actually do with a nested `oneOf` — the
whole feature exists because weak models mishandled it, and that evidence is from
ADR 0031's era. If current hosts cope, documenting the limit beats widening the
walk.
