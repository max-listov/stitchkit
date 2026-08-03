---
title: "Advertised tool schema silently strips unknown keys — `.strict()` never reaches validation"
description: The MCP/agent SDKs parse arguments with the advertised schema and hand the handler the sanitized result, so flatten's object rebuild (and the params+input merge) silently deletes keys before the contract schema ever sees them.
type: task
status: done
created: 2026-08-03
updated: 2026-08-03
completed: 2026-08-03 18:15 +07:00
---

# Advertised schema is an enforcing pre-filter, not "advertised-only"

Reported by a consuming project: a `.strict()` object nested inside a
discriminated-union variant rejects an unknown key when the contract schema is
parsed directly, but the same key is **silently dropped** when the call arrives
over MCP — the handler receives `{}` and the call succeeds. A sibling field in
the same tool (a plain nested object) reports an honest `VALIDATION_ERROR`.

## Mechanism — confirmed by source + probes (not a hypothesis)

1. **The SDK validates with the advertised schema and passes the *parsed* data
   on.** `@modelcontextprotocol/sdk@1.29` `McpServer.validateToolInput()`
   (`dist/esm/server/mcp.js:166-181`) does
   `safeParseAsync(tool.inputSchema, args)` and returns `parseResult.data`;
   `executeToolHandler` invokes our callback with that value. `mountMcp` registers
   `inputSchema: mountable.schema` (`src/tools/mcp.ts:276`), so **the advertised
   schema is also a sanitizing filter**. `mountAgent` has the same shape —
   `zodSchema(mountable.schema)` (`src/tools/agent.ts:64`), and the AI SDK
   likewise hands the handler its parsed output.

   This invalidates the premise written in ADR 0033 and repeated in
   `flatten.ts`'s docstring ("advertised-only; the original union remains the
   validation schema"). It is advertised **and** enforcing, and a bare `z.object`
   enforces by *deleting*.

2. **`flattenUnionsDeep` rebuilds every object it walks as a bare
   `z.object(shape)`** (`src/tools/flatten.ts:224-230`, and again on the object
   returned by `flattenDiscriminatedUnion`). `.strict()` lives in
   `def.catchall` (`ZodNever`) and is not copied over, so every rebuilt object
   becomes strip-on-parse. Same for `.catchall()` / `.passthrough()` and
   object-level checks.

3. **The path-dependence is `mergeCollidingFields`.** A key present in two or
   more variants whose subtree carries any check is widened to `z.unknown()`
   (`flatten.ts:186`) — `z.unknown()` deletes nothing, so the dirt survives to
   `executeToolMethod` and the contract schema reports it honestly. A key present
   in a single variant is kept and then rebuilt → strictness lost → silent strip.
   Probed on the reporter's real schema: `updates` → `ZodUnknown` (honest error),
   `node` → kept, rebuilt (silent strip). The "working" case works by accident.

4. **Sibling bug, independent of flatten:** `mergeSchemas` rebuilds the tool
   schema as `z.object({ ...params.shape, ...input.shape })`
   (`src/tools/schema.ts:48`), so a **top-level** `.strict()` input is dropped for
   every MCP/agent tool — probed: `{ a, dirt }` parses to `{ a }` with
   `flattenUnionInput` both `false` and `true`. `applyExtend`
   (`src/tools/mount.ts:60`) rebuilds the same way.

Net: any object stitchkit rebuilds while deriving the advertised schema loses its
strictness, and the SDK then deletes the offending keys before validation can
object. **Silent data loss** — the worst failure mode for an LLM caller, which
gets a success and never learns its argument was wrong.

## Which shapes lose strictness (probed, `flattenUnionsDeep` on a `.strict()` object)

Everything the walk **recurses into** is rebuilt and loses `.strict()`; everything
it does not recognise is returned untouched and keeps it. That split is the whole
source of the path-dependent behaviour.

| Position of the `.strict()` object | Result |
| --- | --- |
| plain nested field | stripped |
| `.optional()` / `.nullable()` / `.default()` | stripped |
| array item | stripped |
| record value | stripped |
| intersection side | stripped |
| member of a plain (non-discriminated) union | stripped |
| discriminated-union variant | stripped (via the post-flatten rebuild) |
| tuple item | preserved (branch not implemented) |
| behind `z.lazy()` | preserved |
| after `.transform()` (`ZodPipe`) | preserved |
| `.readonly()` | preserved |

Note the "preserved" rows are not a safety net — they are shapes the flattener
silently *skips*, so a nested discriminated union under a tuple/lazy/pipe also
never flattens and still reaches the wire as `oneOf` (a separate ADR-0033 gap
worth a line in the fix).

## Invariant to restore

> The advertised schema must never be able to **remove** data. Every argument the
> caller sent reaches the contract schema, which is the only judge.

## Decision — (a) preserve strictness

Option (b) (loose-deep advertised objects) is rejected: it would advertise
`additionalProperties: true` on every object, which *invites* a model to invent
keys — the opposite of what the reporting consumer wants. (a) keeps the
advertisement instructive and is the smaller change. The residual mixed error
channel (SDK `InvalidParams` for a strict violation vs stitchkit
`VALIDATION_ERROR` for a field the flattener widened to `z.unknown()`) is
accepted: **both channels reject**, which is the invariant that matters.

## Plan

The one rule behind every edit: **an object rebuilt while deriving the advertised
schema must carry the source object's own key policy.** Zod v4 stores it in
`def.catchall` — `ZodNever` for `.strict()`, `ZodUnknown` for `.loose()` /
`.passthrough()`, `undefined` for a plain object (which strips, matching the
contract's own behaviour, so `undefined` needs no special case).

- [x] **1. One shared helper.** `rebuildObject(source, shape)` in `flatten.ts` —
      `z.object(shape)` plus `.catchall(source.def.catchall)` when set. Every
      rebuild site goes through it so no future site can forget.
- [x] **2. `flattenUnionsDeep` — `ZodObject` branch** (`flatten.ts:224-230`) uses
      the helper. This alone fixes the reported bug for the nested-strict case.
- [x] **3. `flattenDiscriminatedUnion`'s flat object** (`flatten.ts:67-75`) — the
      flat object's own policy is merged from the variants, since it stands in
      for all of them:
      - every variant `.strict()` → flat object `.strict()` (rejects a key no
        variant declares — sound, because the flat shape is the union of all
        variant keys);
      - any variant loose / `.passthrough()` → flat object loose (never delete
        what a variant would have kept);
      - otherwise plain (strips, exactly as the contract variants would).
      Per-variant strictness (a key legal in variant A, illegal in B) is
      genuinely unrepresentable in one flat object and stays lossy — the contract
      union still enforces it downstream. Document that in the docstring.
- [x] **4. `mergeSchemas`** (`schema.ts:48`) — the merged object takes the
      **input** schema's `catchall`. Justification, not a guess:
      `executeToolMethod` slices args by `paramsSchema`'s shape keys and routes
      *everything else* into `inputArgs` (`execute.ts:120-128`), so a top-level
      key belonging to neither schema is judged by the input schema. A `params`
      catchall can never fire (its slice is built from its own shape keys) and
      must not be propagated.
- [x] **5. `applyExtend`** (`mount.ts:60`) — same helper; the extend keys are part
      of the advertised shape, so a preserved `.strict()` still admits them, and
      `createToolRunner` strips them before the contract parse.
- [x] **6. Tests** (`packages/core/tests/`) — end-to-end through a real
      `McpServer` ↔ `Client` pair (the `native-tools.test.ts` pattern), not
      schema-level only, because the whole bug lives in the SDK's parse step:
      - `.strict()` object nested in a discriminated-union variant + unknown key
        → the call does **not** succeed with the key silently dropped;
      - the same call with a clean payload still succeeds (no over-rejection);
      - top-level `.strict()` input + unknown top-level key → rejected
        (`mergeSchemas` path, with `flattenUnionInput` both off and on);
      - a `.loose()` / `.passthrough()` object keeps its extra keys through
        flatten (the mirror direction — the fix must not turn "keep" into
        "reject");
      - the matrix of positions from the table above (optional / nullable /
        default / array item / record value / intersection / union member) —
        each rejects rather than strips;
      - the same nested-strict case through `mountAgent`;
      - an extended tool (`ToolExtend`) with a strict base still accepts its
        extend arguments.
- [x] **7. Docs** — ADR 0033 and the `flatten.ts` / `schema.ts` docstrings: drop
      the "advertised-only; validation still enforces them" claim and state that
      the SDK parses with the advertised schema and hands the handler its output,
      so the advertised schema is an enforcing pre-filter. Note what remains
      lossy (per-variant strictness, object-level refinements).
- [x] **8. `CHANGELOG.md`** under `[Unreleased]` with a
      `### ⚠️ Breaking changes` section — a call that was previously accepted
      (dirty key silently dropped) now fails. Version bump / release stays with
      the repo owner.

## Out of scope (noted, not fixed here)

The "preserved" rows in the table above are shapes `flattenUnionsDeep` does not
walk (tuple, `z.lazy()`, `ZodPipe`, `.readonly()`), so a discriminated union
nested under one of them never flattens and still reaches the wire as `oneOf` —
a separate ADR-0033 gap. Not bundled in: it changes what is advertised (this task
only changes key policy), and it wants its own probe of what the hosts do with a
nested `oneOf`. → own inbox task.

## Acceptance

- [x] A dirty key inside a flattened union variant no longer reaches the handler
      as a silent success — the call is rejected, by either channel.
- [x] A `.loose()` / `.passthrough()` object still receives its extra keys.
- [x] No clean call that worked before starts failing (`bun run verify` green,
      including the existing flatten / tools / extend suites).
- [x] The advertised JSON Schema for a strict object carries
      `additionalProperties: false` (the model is told the rule up front).

## Правки валидатора-1 (mechanism / edit-site completeness)

All confirmed against source + live probes (zod 4.4.3, sdk 1.29.0, ai 7.0.2).

1. **WRONG — the flat-object catchall rule mishandles a typed catchall.** A variant
   built with `.catchall(z.string())` is neither strict nor loose, so under the
   plan's wording it fell to "otherwise plain" → the flat object would **strip** a
   key that variant would have kept and validated. Corrected rule (item 3):
   *every* variant `ZodNever` → strict; **any** variant with a catchall that is
   not `ZodNever` → loose (`z.unknown()`); otherwise plain. Never copy a typed
   catchall onto the flat object — it would reject a sibling variant's
   differently-typed extra key.
2. **`normalizeObjectSchema` returns a real `ZodObject` unchanged**
   (`sdk/.../zod-compat.js:105-111`) — it only rebuilds raw shapes. So a catchall
   stitchkit sets genuinely survives into the SDK's parse. The fix reaches the
   wire.
3. **Edit-site sweep is otherwise complete.** Full `z.object(` sweep of
   `packages/core/src`: only `schema.ts:34/48`, `mount.ts:60/64`, `flatten.ts:75/229`
   are advertised-input rebuilds. `coerce.ts`, `cli-args.ts`, `manifest.ts`,
   `toolkit.ts`, `server/openapi.ts` only read `.shape` or convert contract
   schemas directly. `mergeSchemas` / `flattenUnionsDeep` have exactly one caller
   (`collectTools`), through which CLI / manifest / list-names / transports /
   toolkit all pass.
4. **GAP — the two `z.intersection` branches are not rebuilds**, so "one rule for
   every rebuild" does not reach them: `schema.ts:53` (params + non-object input)
   and `mount.ts:64` (extend over a non-object base). Probed: params object +
   strict-variant DU → the advertised intersection **accepts and drops** a dirty
   key. MCP is protected (`mcp.ts:149-157` rejects a non-object merged schema) but
   **the agent transport and CLI are not**. → moved to Out of scope with its own
   task; item 5's claim is qualified to the object path.
5. **Helper placement** — put it in `schema.ts`, not `flatten.ts`: `schema.ts`
   imports only zod today, and `flatten.ts` can import `schema.ts` without a
   cycle. Keep it **internal** (not exported from `src/tools.ts`) or
   `reference-coverage.test.ts` demands a docs row.
6. **The agent transport is verifiable, and it behaves identically** —
   `zodSchema` → `zod4Schema.validate` returns `result.data`
   (`@ai-sdk/provider-utils:2268-2271`), `doParseToolCall` sets
   `input: parseResult.value` (`ai:3899-3910`). **But** `ai` forces
   `additionalProperties: false` onto every object in the advertised JSON Schema
   regardless of catchall (`provider-utils:972-981`) → acceptance #4 is meaningful
   for MCP only, and the loose-object test must assert on **handler-received
   data**, not on the advertised schema.
7. **Doc sites are more numerous than item 7 listed** — also
   `docs/guide/mcp-and-agents.md:153`, `docs/decisions/0031-deep-union-flatten.md:62`,
   `mount.ts:97-101`, `schema.ts:19-23`; ADR 0033 needs edits in two places
   (`:63-66` and `:82-86`). Per `AGENTS.md` this reverses an **Accepted** ADR
   decision → wants a **new superseding ADR + a row in `docs/decisions/README.md`**,
   not an in-place rewrite.
8. Mechanism §3 named only one of the two widening paths — `flatten.ts:186`
   (single shape + `hasChecks`); the other is `flatten.ts:204` (differing shapes).
   Both produce the "honest error" behaviour.

## Правки валидатора-2 (regression risk / blast radius)

1. **The existing suite gives ZERO regression signal.** `grep strictObject` over
   `packages/core/tests` hits only tests that bypass the advertised schema
   (`parity.test.ts:20`, `execute.test.ts:193`, `cli.test.ts:54`,
   `openapi.test.ts:33`). Nothing in the corpus routes a strict/catchall schema
   through `collectTools` → SDK. So "verify stays green" proves nothing — **all**
   the signal lives in the new tests.
2. **Mechanism §4 overstates the bug** — `mergeSchemas` already preserves
   strictness for a **params-only** tool (`schema.ts:34` returns the object
   unmodified). The top-level loss only happens when an `inputSchema` exists.
   Corrected below; the CHANGELOG before→after must match.
3. **RISK — an unrepresentable catchall can break a build that works today.**
   `.catchall(z.date())` is currently discarded by the rebuild so
   `probeSchema(…, 'input')` passes; preserved verbatim it throws → with the
   default `onIncompatibleSchema: 'throw'` the whole `mountMcp` fails. Guard it:
   a catchall that cannot be represented in JSON Schema degrades to
   **`z.unknown()`** (loose) — keeps the "never delete" invariant, stays
   representable, never fails a mount.
4. **RISK — observability hole.** Today a stripped key still reaches
   `executeToolMethod`, so `beforeToolCall` / `afterToolCall` fire and the caller
   gets the `{error, details, _hint}` envelope. After the fix the SDK rejects
   first: **no hook, no audit event, no `_hint`, no `VALIDATION_ERROR` code** —
   these calls go from "logged as success" to "not logged at all". Must be in the
   breaking note, and the tests must assert what the caller actually receives.
5. **RISK — filtered extends reject cross-tool.** With an `extend.filter` the
   extra key is advertised on some tools and not others; a model that learned
   `tenantId` from tool A and sends it to a strict, non-extended tool B was
   silently sanitized before and now gets a hard rejection. The most plausible
   "worked yesterday" regression → explicit line in the migration note.
6. **SAFE — `.loose()` / `.passthrough()` is not a new junk channel.** Probed: zod
   v4 drops `__proto__` when applying a catchall, nested included. But
   `executeToolMethod`'s `isUnsafeKey` guard is top-level only
   (`execute.ts:123-128`), so that safety is now load-bearing → pin it with a test.
7. **SAFE — nothing else injects arguments** (SDK passes `arguments` verbatim;
   `_meta` / task / elicitation live outside it), and `applyExtend`'s object path
   with a preserved strict admits the extend keys (probed).
8. **SAFE — blast radius mapped.** Changed advertised output: `mountMcp`,
   `mountAgent`, `validateMcpSchemas`, `buildToolManifest`, and the public
   `flattenUnionsDeep` / `flattenDiscriminatedUnion`. Unchanged: `listToolNames`,
   `transports`, `createCli` (blind to `additionalProperties`), **OpenAPI**
   (converts contract schemas directly, never the merged one). No repo test
   asserts the changed part; a consuming project's manifest snapshot would diff.
9. **The invariant is over-claimed** — "the contract schema is the only judge" stays
   false in two routing cases that match HTTP behaviour and are deliberately kept:
   strict params + plain input, and a params-only method (nothing parses
   `inputArgs` at all, `execute.ts:149-160`). Restated below.

## Corrections folded into the plan

- **Item 3's rule** → all-`ZodNever` → strict; **any** non-`ZodNever` catchall →
  loose; else plain. Same wording in the helper's contract.
- **New sub-item under 1** → an unrepresentable catchall degrades to `z.unknown()`.
- **Item 4** → note that params-only already preserves (`schema.ts:34`), and that
  a params-only method never parses `inputArgs` (pre-existing, out of scope).
- **Item 5** → qualified to `applyExtend`'s object path.
- **Item 6** → add: `__proto__` inside a loose object is dropped; assert
  handler-received data for the loose case (the agent path advertises
  `additionalProperties:false` regardless); assert what the caller receives on
  each transport (hook/envelope shape).
- **Item 7** → the extra doc sites, and a **new superseding ADR 0034** + a row in
  `docs/decisions/README.md` instead of rewriting 0033 in place.
- **Item 8** → the breaking note must also carry the observability hole and the
  filtered-extend cross-tool rejection.
- **Invariant** → "the advertised schema never removes what the contract would
  have kept" (not "the contract is the only judge").

## Process (конвейер 2/2, без остановки)

- [x] Task in `in-progress/`
- [x] 2 plan validators against the real source (different lenses), findings
      folded in as "Правки валидатора-N"
- [x] Implementation strictly per the refined plan
- [x] Gates: `bun run verify` green
- [x] 2 implementation validators (different lenses), findings fixed, gates re-run
- [x] "Что сделано" section + move to `done/` (Max validates the result and owns
      the release — no commit / tag / publish from this pass)

## Правки валидатора реализации-1 (mandate line-by-line)

Gate independently re-run by the validator: green. Findings, all folded in:

1. **MISSING → fixed.** `docs/api/reference.md` still described `flattenUnionsDeep`
   as "advertised schema only" — and `scripts/gen-llms.ts` feeds that file into the
   `llms.txt` / `llms-full.txt` **shipped inside the npm package**, so the false
   claim would have reached the agent of every consuming project. Rewritten.
2. **NIT → fixed.** ADR 0031's load-bearing claim (*Decision → Properties kept*,
   "Advertised-only and lossy … a mis-flatten degrades a hint, never validation")
   was left unannotated; only the weaker *Alternatives* bullet had the ⚠️ note.
   Both now carry it.
3. **NIT → fixed.** Two ADR 0034 sentences were not literally true: the flat
   object goes through `withKeyPolicy` + a merged policy, not `rebuildObject`
   (it has no single source); and a strict violation does **not** throw — `callTool`
   resolves with an `isError: true` result carrying `MCP error -32602`. Verified by
   my own probe and reworded in both the ADR and the CHANGELOG.
4. **Test gaps → closed** (see validator-2 items): the missing `intersection` row
   is now explained in place, `mountAgent` is exercised through the real mount, and
   the hook-silence consequence is pinned by a test instead of only promised in prose.
5. Confirmed correct under probe: the `mergeVariantKeyPolicies` matrix (before
   validator-2's finding), `mergeSchemas` taking the input policy, the
   `representable()` degradation both directions, zero `as` casts, no shims,
   reference-coverage satisfied because the helper stays internal.

## Правки валидатора реализации-2 (adversarial)

Fuzzed ~4 000 generated schemas and 20 420 contract-valid payloads. **No
over-rejection anywhere** (the worst possible regression — none found), no new
mount-time failure, and the exotic-catchall battery is byte-identical pre/post.
Two real defects, both reproduced by hand before fixing:

1. **CONFIRMED-BUG → fixed. The reported defect still fired one ordinary variant
   away.** `mergeVariantKeyPolicies` returned *plain* unless **every** variant was
   strict, and plain deletes. So a `.strict()` variant beside a plain sibling was
   back to silent deletion:
   ```ts
   const MIXED = z.discriminatedUnion('kind', [
     z.object({ kind: z.literal('a'), a: z.string() }).strict(),
     z.object({ kind: z.literal('b'), b: z.string() }),          // one plain sibling
   ]);
   // contract:   {kind:'a', a:'x', payment_paid:'DIRT'} → rejected
   // advertised: → accepted, key deleted   ← the whole bug, back
   ```
   The rule is now: all strict → strict; **no** variant strict → plain; **mixed →
   loose**, because plain destroys the evidence the union needs. Verified through a
   real MCP round trip. The validator's fuzz confirmed this was the *only*
   remaining silent-strip class.
2. **CONFIRMED-BUG (pre-existing) → fixed in the same pass.** A sibling variant's
   `.default()` was injected into every payload: `flattenDiscriminatedUnion`
   unwrapped `ZodOptional` but not `ZodDefault`, so a legal variant-`a` call came
   back carrying variant `b`'s defaulted field and the real union rejected it as an
   unrecognized key. Included because it breaks precisely the all-`.strict()` union
   this ADR now recommends. Fixed via a shared `unwrapField`.
3. **WEAK-TEST ×4 → rewritten.** The validator restored the pre-fix sources and
   found 5 of 23 tests passed **without** the fix. Rewritten or replaced: the
   `[strictA, plainB]` case tested the safe variant and blessed defect 1; the
   discriminated-union matrix row rejected on the *discriminator*, not on key
   policy; the params-only row is kept but now honestly labelled a
   no-rebuild lock. Two remaining pre-fix passers are deliberate controls
   (no-over-rejection, `__proto__`).
4. **NO-BUG, recorded:** `coerceJsonArgs` was already unreachable on both LLM
   transports (both SDKs parse before the callback) — only `createCli` benefits;
   the fix does not make it worse. `constructor` / `prototype` flow through a
   `.loose()` object as inert own keys, matching `internal/safe-json.ts` and the
   HTTP path.

## Что сделано

**Source (+52 lines of logic, three files)**

- [x] `tools/schema.ts` — new internal `rebuildObject` / `withKeyPolicy` /
      `keyPolicyOf` / `representable`; `mergeSchemas` now rebuilds with the **input**
      schema's policy. Not exported from `src/tools.ts` — internal by design.
- [x] `tools/flatten.ts` — the `ZodObject` branch rebuilds through `rebuildObject`;
      `flattenDiscriminatedUnion` applies a merged policy via
      `mergeVariantKeyPolicies` (all strict → strict · none strict → plain · mixed
      or any keeper → loose); new `unwrapField` unwraps `.optional()` **and**
      `.default()` so a sibling variant's default is never injected.
- [x] `tools/mount.ts` — `applyExtend`'s object path rebuilds through the helper
      (the non-object path still intersects; documented, out of scope).
- [x] `tools/coerce.ts` — docstring corrected (it never rebuilds a schema).

**Tests — `packages/core/tests/advertised-key-policy.test.ts` (new, 27 tests)**

- [x] MCP round trip through a real `McpServer` ↔ `Client`: nested strict in a
      union variant rejects; the clean payload still succeeds; top-level strict
      rejects with flatten off *and* on; a loose object still delivers extras to
      the handler; a mixed strict/plain union forwards the dirty key; a strict
      violation fires **no** tool-call hook (the documented audit hole) while a
      clean call fires both.
- [x] Position matrix — plain / optional / nullable / default / array item /
      record value / union member / DU variant all reject rather than strip;
      `intersection` deliberately absent, with the reason in place.
- [x] Variant-policy matrix — all-strict, none-strict, mixed, loose, typed
      catchall, plus the sibling-`.default()` non-injection case.
- [x] Mount surfaces — `mountAgent` through the AI SDK's own `asSchema().validate`;
      `ToolExtend` over a strict base still admits its injected arguments;
      params-only policy preserved; an unrepresentable catchall degrades instead of
      failing the mount; a strict object advertises `additionalProperties: false`.

**Docs**

- [x] New superseding **ADR 0034** + row in `docs/decisions/README.md`; ⚠️
      annotations on ADR 0031 (two sites) and ADR 0033 (two sites).
- [x] `docs/guide/mcp-and-agents.md`, `docs/api/reference.md` (ships into
      `llms.txt`), and the `flatten.ts` / `schema.ts` / `mount.ts` / `coerce.ts`
      docstrings corrected.
- [x] `CHANGELOG.md` — `### ⚠️ Breaking changes` with before → after and the four
      upgrade checks, plus a `### Fixed` entry for the default-injection bug.

**Not done, deliberately**

- [x] `z.intersection` (params + union-input; extend over a non-object base) still
      strips — Zod drops both sides' policy natively, verified on raw zod, so no
      catchall copy can fix it. → `docs/backlog/inbox/2026-08-03-intersection-and-unwalked-shapes.md`
- [x] Shapes the flatten walk skips (tuple / lazy / pipe / readonly) still ship a
      nested `oneOf` → same inbox task.
- [x] Version bump / commit / tag / npm publish — the repo owner's call; the
      working tree carries the change unreleased.

**Gate:** `bun run verify` exit 0 — biome clean, tsc clean, **602 pass / 0 fail**
(was 575 before this task), build + Node smoke green.
